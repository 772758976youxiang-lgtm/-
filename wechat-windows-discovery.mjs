import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { WechatControlError } from "./wechat-version-policy.mjs";

const collectPowerShell = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$items = @()
try {
  Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction Stop | ForEach-Object {
    if ($_.ExecutablePath) { $items += [pscustomobject]@{ path=$_.ExecutablePath; source='process'; confidence=30 } }
  }
  $views = @([Microsoft.Win32.RegistryView]::Registry32)
  if ([Environment]::Is64BitOperatingSystem) {
    $views += [Microsoft.Win32.RegistryView]::Registry64
  }
  $hives = @(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryHive]::LocalMachine
  )
  foreach ($hive in $hives) {
    foreach ($view in $views) {
      $baseKey = $null
      $uninstallKey = $null
      try {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $uninstallKey = $baseKey.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if (-not $uninstallKey) { continue }
        foreach ($subKeyName in $uninstallKey.GetSubKeyNames()) {
          $subKey = $null
          try {
            $subKey = $uninstallKey.OpenSubKey($subKeyName)
            if (-not $subKey) { continue }
            $displayName = [string]$subKey.GetValue('DisplayName')
            if ($displayName -match '微信|Weixin|WeChat') {
              $items += [pscustomobject]@{
                installLocation = [string]$subKey.GetValue('InstallLocation', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                displayIcon = [string]$subKey.GetValue('DisplayIcon', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                source = 'registry'
                confidence = 20
              }
            }
          } finally {
            if ($subKey) { $subKey.Dispose() }
          }
        }
      } finally {
        if ($uninstallKey) { $uninstallKey.Dispose() }
        if ($baseKey) { $baseKey.Dispose() }
      }
    }
  }
  $items | ConvertTo-Json -Compress
} catch [System.UnauthorizedAccessException] {
  [Console]::Error.WriteLine('WECHAT_DISCOVERY_ACCESS_DENIED')
  exit 1
} catch [System.Security.SecurityException] {
  [Console]::Error.WriteLine('WECHAT_DISCOVERY_SECURITY_FAILED')
  exit 1
} catch {
  [Console]::Error.WriteLine('WECHAT_DISCOVERY_QUERY_FAILED')
  exit 1
}
`;

const metadataScript = String.raw`
& {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  if (-not (Test-Path -LiteralPath $args[0] -PathType Leaf)) {
    Write-Output 'null'
    return
  }
  $item = Get-Item -LiteralPath $args[0]
  [pscustomobject]@{
    version = [string]$item.VersionInfo.FileVersion
    productName = [string]$item.VersionInfo.ProductName
  } | ConvertTo-Json -Compress
}
`;

const DEFAULT_POWERSHELL_TIMEOUT_MS = 10_000;
const DEFAULT_POWERSHELL_MAX_OUTPUT_BYTES = 1024 * 1024;

export function createProcessRunner({
  spawnProcess = spawn,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  return function run(command, args, {
    timeoutMs = DEFAULT_POWERSHELL_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_POWERSHELL_MAX_OUTPUT_BYTES,
  } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(command, args, { windowsHide: true, shell: false });
      } catch (error) {
        reject(new WechatControlError("WECHAT_POWERSHELL_FAILED", "无法启动 PowerShell", { cause: String(error?.message || error) }));
        return;
      }
      let settled = false;
      let totalBytes = 0;
      let timer;
      const stdout = [];
      const stderr = [];
      const clearTimer = () => {
        if (timer !== undefined) clearTimeoutFn(timer);
      };
      const settleReject = (error, kill = false) => {
        if (settled) return;
        settled = true;
        clearTimer();
        if (kill) {
          try { child.kill(); } catch {}
        }
        reject(error);
      };
      const append = (target, chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        totalBytes += buffer.length;
        if (totalBytes > maxOutputBytes) {
          settleReject(new WechatControlError(
            "WECHAT_POWERSHELL_OUTPUT_LIMIT",
            "PowerShell 输出超过限制",
            { maxOutputBytes },
          ), true);
          return;
        }
        target.push(buffer);
      };
      child.stdout.on("data", (chunk) => append(stdout, chunk));
      child.stderr.on("data", (chunk) => append(stderr, chunk));
      child.on("error", (error) => settleReject(new WechatControlError(
        "WECHAT_POWERSHELL_FAILED",
        "PowerShell 启动失败",
        { cause: String(error?.message || error) },
      )));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimer();
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        if (code === 0) {
          resolve(stdoutText);
          return;
        }
        reject(new WechatControlError(
          "WECHAT_POWERSHELL_FAILED",
          "PowerShell 执行失败",
          { exitCode: code, stderr: Buffer.concat(stderr).toString("utf8").trim() },
        ));
      });
      if (timeoutMs > 0) {
        timer = setTimeoutFn(() => settleReject(new WechatControlError(
          "WECHAT_POWERSHELL_TIMEOUT",
          "PowerShell 执行超时",
          { timeoutMs },
        ), true), timeoutMs);
      }
    });
  };
}

const run = createProcessRunner();

function wrapOperationalError(code, message, error) {
  if (error instanceof WechatControlError && error.code === code) return error;
  return new WechatControlError(code, message, {
    causeCode: String(error?.code || ""),
    cause: String(error?.message || error),
  });
}

const expectedMissingCodes = new Set(["ENOENT", "ENOTDIR"]);

function discoveryFailure(stage, error, fallbackCode = "UNKNOWN") {
  if (error instanceof WechatControlError && error.code === "WECHAT_DISCOVERY_FAILED") return error;
  const value = String(error?.code || fallbackCode);
  const causeCode = /^[A-Z0-9_]+$/.test(value) ? value : fallbackCode;
  return new WechatControlError("WECHAT_DISCOVERY_FAILED", "微信安装发现失败", { stage, causeCode });
}

function isExpectedMissing(error) {
  return expectedMissingCodes.has(error?.code);
}

function stripBalancedSurroundingQuotes(value) {
  const trimmed = String(value || "").trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function expandWindowsEnvironmentVariables(value, env) {
  const values = new Map(Object.entries(env || {}).map(([name, item]) => [name.toLowerCase(), String(item)]));
  return value.replace(/%([^%]+)%/g, (match, name) => values.get(name.toLowerCase()) ?? match);
}

export function normalizeRegistryInstallLocation(value, { env = process.env } = {}) {
  return expandWindowsEnvironmentVariables(stripBalancedSurroundingQuotes(value), env).trim();
}

export function normalizeRegistryDisplayIcon(value, { env = process.env } = {}) {
  const withoutIndex = String(value || "").trim().replace(/,\s*-?\d+\s*$/, "");
  return expandWindowsEnvironmentVariables(stripBalancedSurroundingQuotes(withoutIndex), env).trim();
}

export function deriveRegistryExecutable({ installLocation, displayIcon } = {}, { env = process.env } = {}) {
  const root = normalizeRegistryInstallLocation(installLocation, { env });
  if (root) return path.win32.join(root, "Weixin.exe");
  const icon = normalizeRegistryDisplayIcon(displayIcon, { env });
  return path.win32.basename(icon).toLowerCase() === "weixin.exe" ? icon : "";
}

export async function collectDefaultCandidates({
  env = process.env,
  runPowerShell = run,
  timeoutMs = DEFAULT_POWERSHELL_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_POWERSHELL_MAX_OUTPUT_BYTES,
} = {}) {
  try {
    const stdout = await runPowerShell(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", collectPowerShell],
      { timeoutMs, maxOutputBytes },
    );
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const candidates = [];
    for (const item of records) {
      if (typeof item?.path === "string" && item.path.trim()) {
        candidates.push({ ...item, path: item.path.trim() });
        continue;
      }
      if (item?.source === "registry") {
        const executable = deriveRegistryExecutable(item, { env });
        if (executable) candidates.push({ path: executable, source: item.source, confidence: item.confidence });
      }
    }
    for (const root of [env.ProgramW6432, env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push({ path: path.win32.join(root, "Tencent", "Weixin", "Weixin.exe"), source: "fallback", confidence: 10 });
    }
    return candidates;
  } catch (error) {
    throw discoveryFailure("collector", error);
  }
}

export async function readDefaultMetadata(executable, {
  runPowerShell = run,
  timeoutMs = DEFAULT_POWERSHELL_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_POWERSHELL_MAX_OUTPUT_BYTES,
} = {}) {
  try {
    const quotedExecutable = `"${String(executable).replace(/[`"$]/g, "`$&")}"`;
    const stdout = await runPowerShell(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", metadataScript.trim(), quotedExecutable],
      { timeoutMs, maxOutputBytes },
    );
    return JSON.parse(stdout);
  } catch (error) {
    throw wrapOperationalError("WECHAT_DISCOVERY_METADATA_FAILED", "无法读取微信文件元数据", error);
  }
}

