import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { WechatControlError } from "./wechat-version-policy.mjs";

const collectPowerShell = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$items = @()
Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.ExecutablePath) { $items += [pscustomobject]@{ path=$_.ExecutablePath; source='process'; confidence=30 } }
}
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '微信|Weixin|WeChat' } | ForEach-Object {
  $root = [string]$_.InstallLocation
  if ($root) { $items += [pscustomobject]@{ path=(Join-Path $root 'Weixin.exe'); source='registry'; confidence=20 } }
}
$items | ConvertTo-Json -Compress
`;

const metadataScript = String.raw`
& {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $item = Get-Item -LiteralPath $args[0]
  [pscustomobject]@{
    version = [string]$item.VersionInfo.FileVersion
    productName = [string]$item.VersionInfo.ProductName
  } | ConvertTo-Json -Compress
}
`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `PowerShell exited ${code}`)));
  });
}

export async function collectDefaultCandidates({ env = process.env, runPowerShell = run } = {}) {
  const stdout = await runPowerShell("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", collectPowerShell]);
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const root of [env.ProgramW6432, env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) {
    candidates.push({ path: path.win32.join(root, "Tencent", "Weixin", "Weixin.exe"), source: "fallback", confidence: 10 });
  }
  return candidates;
}

export async function readDefaultMetadata(executable, runPowerShell = run) {
  const quotedExecutable = `"${String(executable).replace(/[`"$]/g, "`$&")}"`;
  const stdout = await runPowerShell("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", metadataScript.trim(), quotedExecutable]);
  return JSON.parse(stdout);
}

export function createWechatDiscovery({
  platform = process.platform,
  explicitExecutable = process.env.DSH_WECHAT_EXECUTABLE || "",
  collectCandidates = collectDefaultCandidates,
  realpath = fs.realpath,
  readMetadata = readDefaultMetadata,
} = {}) {
  async function discover() {
    if (platform !== "win32") throw new WechatControlError("WECHAT_UNSUPPORTED", "微信个人号通道仅支持 Windows");
    const raw = await collectCandidates();
    if (explicitExecutable) raw.unshift({ path: explicitExecutable, source: "explicit", confidence: 40 });
    const valid = [];
    for (const item of raw) {
      try {
        const executable = await realpath(item.path);
        if (path.win32.basename(executable).toLowerCase() !== "weixin.exe") continue;
        const info = await readMetadata(executable);
        if (!info || !String(info.version).startsWith("4.") || !/微信|weixin/i.test(info.productName || "")) continue;
        valid.push({ ...item, executable, version: info.version, productName: info.productName, installRoot: path.win32.dirname(executable) });
      } catch {}
    }
    if (!valid.length) return null;
    const top = Math.max(...valid.map((item) => item.confidence));
    const winners = valid.filter((item) => item.confidence === top);
    const paths = new Set(winners.map((item) => item.executable.toLowerCase()));
    if (paths.size > 1) throw new WechatControlError("WECHAT_DISCOVERY_AMBIGUOUS", "检测到多个微信 4.x 安装，请配置 DSH_WECHAT_EXECUTABLE", { candidates: winners });
    return winners[0];
  }
  return { discover };
}
