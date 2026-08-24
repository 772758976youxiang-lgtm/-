# WeChat 4.1.10.27 Version Guard and Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the personal WeChat channel from running on any Windows WeChat version except `4.1.10.27`, and provide a confirmed, verified, unattended installer flow that suppresses automatic updates before enabling the channel.

**Architecture:** Pure policy and discovery modules make compatibility decisions testable without changing the host machine. A Windows installer manager owns the pinned artifact, one-time confirmation, job state, elevation, and post-install validation; a small channel controller is the only code allowed to persist `enabled: true`. `server.mjs` exposes loopback APIs, while the settings client renders the warning modal and installation progress.

**Tech Stack:** Node.js 18+ ES modules, `node:test`, Windows PowerShell 5.1+, Windows Authenticode, Windows Firewall, React/DSH client JSX runtime, Python unittest regression suite.

---

## File Map

- Create `wechat-version-policy.mjs`: pinned target metadata, stable error codes, exact-version comparison, confirmation snapshot normalization, and one-time token store.
- Create `wechat-windows-discovery.mjs`: dependency-injected WeChat 4.x candidate validation, precedence, ambiguity handling, and default PowerShell candidate collection.
- Create `wechat-installer-artifact.mjs`: bounded HTTPS download, redirect policy, file size/hash validation, and Authenticode validation.
- Create `wechat-install-manager.mjs`: singleton installation job, progress phases, elevated helper invocation, and final independent validation.
- Create `wechat-channel-controller.mjs`: fail-closed status, toggle, startup reconciliation, install confirmation, and the sole enable transition.
- Create `scripts/wechat-install-helper.ps1`: one-UAC unattended install, post-install discovery, scoped updater suppression, firewall/task/service changes, and result serialization.
- Create `scripts/wechat-version-policy.test.mjs`: policy and one-time-token tests.
- Create `scripts/wechat-windows-discovery.test.mjs`: portable discovery tests using fake Windows paths and metadata.
- Create `scripts/wechat-installer-artifact.test.mjs`: download and artifact-verification tests using injected streams and signature results.
- Create `scripts/wechat-install-manager.test.mjs`: installation job state-machine and elevation-result tests.
- Create `scripts/wechat-channel-controller.test.mjs`: enable, decline/failure, startup drift, and persistence invariants.
- Modify `server.mjs`: use the controller, add structured status and install routes, and enforce loopback mutation checks.
- Modify `client/connection-page.js`: render confirmation modal, warning state, phases, and install action.
- Modify `lib/client.js`: keep the shipped client implementation and locale strings aligned with readable source.
- Modify `scripts/check-compat.mjs`: assert the new modules, API route, warning strings, and package contents.
- Modify `package.json`: ship new root modules and run all new Node tests.
- Modify `README.md`, `INSTALL.md`, and `wechat_channel/README.md`: document exact-version enforcement, one UAC, pinned verification, failure behavior, and update suppression.

### Task 1: Exact-version policy and one-time confirmation

**Files:**
- Create: `wechat-version-policy.mjs`
- Create: `scripts/wechat-version-policy.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing exact-version and token tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_WECHAT,
  createConfirmationStore,
  isTargetWechatVersion,
  normalizeWechatSnapshot,
} from "../wechat-version-policy.mjs";

test("accepts only the exact four-part target version", () => {
  assert.equal(isTargetWechatVersion("4.1.10.27"), true);
  for (const value of ["4.1.10.0", "4.1.10.270", "4.1.12.26", "3.9.12.55", "", null]) {
    assert.equal(isTargetWechatVersion(value), false, String(value));
  }
  assert.equal(TARGET_WECHAT.sha256.length, 64);
});

test("confirmation tokens are one-use, expire, and bind to the observed snapshot", () => {
  let at = 1000;
  let sequence = 0;
  const store = createConfirmationStore({ now: () => at, randomToken: () => `token-${++sequence}`, ttlMs: 5000 });
  const snapshot = normalizeWechatSnapshot({ executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" });
  const token = store.issue(snapshot);
  assert.deepEqual(store.consume(token, snapshot), snapshot);
  assert.throws(() => store.consume(token, snapshot), { code: "CONFIRMATION_INVALID" });

  const expired = store.issue(snapshot);
  at += 5001;
  assert.throws(() => store.consume(expired, snapshot), { code: "CONFIRMATION_EXPIRED" });

  const changed = store.issue(snapshot);
  assert.throws(
    () => store.consume(changed, normalizeWechatSnapshot({ executable: snapshot.executable, version: "4.1.10.31" })),
    { code: "CONFIRMATION_STATE_CHANGED" },
  );
});
```

- [ ] **Step 2: Run the policy test and verify it fails because the module is absent**

Run: `node --test scripts/wechat-version-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `wechat-version-policy.mjs`.

- [ ] **Step 3: Implement the pinned policy and token store**

```js
import crypto from "node:crypto";
import path from "node:path";

export const TARGET_WECHAT = Object.freeze({
  version: "4.1.10.27",
  url: "https://github.com/SiverKing/wechat4.0-windows-versions/releases/download/v4.1.10.27/weixin_4.1.10.27.exe",
  size: 239441904,
  sha256: "54203fc2b41983fa106b0af0d67f86befc56ccd3dc1005d4bab6de8ea36b4f74",
  signerOrganization: "Tencent Technology (Shenzhen) Company Limited",
});

