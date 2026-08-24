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
const defaultPerHopTimeoutMs = 30_000;
const defaultOverallTimeoutMs = 10 * 60_000;
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

function installerDownloadFailed(details = {}) {
  return new WechatControlError("INSTALLER_DOWNLOAD_FAILED", "微信安装包下载失败", details);
}

function normalizeDownloadError(error) {
  return error instanceof WechatControlError ? error : installerDownloadFailed();
}

async function raceWithTimeout(operation, {
  timeoutMs,
  timeoutError,
  controller,
  parentSignal,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  let timer;
  let onParentAbort;
  const deadline = new Promise((resolve, reject) => {
    const rejectAndAbort = (error) => {
      reject(error);
      if (!controller.signal.aborted) controller.abort(error);
    };
    timer = setTimeoutFn(() => rejectAndAbort(timeoutError()), timeoutMs);
    if (parentSignal) {
      onParentAbort = () => {
        const error = parentSignal.reason instanceof WechatControlError
          ? parentSignal.reason
          : installerDownloadFailed({ stage: "timeout", scope: "overall" });
        rejectAndAbort(error);
      };
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    if (timer !== undefined) clearTimeoutFn(timer);
    if (onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

async function discardResponseBody(body) {
  if (!body || typeof body.cancel !== "function") return;
  try {
    await body.cancel();
  } catch {}
}

async function streamAllowedDownload(
  url,
  file,
  expectedSize,
  isAllowedUrl,
  fetchImpl,
  onProgress,
  {
    signal,
    perHopTimeoutMs,
    setTimeoutFn,
    clearTimeoutFn,
  },
) {
  const partialFile = `${file}.partial`;
  let redirects = 0;
  try {
    let currentUrl = new URL(url);
    while (true) {
      if (signal.aborted) throw signal.reason;
      if (!isAllowedUrl(currentUrl)) {
        throw new WechatControlError("INSTALLER_URL_NOT_ALLOWED", "微信安装包下载地址不受信任");
      }
      const hopController = new AbortController();
      const response = await raceWithTimeout(
        () => fetchImpl(currentUrl, { redirect: "manual", signal: hopController.signal }),
        {
          timeoutMs: perHopTimeoutMs,
          timeoutError: () => installerDownloadFailed({ stage: "timeout", scope: "hop" }),
          controller: hopController,
          parentSignal: signal,
          setTimeoutFn,
          clearTimeoutFn,
        },
      );
      if (redirectStatuses.has(response.status)) {
        let redirectError;
        let nextUrl;
        try {
          if (redirects >= maxRedirects) {
            throw new WechatControlError("INSTALLER_REDIRECT_LIMIT", "微信安装包下载重定向次数过多");
          }
          const location = response.headers?.get("location");
          if (!location) {
            throw installerDownloadFailed();
          }
          nextUrl = new URL(location, currentUrl);
        } catch (error) {
          redirectError = normalizeDownloadError(error);
        }
        await discardResponseBody(response.body);
        if (redirectError) throw redirectError;
        currentUrl = nextUrl;
        redirects += 1;
        continue;
      }
      if (!response.ok) {
        const error = installerDownloadFailed({ status: response.status });
        await discardResponseBody(response.body);
        throw error;
      }
      const contentLength = response.headers?.get("content-length");
      if (contentLength !== null && contentLength !== undefined) {
        if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
          const error = installerDownloadFailed();
          await discardResponseBody(response.body);
          throw error;
        }
        const declaredSize = Number(contentLength);
        if (!Number.isSafeInteger(declaredSize)) {
          const error = installerDownloadFailed();
          await discardResponseBody(response.body);
          throw error;
        }
        if (declaredSize !== expectedSize) {
          const error = new WechatControlError("INSTALLER_SIZE_MISMATCH", "微信安装包大小校验失败");
          await discardResponseBody(response.body);
          throw error;
        }
      }
      if (!response.body) {
        throw installerDownloadFailed({ status: response.status });
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
        { signal },
      );
      if (received !== expectedSize) {
        throw new WechatControlError("INSTALLER_SIZE_MISMATCH", "微信安装包大小校验失败");
      }
      await fs.rename(partialFile, file);
      return;
    }
  } catch (error) {
    await fs.rm(partialFile, { force: true });
    throw normalizeDownloadError(error);
  }
}

export function createArtifactManager({
  fetchImpl = fetch,
  tempRoot = os.tmpdir(),
  readSignature = readAuthenticodeSignature,
  removeImpl = fs.rm,
  perHopTimeoutMs = defaultPerHopTimeoutMs,
  overallTimeoutMs = defaultOverallTimeoutMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const allocatedDirectories = new Map();
  const isAllowedUrl = (url) => url.protocol === "https:" && allowedHosts.has(url.hostname.toLowerCase());

  async function cleanup(directory) {
    const record = allocatedDirectories.get(directory);
    if (!record) {
      throw new WechatControlError("INSTALLER_CLEANUP_NOT_ALLOWED", "拒绝清理非安装包临时目录");
    }
    if (record.cleaned) return;
    await removeImpl(directory, { recursive: true, force: true });
    record.cleaned = true;
  }

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
    let directory;
    const overallController = new AbortController();
    try {
      return await raceWithTimeout(async () => {
        directory = await fs.mkdtemp(path.join(tempRoot, "dsh-wechat-installer-"));
        allocatedDirectories.set(directory, { cleaned: false });
        const file = path.join(directory, "weixin_4.1.10.27.exe");
        await streamAllowedDownload(
          policy.url,
          file,
          policy.size,
          isAllowedUrl,
          fetchImpl,
          onProgress,
          {
            signal: overallController.signal,
            perHopTimeoutMs,
            setTimeoutFn,
            clearTimeoutFn,
          },
        );
        await verifyFile(file, policy);
        return { directory, file };
      }, {
        timeoutMs: overallTimeoutMs,
        timeoutError: () => installerDownloadFailed({ stage: "timeout", scope: "overall" }),
        controller: overallController,
        setTimeoutFn,
        clearTimeoutFn,
      });
    } catch (cause) {
      const error = normalizeDownloadError(cause);
      if (directory) {
        try {
          await cleanup(directory);
        } catch (cleanupError) {
          const code = typeof cleanupError?.code === "string" && /^[A-Z0-9_]+$/.test(cleanupError.code)
            ? cleanupError.code
            : "UNKNOWN";
          error.details = { ...(error.details || {}), cleanup: { code } };
        }
      }
      throw error;
    }
  }

  return { download, verifyFile, isAllowedUrl, cleanup };
}