const allowedProductNames = new Set(["微信", "微信电脑版", "weixin", "wechat"]);

function isAllowedProductName(value) {
  const normalized = String(value || "").trim();
  return allowedProductNames.has(normalized) || allowedProductNames.has(normalized.toLowerCase());
}

export function createWechatDiscovery({
  platform = process.platform,
  explicitExecutable = process.env.DSH_WECHAT_EXECUTABLE || "",
  collectCandidates = collectDefaultCandidates,
  realpath = fs.realpath,
  stat = fs.stat,
  readMetadata = readDefaultMetadata,
  powerShellTimeoutMs = DEFAULT_POWERSHELL_TIMEOUT_MS,
  maxPowerShellOutputBytes = DEFAULT_POWERSHELL_MAX_OUTPUT_BYTES,
} = {}) {
  async function discover() {
    if (platform !== "win32") throw new WechatControlError("WECHAT_UNSUPPORTED", "微信个人号通道仅支持 Windows");
    let raw;
    try {
      raw = [...await collectCandidates({ timeoutMs: powerShellTimeoutMs, maxOutputBytes: maxPowerShellOutputBytes })];
    } catch (error) {
      throw discoveryFailure("collector", error);
    }
    if (explicitExecutable) raw.unshift({ path: explicitExecutable, source: "explicit", confidence: 40 });
    const resolved = new Map();
    for (const item of raw) {
      let executable;
      try {
        executable = await realpath(item.path);
      } catch (error) {
        if (isExpectedMissing(error)) continue;
        throw discoveryFailure("realpath", error);
      }
      if (typeof executable !== "string" || !path.win32.isAbsolute(executable)) continue;
      if (path.win32.basename(executable).toLowerCase() !== "weixin.exe") continue;
      const key = path.win32.normalize(executable).toLowerCase();
      const existing = resolved.get(key);
      const sources = existing?.sources || [];
      if (item.source && !sources.includes(item.source)) sources.push(item.source);
      if (!existing || item.confidence > existing.confidence) {
        resolved.set(key, {
          ...item,
          executable,
          installRoot: path.win32.dirname(executable),
          sources,
        });
      }
    }
    const valid = [];
    for (const item of resolved.values()) {
      let file;
      try {
        file = await stat(item.executable);
      } catch (error) {
        if (isExpectedMissing(error)) continue;
        throw discoveryFailure("stat", error);
      }
      if (typeof file?.isFile !== "function") throw discoveryFailure("stat", null, "INVALID_STAT");
      let isFile;
      try {
        isFile = file.isFile();
      } catch (error) {
        throw discoveryFailure("stat", error);
      }
      if (typeof isFile !== "boolean") throw discoveryFailure("stat", null, "INVALID_STAT");
      if (!isFile) continue;
      let info;
      try {
        info = await readMetadata(item.executable, {
          timeoutMs: powerShellTimeoutMs,
          maxOutputBytes: maxPowerShellOutputBytes,
        });
      } catch (error) {
        if (isExpectedMissing(error)) continue;
        throw discoveryFailure("metadata", error);
      }
      if (!info || !/^4\.\d+\.\d+\.\d+$/.test(String(info.version)) || !isAllowedProductName(info.productName)) continue;
      valid.push({ ...item, version: info.version, productName: info.productName });
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