export class WechatControlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WechatControlError";
    this.code = code;
    this.details = details;
  }
}

export const isTargetWechatVersion = (version) => version === TARGET_WECHAT.version;

export function normalizeWechatSnapshot(value = {}) {
  return Object.freeze({
    executable: value.executable ? path.win32.normalize(String(value.executable)).toLowerCase() : "",
    version: String(value.version || ""),
  });
}

export function createConfirmationStore({
  now = Date.now,
  randomToken = () => crypto.randomBytes(32).toString("base64url"),
  ttlMs = 5 * 60 * 1000,
} = {}) {
  const tokens = new Map();
  return {
    issue(snapshot) {
      const token = randomToken();
      tokens.set(token, { snapshot: normalizeWechatSnapshot(snapshot), expiresAt: now() + ttlMs });
      return token;
    },
    consume(token, currentSnapshot) {
      const record = tokens.get(token);
      tokens.delete(token);
      if (!record) throw new WechatControlError("CONFIRMATION_INVALID", "安装确认已失效，请重新检查微信版本");
      if (now() > record.expiresAt) throw new WechatControlError("CONFIRMATION_EXPIRED", "安装确认已过期，请重新确认");
      const current = normalizeWechatSnapshot(currentSnapshot);
      if (JSON.stringify(current) !== JSON.stringify(record.snapshot)) {
        throw new WechatControlError("CONFIRMATION_STATE_CHANGED", "微信安装状态已变化，请重新确认");
      }
      return record.snapshot;
    },
  };
}
```

Add the new test to `package.json` before `scripts/install-utils.test.mjs`:

```json
"test": "node --check lib/index.js && node --check lib/client.js && node --check server.mjs && node --check scripts/install-assets.mjs && node --test scripts/wechat-version-policy.test.mjs scripts/install-utils.test.mjs && node scripts/check-compat.mjs && node scripts/run-python-tests.mjs"
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test scripts/wechat-version-policy.test.mjs`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit the policy unit**

```powershell
git add package.json wechat-version-policy.mjs scripts/wechat-version-policy.test.mjs
git commit -m "feat: define WeChat version policy"
```

### Task 2: Portable WeChat 4.x discovery

**Files:**
- Create: `wechat-windows-discovery.mjs`
- Create: `scripts/wechat-windows-discovery.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing discovery tests for custom paths, coexistence, precedence, and ambiguity**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createWechatDiscovery } from "../wechat-windows-discovery.mjs";

const metadata = new Map([
  ["D:\\Portable\\Weixin\\Weixin.exe", { version: "4.1.10.27", productName: "微信电脑版" }],
  ["C:\\Program Files\\Tencent\\WeChat\\WeChat.exe", { version: "3.9.12.55", productName: "微信" }],
  ["E:\\Tencent\\WXWork\\WXWork.exe", { version: "5.0.0.0", productName: "企业微信" }],
]);

const discovery = (candidates, explicitExecutable = "") => createWechatDiscovery({
  platform: "win32",
  explicitExecutable,
  collectCandidates: async () => candidates,
  realpath: async (value) => value,
  readMetadata: async (value) => metadata.get(value) || null,
});

test("finds Weixin 4.x on a custom drive and excludes WeChat 3.x and WXWork", async () => {
  const result = await discovery([
    { path: "C:\\Program Files\\Tencent\\WeChat\\WeChat.exe", source: "registry", confidence: 20 },
    { path: "E:\\Tencent\\WXWork\\WXWork.exe", source: "process", confidence: 30 },
    { path: "D:\\Portable\\Weixin\\Weixin.exe", source: "registry", confidence: 20 },
  ]).discover();
  assert.equal(result.executable, "D:\\Portable\\Weixin\\Weixin.exe");
  assert.equal(result.version, "4.1.10.27");
  assert.equal(result.installRoot, "D:\\Portable\\Weixin");
});

test("explicit executable wins over registry and equal-confidence conflicts fail closed", async () => {
  metadata.set("F:\\Weixin\\Weixin.exe", { version: "4.1.12.26", productName: "Weixin" });
  const explicit = await discovery(
    [{ path: "D:\\Portable\\Weixin\\Weixin.exe", source: "registry", confidence: 20 }],
    "F:\\Weixin\\Weixin.exe",
  ).discover();
  assert.equal(explicit.executable, "F:\\Weixin\\Weixin.exe");

  metadata.set("G:\\Weixin\\Weixin.exe", { version: "4.1.10.31", productName: "Weixin" });
  await assert.rejects(
    discovery([
      { path: "F:\\Weixin\\Weixin.exe", source: "registry", confidence: 20 },
      { path: "G:\\Weixin\\Weixin.exe", source: "registry", confidence: 20 },
    ]).discover(),
    { code: "WECHAT_DISCOVERY_AMBIGUOUS" },
  );
});
```

- [ ] **Step 2: Run the discovery test and verify module-not-found failure**

Run: `node --test scripts/wechat-windows-discovery.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement candidate collection and validation**

Create `wechat-windows-discovery.mjs` with these public interfaces:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { WechatControlError } from "./wechat-version-policy.mjs";

