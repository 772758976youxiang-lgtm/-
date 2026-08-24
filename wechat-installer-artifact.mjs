import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createProcessRunner } from "./wechat-windows-discovery.mjs";
import { TARGET_WECHAT, WechatControlError } from "./wechat-version-policy.mjs";

const allowedHosts = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 5;
const runPowerShell = createProcessRunner();

const signatureScript = String.raw`
& {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $ErrorActionPreference = 'Stop'
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  $path = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($args[0]))
  $signature = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
  [pscustomobject]@{
    Status = [string]$signature.Status
    Subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
  } | ConvertTo-Json -Compress
}
`;

function parseSignerOrganization(subject) {
  const match = /(?:^|,\s*)O=(?:"((?:[^"]|"")*)"|((?:\\.|[^,])*))/i.exec(String(subject || ""));
  const organization = match?.[1] ?? match?.[2] ?? "";
  return organization.replace(/""/g, '"').replace(/\\,/g, ",").trim();
}

export async function readAuthenticodeSignature(file, {
  runPowerShell: run = runPowerShell,
  timeoutMs = 15_000,
  maxOutputBytes = 64 * 1024,
} = {}) {
  const encodedFile = Buffer.from(file, "utf16le").toString("base64");
  const stdout = await run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", signatureScript.trim(), encodedFile],
    { timeoutMs, maxOutputBytes },
  );
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new WechatControlError("INSTALLER_SIGNATURE_INVALID", "微信安装包数字签名无效");
  }
  return {
    status: String(result?.Status || ""),
    signerOrganization: parseSignerOrganization(result?.Subject),
  };
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function streamAllowedDownload(url, file, expectedSize, isAllowedUrl, fetchImpl, onProgress) {
  const partialFile = `${file}.partial`;
  let currentUrl = new URL(url);
  let redirects = 0;
  try {
    while (true) {
      if (!isAllowedUrl(currentUrl)) {
        throw new WechatControlError("INSTALLER_URL_NOT_ALLOWED", "微信安装包下载地址不受信任");
      }
      const response = await fetchImpl(currentUrl, { redirect: "manual" });
      if (redirectStatuses.has(response.status)) {
        if (redirects >= maxRedirects) {
          throw new WechatControlError("INSTALLER_REDIRECT_LIMIT", "微信安装包下载重定向次数过多");
        }
        const location = response.headers?.get("location");
        if (!location) {
          throw new WechatControlError("INSTALLER_DOWNLOAD_FAILED", "微信安装包下载重定向无效");
        }
        currentUrl = new URL(location, currentUrl);
        redirects += 1;
        continue;
      }
      if (!response.ok || !response.body) {
        throw new WechatControlError("INSTALLER_DOWNLOAD_FAILED", "微信安装包下载失败", { status: response.status });
      }

      let received = 0;
      const sizeGuard = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (received > expectedSize) {
            callback(new WechatControlError("INSTALLER_SIZE_MISMATCH", "微信安装包大小校验失败"));
            return;
          }
          try {
            onProgress(received, expectedSize);
            callback(null, chunk);
          } catch (error) {
            callback(error);
          }
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        sizeGuard,
        createWriteStream(partialFile, { flags: "wx" }),
      );
      if (received !== expectedSize) {
        throw new WechatControlError("INSTALLER_SIZE_MISMATCH", "微信安装包大小校验失败");
      }
      await fs.rename(partialFile, file);
      return;
    }
  } catch (error) {
    await fs.rm(partialFile, { force: true });
    throw error;
  }
}

export function createArtifactManager({
  fetchImpl = fetch,
  tempRoot = os.tmpdir(),
  readSignature = readAuthenticodeSignature,
} = {}) {
  const isAllowedUrl = (url) => url.protocol === "https:" && allowedHosts.has(url.hostname.toLowerCase());

  async function verifyFile(file, policy = TARGET_WECHAT) {
    const stat = await fs.stat(file);
    if (stat.size !== policy.size) {
      throw new WechatControlError("INSTALLER_SIZE_MISMATCH", "微信安装包大小校验失败");
    }
    const digest = await hashFile(file);
    if (digest !== policy.sha256.toLowerCase()) {
      throw new WechatControlError("INSTALLER_HASH_MISMATCH", "微信安装包完整性校验失败");
    }
    const signature = await readSignature(file);
    if (signature.status !== "Valid" || signature.signerOrganization !== policy.signerOrganization) {
      throw new WechatControlError("INSTALLER_SIGNATURE_INVALID", "微信安装包数字签名无效");
    }
    return { file, size: stat.size, sha256: digest, signature };
  }

  async function download(policy = TARGET_WECHAT, onProgress = () => {}) {
    const directory = await fs.mkdtemp(path.join(tempRoot, "dsh-wechat-installer-"));
    const file = path.join(directory, "weixin_4.1.10.27.exe");
    try {
      await streamAllowedDownload(policy.url, file, policy.size, isAllowedUrl, fetchImpl, onProgress);
      await verifyFile(file, policy);
      return { directory, file };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  return { download, verifyFile, isAllowedUrl };
}