const collectPowerShell = String.raw`
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

export async function collectDefaultCandidates({ env = process.env } = {}) {
  const stdout = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", collectPowerShell]);
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const root of [env.ProgramW6432, env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)) {
    candidates.push({ path: path.win32.join(root, "Tencent", "Weixin", "Weixin.exe"), source: "fallback", confidence: 10 });
  }
  return candidates;
}

export function createWechatDiscovery({
  platform = process.platform,
  explicitExecutable = process.env.DSH_WECHAT_EXECUTABLE || "",
  collectCandidates = collectDefaultCandidates,
  realpath = fs.realpath,
  readMetadata,
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
```

Implement the default metadata reader with a static script and a separate path argument:

```js
const metadataScript = String.raw`
$item = Get-Item -LiteralPath $args[0]
[pscustomobject]@{
  version = [string]$item.VersionInfo.FileVersion
  productName = [string]$item.VersionInfo.ProductName
} | ConvertTo-Json -Compress
`;

export async function readDefaultMetadata(executable) {
  const stdout = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", metadataScript, executable]);
  return JSON.parse(stdout);
}
```

Use `readDefaultMetadata` as the `readMetadata` default in `createWechatDiscovery`.

Add `scripts/wechat-windows-discovery.test.mjs` to the `node --test` file list in `package.json`.

- [ ] **Step 4: Run discovery tests and the existing suite**

Run: `node --test scripts/wechat-version-policy.test.mjs scripts/wechat-windows-discovery.test.mjs`

Expected: all policy and discovery tests pass.

- [ ] **Step 5: Commit the discovery unit**

```powershell
git add package.json wechat-windows-discovery.mjs scripts/wechat-windows-discovery.test.mjs
git commit -m "feat: discover Windows WeChat installations"
```

### Task 3: Pinned download and artifact verification

**Files:**
- Create: `wechat-installer-artifact.mjs`
- Create: `scripts/wechat-installer-artifact.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for redirect, size, hash, signer, and cleanup behavior**

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { createArtifactManager } from "../wechat-installer-artifact.mjs";

test("rejects unapproved redirect hosts and digest mismatches", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-artifact-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = createArtifactManager({ tempRoot: root });
  assert.equal(manager.isAllowedUrl(new URL("https://github.com/org/repo/releases/file.exe")), true);
  assert.equal(manager.isAllowedUrl(new URL("https://objects.githubusercontent.com/file.exe")), true);
  assert.equal(manager.isAllowedUrl(new URL("https://example.com/file.exe")), false);
  await assert.rejects(
    manager.verifyFile(path.join(root, "missing.exe"), { size: 1, sha256: "0".repeat(64) }),
  );
});

test("accepts only matching size, SHA-256, and Tencent signature", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-artifact-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "installer.exe");
  await fs.writeFile(file, "verified fixture");
  const manager = createArtifactManager({
    tempRoot: root,
    readSignature: async () => ({ status: "Valid", signerOrganization: "Tencent Technology (Shenzhen) Company Limited" }),
  });
  const crypto = await import("node:crypto");
  const digest = crypto.createHash("sha256").update("verified fixture").digest("hex");
  await assert.doesNotReject(manager.verifyFile(file, { size: 16, sha256: digest, signerOrganization: "Tencent Technology (Shenzhen) Company Limited" }));
  await assert.rejects(manager.verifyFile(file, { size: 16, sha256: "f".repeat(64), signerOrganization: "Tencent Technology (Shenzhen) Company Limited" }), { code: "INSTALLER_HASH_MISMATCH" });
});
```

- [ ] **Step 2: Run the artifact test and verify module-not-found failure**

Run: `node --test scripts/wechat-installer-artifact.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement bounded download and verification**

Create `createArtifactManager()` with this stable surface:

```js
export function createArtifactManager({
  fetchImpl = fetch,
  tempRoot = os.tmpdir(),
  readSignature = readAuthenticodeSignature,
} = {}) {
  const allowedHosts = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
  const isAllowedUrl = (url) => url.protocol === "https:" && allowedHosts.has(url.hostname.toLowerCase());

  async function verifyFile(file, policy = TARGET_WECHAT) {
    const stat = await fs.stat(file);
    if (stat.size !== policy.size) throw new WechatControlError("INSTALLER_SIZE_MISMATCH", "微信安装包大小校验失败");
    const digest = await hashFile(file);
    if (digest !== policy.sha256.toLowerCase()) throw new WechatControlError("INSTALLER_HASH_MISMATCH", "微信安装包完整性校验失败");
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
```

`streamAllowedDownload` must request with `redirect: "manual"`, follow no more than five redirects, reject a host before every request, stream through `Readable.fromWeb(response.body)`, stop once bytes exceed `policy.size`, and rename a `.partial` file only after the exact byte count is reached. `readAuthenticodeSignature` must call PowerShell with the file path supplied as a separate encoded argument and parse `Status` plus certificate `O=`.

Add the artifact test file to the package test command.

- [ ] **Step 4: Run focused artifact tests**

Run: `node --test scripts/wechat-installer-artifact.test.mjs`

Expected: all artifact tests pass and temporary test directories are removed.

- [ ] **Step 5: Commit the artifact unit**

```powershell
git add package.json wechat-installer-artifact.mjs scripts/wechat-installer-artifact.test.mjs
git commit -m "feat: verify pinned WeChat installer"
```

### Task 4: Elevated installer and scoped update suppression

**Files:**
- Create: `scripts/wechat-install-helper.ps1`
- Create: `scripts/wechat-install-helper.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write a failing contract test for the helper**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const helper = path.resolve("scripts/wechat-install-helper.ps1");

test("helper parses and contains required scoping guards", () => {
  const parsed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}',[ref]$null,[ref]$errors); if($errors.Count){$errors | Out-String | Write-Error; exit 1}`], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const source = fs.readFileSync(helper, "utf8");
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /Get-FileHash/);
  assert.match(source, /WeixinUpdate\.exe/);
  assert.match(source, /New-NetFirewallRule/);
  assert.match(source, /WXWork/i);
  assert.match(source, /ConvertTo-Json/);
  assert.doesNotMatch(source, /taskkill.+WeChat\.exe/i);
});
```

- [ ] **Step 2: Run the helper contract test and verify file-not-found failure**

Run: `node --test scripts/wechat-install-helper.test.mjs`

Expected: FAIL because `scripts/wechat-install-helper.ps1` does not exist.

- [ ] **Step 3: Implement the one-UAC helper**

The script starts with an explicit contract and no ambient path assumptions:

```powershell
param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion,
  [Parameter(Mandatory=$true)][string]$ExpectedSignerOrganization,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [Parameter(Mandatory=$true)][string]$StatePath
)
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok=$false; phase='starting'; code='INSTALL_FAILED'; message=''; executable=''; version=''; updateSuppressed=$false }
```

Implement and call these complete responsibilities in order:

```powershell
function Write-Result([hashtable]$Value) {
  $parent = Split-Path -Parent $ResultPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}

function Assert-Installer {
  $hash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'INSTALLER_HASH_MISMATCH' }
  $signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch [regex]::Escape("O=$ExpectedSignerOrganization")) {
    throw 'INSTALLER_SIGNATURE_INVALID'
  }
}

function Get-WeixinInstallation {
  $candidates = @()
  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  Get-ItemProperty $registryRoots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '微信|Weixin' } | ForEach-Object {
    if ($_.InstallLocation) { $candidates += Join-Path ([string]$_.InstallLocation).Trim('"') 'Weixin.exe' }
  }
  Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.ExecutablePath) { $candidates += $_.ExecutablePath }
  }
  $valid = @($candidates | Select-Object -Unique | Where-Object {
    (Test-Path -LiteralPath $_ -PathType Leaf) -and ((Split-Path -Leaf $_) -ieq 'Weixin.exe')
  } | Where-Object { (Get-Item -LiteralPath $_).VersionInfo.FileVersion -eq $ExpectedVersion })
  if ($valid.Count -ne 1) { throw 'POST_INSTALL_VERSION_MISMATCH' }
  return (Resolve-Path -LiteralPath $valid[0]).Path
}

function Disable-WeixinUpdates([string]$Executable) {
  $installRoot = Split-Path -Parent $Executable
  Get-CimInstance Win32_Process -Filter "Name='WeixinUpdate.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

  $records = @()
  Get-ChildItem -LiteralPath $installRoot -Filter 'WeixinUpdate.exe' -File -Recurse | ForEach-Object {
    $original = $_.FullName
    $backup = "$original.dsh-disabled"
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    Move-Item -LiteralPath $original -Destination $backup
    $ruleName = "DSH WeChat Update Block " + ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($original))).Substring(0,16))
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Block -Program $original | Out-Null
    $records += [ordered]@{ original=$original; backup=$backup; firewallRule=$ruleName }
  }
  if ($records.Count -eq 0) { throw 'UPDATE_SUPPRESSION_FAILED' }
  $records | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding UTF8
  return $records
}
```

Wrap execution in `try/catch/finally`: validate the artifact; stop only `Weixin.exe` and `WeixinUpdate.exe`; run `Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru`; require exit code zero; call `Get-WeixinInstallation`; call `Disable-WeixinUpdates`; set `ok`, `version`, and `updateSuppressed`; always write the result. Before disabling tasks or services, resolve the configured executable and require it to be under `$installRoot`; skip any name/path containing `WXWork`, `WeCom`, or a `WeChat.exe` 3.x installation.

Use PowerShell 5.1-compatible hashing for the firewall rule name rather than `Convert.ToHexString`/`SHA256.HashData` if the local parser/runtime check shows those .NET APIs are unavailable.

Add this test to the package test command.

- [ ] **Step 4: Run parser and contract tests**

Run: `node --test scripts/wechat-install-helper.test.mjs`

Expected: the helper parses under the installed Windows PowerShell and all scoping assertions pass. This step must not execute the installer or modify firewall state.

- [ ] **Step 5: Commit the elevated helper**

```powershell
git add package.json scripts/wechat-install-helper.ps1 scripts/wechat-install-helper.test.mjs
git commit -m "feat: add elevated WeChat install helper"
```

### Task 5: Installation job manager

**Files:**
- Create: `wechat-install-manager.mjs`
- Create: `scripts/wechat-install-manager.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing state-machine tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createWechatInstallManager } from "../wechat-install-manager.mjs";

test("runs one job through verified phases and exposes a safe status", async () => {
  const phases = [];
  const manager = createWechatInstallManager({
    discovery: { discover: async () => ({ executable: "D:\\Weixin\\Weixin.exe", version: "4.1.10.27", installRoot: "D:\\Weixin" }) },
    artifact: { download: async (_policy, progress) => { progress(50); return { directory: "D:\\Temp\\job", file: "D:\\Temp\\job\\installer.exe" }; }, verifyFile: async () => {}, cleanup: async () => {} },
    confirmationStore: { consume: () => ({ executable: "D:\\Old\\Weixin.exe", version: "4.1.12.26" }) },
    runElevatedHelper: async ({ onPhase }) => { onPhase("installing"); return { ok: true, version: "4.1.10.27", updateSuppressed: true }; },
    verifySuppression: async () => true,
  });
  await manager.start("confirmed-token", { executable: "D:\\Old\\Weixin.exe", version: "4.1.12.26" }, (value) => phases.push(value));
  assert.equal(manager.status().phase, "ready");
  assert.equal(manager.status().errorCode, null);
  assert.equal(manager.status().installerPath, undefined);
  assert.deepEqual(phases, ["downloading", "verifying", "requesting_admin", "installing", "verifying_install", "ready"]);
});

test("rejects concurrent jobs and stays failed after UAC cancellation", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const manager = createWechatInstallManager({
    discovery: { discover: async () => null },
    artifact: { download: async () => pending, verifyFile: async () => {}, cleanup: async () => {} },
    confirmationStore: { consume: () => ({ executable: "", version: "" }) },
    runElevatedHelper: async () => ({ ok: false, code: "UAC_CANCELLED" }),
    verifySuppression: async () => false,
  });
  const first = manager.start("one", { executable: "", version: "" });
  await assert.rejects(manager.start("two", { executable: "", version: "" }), { code: "INSTALL_ALREADY_RUNNING" });
  release({ directory: "D:\\Temp\\job", file: "D:\\Temp\\job\\installer.exe" });
  await assert.rejects(first);
  assert.equal(manager.status().phase, "failed");
});
```

- [ ] **Step 2: Run the manager test and verify module-not-found failure**

Run: `node --test scripts/wechat-install-manager.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the singleton job manager and elevation adapter**

Expose only safe status data:

```js
const INITIAL_STATUS = Object.freeze({ phase: "idle", progress: null, errorCode: null, error: "" });

export function createWechatInstallManager({ discovery, artifact, confirmationStore, runElevatedHelper, verifySuppression }) {
  let state = { ...INITIAL_STATUS };
  let active = null;
  const status = () => ({ phase: state.phase, progress: state.progress, errorCode: state.errorCode, error: state.error });

  async function start(token, observedSnapshot, phaseListener = () => {}) {
    if (active) throw new WechatControlError("INSTALL_ALREADY_RUNNING", "微信安装任务正在进行中");
    confirmationStore.consume(token, observedSnapshot);
    const setPhase = (phase, progress = null) => { state = { phase, progress, errorCode: null, error: "" }; phaseListener(phase); };
    active = (async () => {
      let artifactResult;
      try {
        setPhase("downloading", 0);
        artifactResult = await artifact.download(TARGET_WECHAT, (progress) => { state = { ...state, progress }; });
        setPhase("verifying");
        await artifact.verifyFile(artifactResult.file, TARGET_WECHAT);
        setPhase("requesting_admin");
        const helper = await runElevatedHelper({ installer: artifactResult.file, target: TARGET_WECHAT, onPhase: setPhase });
        if (!helper.ok) throw new WechatControlError(helper.code || "INSTALL_FAILED", helper.message || "微信安装失败");
        setPhase("verifying_install");
        const installed = await discovery.discover();
        if (!installed || !isTargetWechatVersion(installed.version)) throw new WechatControlError("POST_INSTALL_VERSION_MISMATCH", "安装后微信版本仍不兼容");
        if (!(await verifySuppression(installed, helper))) throw new WechatControlError("UPDATE_SUPPRESSION_FAILED", "微信自动更新未能关闭");
        setPhase("ready");
        return installed;
      } catch (error) {
        state = { phase: "failed", progress: null, errorCode: error.code || "INSTALL_FAILED", error: error.message || String(error) };
        throw error;
      } finally {
        if (artifactResult) await artifact.cleanup(artifactResult.directory);
        active = null;
      }
    })();
    return active;
  }
  return { start, status };
}
```

The production `runElevatedHelper` must write a restrictive operation/result directory under `%TEMP%`, call PowerShell with `-NoProfile -NonInteractive`, use `Start-Process powershell.exe -Verb RunAs -Wait` with an argument list, map the Windows cancellation result to `UAC_CANCELLED`, parse the helper JSON, and delete the operation directory in `finally`.

Add the manager test to the package test command.

- [ ] **Step 4: Run manager and lower-level tests**

Run: `node --test scripts/wechat-version-policy.test.mjs scripts/wechat-windows-discovery.test.mjs scripts/wechat-installer-artifact.test.mjs scripts/wechat-install-helper.test.mjs scripts/wechat-install-manager.test.mjs`

Expected: all tests pass and no UAC prompt appears because dependencies are fakes.

- [ ] **Step 5: Commit the job manager**

```powershell
git add package.json wechat-install-manager.mjs scripts/wechat-install-manager.test.mjs
git commit -m "feat: orchestrate verified WeChat installation"
```

### Task 6: Fail-closed channel controller and server APIs

**Files:**
- Create: `wechat-channel-controller.mjs`
- Create: `scripts/wechat-channel-controller.test.mjs`
- Modify: `server.mjs:20-24`
- Modify: `server.mjs:443-489`
- Modify: `server.mjs:574-648`
- Modify: `server.mjs:680-769`
- Modify: `package.json`

- [ ] **Step 1: Write failing controller tests for enable, decline/failure, install success, and startup drift**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createWechatChannelController } from "../wechat-channel-controller.mjs";

const setup = ({ version = "4.1.12.26", suppressed = false } = {}) => {
  let enabled = false;
  let started = 0;
  const installed = { executable: "D:\\Weixin\\Weixin.exe", installRoot: "D:\\Weixin", version };
  const controller = createWechatChannelController({
    discovery: { discover: async () => installed },
    installManager: { status: () => ({ phase: "idle", progress: null, errorCode: null, error: "" }), start: async () => ({ ...installed, version: "4.1.10.27" }) },
    confirmationStore: { issue: () => "confirmation-token" },
    verifySuppression: async () => suppressed,
    readEnabled: () => enabled,
    persistEnabled: (value) => { enabled = value; },
    stopChannel: () => {},
    launchChannel: async () => { started += 1; },
  });
  return { controller, enabled: () => enabled, started: () => started };
};

test("mismatch returns an action without enabling", async () => {
  const fixture = setup();
  const result = await fixture.controller.toggle(true);
  assert.equal(result.httpStatus, 409);
  assert.equal(result.body.code, "WECHAT_VERSION_REQUIRED");
  assert.equal(result.body.confirmationToken, "confirmation-token");
  assert.equal(fixture.enabled(), false);
  assert.equal(fixture.started(), 0);
});

test("exact version plus suppression enables and startup drift disables", async () => {
  const fixture = setup({ version: "4.1.10.27", suppressed: true });
  assert.equal((await fixture.controller.toggle(true)).httpStatus, 200);
  assert.equal(fixture.enabled(), true);
  assert.equal(fixture.started(), 1);
  await fixture.controller.reconcileStartup({ versionOverride: "4.1.12.26" });
  assert.equal(fixture.enabled(), false);
});

test("confirmed installation starts in background and enables only after success", async () => {
  const fixture = setup();
  const response = await fixture.controller.beginInstall("confirmation-token");
  assert.equal(response.httpStatus, 202);
  assert.equal(fixture.enabled(), false);
  await fixture.controller.waitForInstallForTest();
  assert.equal(fixture.enabled(), true);
  assert.equal(fixture.started(), 1);
});
```

- [ ] **Step 2: Run the controller test and verify module-not-found failure**

Run: `node --test scripts/wechat-channel-controller.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the controller as the sole enable gate**

```js
export function createWechatChannelController({
  discovery,
  installManager,
  confirmationStore,
  verifySuppression,
  readEnabled,
  persistEnabled,
  stopChannel,
  launchChannel,
}) {
  async function inspection() {
    const installed = await discovery.discover();
    const updateSuppressed = installed && isTargetWechatVersion(installed.version) ? await verifySuppression(installed) : false;
    return { installed, updateSuppressed, versionCompatible: !!installed && isTargetWechatVersion(installed.version) };
  }

  async function enableReady(installed) {
    await stopChannel();
    await launchChannel(installed.executable);
    persistEnabled(true);
    return status();
  }

  async function toggle(enabled) {
    if (!enabled) {
      await stopChannel();
      persistEnabled(false);
      return { httpStatus: 200, body: await status() };
    }
    const current = await inspection();
    if (!current.versionCompatible || !current.updateSuppressed) {
      persistEnabled(false);
      const snapshot = normalizeWechatSnapshot(current.installed || {});
      return {
        httpStatus: 409,
        body: {
          ok: false,
          code: "WECHAT_VERSION_REQUIRED",
          requiredAction: current.versionCompatible ? "suppress_updates" : "install",
          installedVersion: current.installed?.version || "",
          targetVersion: TARGET_WECHAT.version,
          updateSuppressed: current.updateSuppressed,
          confirmationToken: confirmationStore.issue(snapshot),
        },
      };
    }
    return { httpStatus: 200, body: await enableReady(current.installed) };
  }

  let installCompletion = null;
  async function beginInstall(token) {
    const before = await inspection();
    persistEnabled(false);
    installCompletion = installManager
      .start(token, normalizeWechatSnapshot(before.installed || {}))
      .then((installed) => enableReady(installed))
      .catch(async () => {
        await stopChannel();
        persistEnabled(false);
      });
    return { httpStatus: 202, body: await status() };
  }

  const waitForInstallForTest = () => installCompletion;

  async function reconcileStartup({ versionOverride } = {}) {
    if (!readEnabled()) return status();
    const current = await inspection();
    if (versionOverride) current.versionCompatible = isTargetWechatVersion(versionOverride);
    if (!current.versionCompatible || !current.updateSuppressed) {
      await stopChannel();
      persistEnabled(false);
    }
    return status();
  }

  async function status() {
    const current = await inspection();
    return {
      ok: true,
      enabled: readEnabled(),
      executable: current.installed?.executable || "",
      installedVersion: current.installed?.version || "",
      targetVersion: TARGET_WECHAT.version,
      versionCompatible: current.versionCompatible,
      updateSuppressed: current.updateSuppressed,
      install: installManager.status(),
    };
  }
  return { status, toggle, beginInstall, reconcileStartup, waitForInstallForTest };
}
```

Integrate the controller into `server.mjs`:

- Replace `findWeChatExecutable()` with discovery-backed status and launch paths.
- Change `launchWeChatLoginWindow(executable)` to require the already-validated absolute path.
- Ensure disabling persists before stopping and enabling persists only after launch succeeds.
- Call `reconcileStartup()` before the first `syncChannels()` can start an enabled WeChat configuration.
- Return controller-provided HTTP status for `/api/wechat/toggle`.
- Add `POST /api/wechat/install`, call `beginInstall()`, return HTTP 202 immediately, and map structured `WechatControlError` codes.
- Change `isWeChatProcessRunning()` and process shutdown so this flow considers and stops only `Weixin.exe`; it must not stop the coinstalled `WeChat.exe` 3.x process.
- Validate `Host`, local `Origin`, and `Content-Type: application/json` for both mutating WeChat endpoints.
- Add `X-DSH-WeChat-Confirm` to allowed CORS headers only if the token is sent as a header; otherwise keep it in the JSON body.

Add the controller test to the package test command.

- [ ] **Step 4: Run controller, syntax, and compatibility tests**

Run: `node --test scripts/wechat-channel-controller.test.mjs && node --check server.mjs && node scripts/check-compat.mjs`

Expected: controller tests pass, server syntax is valid, and compatibility checks pass after Task 8 updates their assertions.

- [ ] **Step 5: Commit the server integration**

```powershell
git add package.json server.mjs wechat-channel-controller.mjs scripts/wechat-channel-controller.test.mjs
git commit -m "feat: guard WeChat channel enablement"
```

### Task 7: Confirmation modal, progress, and warnings

**Files:**
- Modify: `client/connection-page.js:13-82`
- Modify: `lib/client.js:13-101`
- Modify: `scripts/check-compat.mjs`

- [ ] **Step 1: Add failing shipped-client assertions**

Add these checks before modifying the clients:

```js
assert.match(client, /api\/wechat\/install/);
assert.match(client, /WECHAT_VERSION_REQUIRED/);
assert.match(client, /requiredAction/);
assert.match(client, /wechat\.versionRisk/);
assert.match(client, /wechat\.installTarget/);
assert.match(client, /wechat\.cancelInstall/);
assert.match(client, /role:\s*"dialog"/);
assert.match(client, /installedVersion/);
assert.match(client, /targetVersion/);
```

- [ ] **Step 2: Run compatibility checks and verify the new assertions fail**

Run: `node scripts/check-compat.mjs`

Expected: FAIL at the first missing installer API or locale marker.

- [ ] **Step 3: Implement readable UI behavior and mirror it in the shipped bundle**

Update the readable component state and switch flow:

```jsx
const [confirmation, setConfirmation] = React.useState(null);

const changeWechat = async () => {
  if (busy || wechat.supported === false) return;
  setBusy(true);
  setError("");
  try {
    const result = await toggleWechat(!wechat.enabled);
    if (result?.code === "WECHAT_VERSION_REQUIRED") {
      setWechat((value) => ({ ...value, enabled: false, ...result }));
      setConfirmation(result);
    } else {
      setWechat(result);
    }
  } catch (reason) {
    setError(reason?.message ?? String(reason));
  } finally {
    setBusy(false);
  }
};

const confirmInstall = async () => {
  if (!confirmation?.confirmationToken || busy) return;
  setBusy(true);
  setError("");
  try {
    setWechat(await installWechat(confirmation.confirmationToken));
    setConfirmation(null);
  } catch (reason) {
    setError(reason?.message ?? String(reason));
  } finally {
    setBusy(false);
  }
};
```

Render a `role="dialog"`, `aria-modal="true"` overlay only while `confirmation` exists. For `requiredAction: "install"`, include current version or “未检测到”, target `4.1.10.27`, the increased account-ban-risk wording, and `安装 4.1.10.27`. For `requiredAction: "suppress_updates"`, explain that the installed version is compatible but automatic updates must be disabled, and label the primary action `关闭自动更新并打开`. Both variants include `取消，保持关闭`. Cancellation clears only the modal and leaves `wechat.enabled` false. Disable both buttons during the request.

Render installation phases from `wechat.install.phase` and percent from `wechat.install.progress`. Keep the switch visually off until the server returns `enabled: true`. Persist a warning row whenever `versionCompatible === false`.

Extend injection to provide:

```js
const installWechat = (confirmationToken) => fetch("http://127.0.0.1:5175/api/wechat/install", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ confirmationToken }),
}).then(async (response) => {
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || (isZh ? "微信安装失败" : "Failed to install WeChat"));
  return body;
});
```

Change `toggleWechat` so HTTP 409 with `WECHAT_VERSION_REQUIRED` resolves to its JSON body instead of throwing; all other non-2xx responses still throw. Add matching Chinese and English keys for the modal, warning, phases, buttons, and errors. Reproduce the same behavior in `lib/client.js` using its existing `react` and `jsx` variables.

- [ ] **Step 4: Run client syntax and compatibility checks**

Run: `node --check lib/client.js && node scripts/check-compat.mjs`

Expected: both commands pass and locale/API/dialog markers are present in the shipped bundle.

- [ ] **Step 5: Commit the UI**

```powershell
git add client/connection-page.js lib/client.js scripts/check-compat.mjs
git commit -m "feat: prompt for compatible WeChat version"
```

### Task 8: Package coverage and operator documentation

**Files:**
- Modify: `package.json`
- Modify: `scripts/check-compat.mjs`
- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `wechat_channel/README.md`

- [ ] **Step 1: Add failing package-content assertions**

```js
for (const shipped of [
  "wechat-version-policy.mjs",
  "wechat-windows-discovery.mjs",
  "wechat-installer-artifact.mjs",
  "wechat-install-manager.mjs",
  "wechat-channel-controller.mjs",
  "scripts/wechat-install-helper.ps1",
]) {
  assert.equal(fs.existsSync(path.join(root, shipped)), true, `missing ${shipped}`);
}
assert.match(pkg.files.join("\n"), /wechat-version-policy\.mjs/);
assert.match(pkg.files.join("\n"), /wechat-windows-discovery\.mjs/);
assert.match(pkg.files.join("\n"), /wechat-installer-artifact\.mjs/);
assert.match(pkg.files.join("\n"), /wechat-install-manager\.mjs/);
assert.match(pkg.files.join("\n"), /wechat-channel-controller\.mjs/);
```

- [ ] **Step 2: Run compatibility checks and verify package-file assertions fail**

Run: `node scripts/check-compat.mjs`

Expected: FAIL because root manager modules are not yet listed in `package.json#files`.

- [ ] **Step 3: Ship modules and document exact behavior**

Add each root `.mjs` module to `package.json#files`; `scripts/wechat-install-helper.ps1` is already covered by the existing `scripts` entry. Ensure the final test script includes all six new Node test files in one `node --test` invocation.

Update all three documentation files with these concrete facts:

- Required installed `Weixin.exe` file version is exactly `4.1.10.27`.
- The switch remains off for missing, ambiguous, or incompatible installations.
- The user sees one plugin confirmation; Windows may show one UAC prompt.
- Download URL, expected SHA-256, size, and Tencent signature are checked before execution.
- Installation is unattended and does not intentionally delete profile/chat-data directories.
- Updater changes are scoped to the resolved WeChat 4.x root and exclude WeChat 3.x and WXWork.
- Any install, UAC, post-version, or suppression failure keeps the channel disabled.
- Custom installs can use automatic registry/process discovery or `DSH_WECHAT_EXECUTABLE` as an explicit override.

- [ ] **Step 4: Run package and documentation checks**

Run: `node scripts/check-compat.mjs && npm pack --dry-run`

Expected: compatibility checks pass; the dry-run file list includes all five root modules and `scripts/wechat-install-helper.ps1`.

- [ ] **Step 5: Commit packaging and docs**

```powershell
git add package.json scripts/check-compat.mjs README.md INSTALL.md wechat_channel/README.md
git commit -m "docs: document guarded WeChat installation"
```

### Task 9: Full verification and safe Windows smoke checks

**Files:**
- Modify only if a verification failure exposes a defect in an earlier task.

- [ ] **Step 1: Run the complete automated suite from a clean process**

Run: `npm test`

Expected: Node syntax checks, six new Node test files, existing installer tests, compatibility checks, and Python tests all pass.

- [ ] **Step 2: Verify package contents**

Run: `npm pack --dry-run`

Expected: exit code 0 and all new root modules plus `scripts/wechat-install-helper.ps1` appear in the package listing.

- [ ] **Step 3: Run read-only discovery and pinned-artifact acceptance checks on Windows**

Run a small Node command importing the production discovery and print only executable/version/source, then run the artifact verifier against the already downloaded temporary installer if it still exists. Do not invoke the elevated helper.

Expected on the current machine: discovery selects the WeChat 4.x `Weixin.exe`, reports the actual installed `4.1.12.26`, and excludes the coinstalled WeChat `3.9.12.55`; the pinned installer reports the expected size/hash and a valid Tencent signer.

- [ ] **Step 4: Start the plugin and verify fail-closed API behavior**

Reinstall the local plugin build into the web profile using the repository's documented local install command, restart `npx @deepseek-ai/dsh web`, and call:

```powershell
Invoke-RestMethod http://127.0.0.1:5175/api/wechat/status
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"enabled":true}' http://127.0.0.1:5175/api/wechat/toggle
```

Expected: status exposes installed/target version and install phase; enable returns HTTP 409 with `WECHAT_VERSION_REQUIRED`; saved channel state remains disabled; no installer or UAC is launched by the toggle request alone.

- [ ] **Step 5: Perform destructive acceptance only with fresh user authorization**

Before invoking `POST /api/wechat/install`, explain that the check will close and replace the currently installed WeChat 4.x version and modify updater/firewall state. Obtain explicit authorization in that turn. If authorized, use the UI confirmation flow and verify exactly one UAC prompt, unattended completion, installed file version `4.1.10.27`, updater suppression, and final channel enable. If authorization is not provided, report this acceptance item as not run rather than claiming it passed.

- [ ] **Step 6: Review the final diff and commit any verification-only correction**

Run: `git diff --check && git status --short --branch && git log --oneline -8`

Expected: no whitespace errors, no unrelated files, and task commits are visible. If Step 1-4 required no correction, do not create an empty commit.

## Completion Gate

Before claiming completion, use `superpowers:verification-before-completion` and cite fresh outputs for `npm test`, `npm pack --dry-run`, read-only Windows discovery, and live fail-closed API behavior. Treat the actual downgrade/update-suppression acceptance as unverified unless the user explicitly authorizes and it succeeds.
