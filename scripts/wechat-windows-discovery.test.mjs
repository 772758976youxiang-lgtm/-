import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  collectDefaultCandidates,
  createProcessRunner,
  createWechatDiscovery,
  deriveRegistryExecutable,
  normalizeRegistryDisplayIcon,
  normalizeRegistryInstallLocation,
  readDefaultMetadata,
} from "../wechat-windows-discovery.mjs";

const metadata = new Map([
  ["D:\\Portable\\Weixin\\Weixin.exe", { version: "4.1.10.27", productName: "微信电脑版" }],
  ["C:\\Program Files\\Tencent\\WeChat\\WeChat.exe", { version: "3.9.12.55", productName: "微信" }],
  ["E:\\Tencent\\WXWork\\WXWork.exe", { version: "5.0.0.0", productName: "企业微信" }],
]);

const discovery = (candidates, explicitExecutable = "", overrides = {}) => createWechatDiscovery({
  platform: "win32",
  explicitExecutable,
  collectCandidates: async () => candidates,
  realpath: async (value) => value,
  stat: async () => ({ isFile: () => true }),
  readMetadata: async (value) => metadata.get(value) || null,
  ...overrides,
});

test("normalizes registry install locations and display icons", () => {
  const env = { WEIXIN_ROOT: "D:\\便携微信" };
  assert.equal(
    normalizeRegistryInstallLocation('  "%weixin_root%\\Current"  ', { env }),
    "D:\\便携微信\\Current",
  );
  assert.equal(
    normalizeRegistryDisplayIcon('  "%WEIXIN_ROOT%\\Weixin.exe", 0  ', { env }),
    "D:\\便携微信\\Weixin.exe",
  );
  assert.equal(normalizeRegistryInstallLocation('  "C:\\Unbalanced  ', { env }), '"C:\\Unbalanced');
});

test("derives Weixin.exe from InstallLocation or a valid DisplayIcon fallback", () => {
  const env = { ROOT: "D:\\Portable" };
  assert.equal(
    deriveRegistryExecutable({
      installLocation: '  "%ROOT%\\Primary"  ',
      displayIcon: '"%ROOT%\\Fallback\\Weixin.exe",0',
    }, { env }),
    "D:\\Portable\\Primary\\Weixin.exe",
  );
  assert.equal(
    deriveRegistryExecutable({ installLocation: "", displayIcon: '"%ROOT%\\Fallback\\Weixin.exe",-1' }, { env }),
    "D:\\Portable\\Fallback\\Weixin.exe",
  );
  assert.equal(
    deriveRegistryExecutable({ installLocation: "", displayIcon: '"%ROOT%\\Fallback\\WXWork.exe",0' }, { env }),
    "",
  );
});

test("collects normalized process and registry candidates through explicit registry views", async () => {
  const processCandidate = { path: "D:\\便携微信\\Weixin.exe", source: "process", confidence: 30 };
  let invocation;
  const candidates = await collectDefaultCandidates({
    env: { PORTABLE_ROOT: "D:\\便携微信" },
    timeoutMs: 1234,
    maxOutputBytes: 5678,
    runPowerShell: async (command, args, options) => {
      invocation = { command, args, options };
      return JSON.stringify([
        processCandidate,
        { installLocation: '  "%PORTABLE_ROOT%\\Installed"  ', displayIcon: "", source: "registry", confidence: 20 },
        { installLocation: "", displayIcon: '"%PORTABLE_ROOT%\\IconOnly\\Weixin.exe",0', source: "registry", confidence: 20 },
        { installLocation: "", displayIcon: '"%PORTABLE_ROOT%\\IconOnly\\WXWork.exe",0', source: "registry", confidence: 20 },
      ]);
    },
  });

  assert.deepEqual(candidates, [
    processCandidate,
    { path: "D:\\便携微信\\Installed\\Weixin.exe", source: "registry", confidence: 20 },
    { path: "D:\\便携微信\\IconOnly\\Weixin.exe", source: "registry", confidence: 20 },
  ]);
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.options, { timeoutMs: 1234, maxOutputBytes: 5678 });
  assert.match(invocation.args[3], /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  for (const marker of [
    "OpenBaseKey",
    "ErrorAction Stop",
    "Registry32",
    "Registry64",
    "Is64BitOperatingSystem",
    "CurrentUser",
    "LocalMachine",
    "InstallLocation",
    "DisplayIcon",
    "UnauthorizedAccessException",
    "SecurityException",
    "WECHAT_DISCOVERY_QUERY_FAILED",
  ]) {
    assert.equal(invocation.args[3].includes(marker), true, marker);
  }
  assert.equal(invocation.args[3].includes("SilentlyContinue"), false);
});

test("PowerShell 5.1 collector smoke test is read-only", { skip: process.platform !== "win32" }, async () => {
  const candidates = await collectDefaultCandidates({ timeoutMs: 15_000 });
  assert.equal(Array.isArray(candidates), true);
  for (const candidate of candidates) {
    assert.equal(typeof candidate.path, "string");
    assert.equal(["process", "registry", "fallback"].includes(candidate.source), true);
  }
});

test("passes a spaced executable as a separate PowerShell argument", async () => {
  const executable = "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe";
  let invocation;
  const info = await readDefaultMetadata(executable, {
    timeoutMs: 2345,
    maxOutputBytes: 6789,
    runPowerShell: async (command, args, options) => {
      invocation = { command, args, options };
      return JSON.stringify({ version: "4.1.12.26", productName: "Weixin" });
    },
  });

  assert.deepEqual(info, { version: "4.1.12.26", productName: "Weixin" });
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.options, { timeoutMs: 2345, maxOutputBytes: 6789 });
  assert.equal(invocation.args[3], invocation.args[3].trim());
  assert.match(invocation.args[3], /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.equal(invocation.args[3].includes("Test-Path"), true);
  assert.equal(invocation.args[3].includes(executable), false);
  assert.equal(invocation.args[4], `"${executable}"`);
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  return child;
}

test("kills PowerShell and returns a stable timeout error", async () => {
  const child = createFakeChild();
  let fireTimeout;
  const runPowerShell = createProcessRunner({
    spawnProcess: () => child,
    setTimeoutFn: (callback, delay) => {
      assert.equal(delay, 25);
      fireTimeout = callback;
      return 1;
    },
    clearTimeoutFn: () => {},
  });
  const pending = runPowerShell("powershell.exe", ["-Command", "noop"], { timeoutMs: 25, maxOutputBytes: 100 });
  fireTimeout();
  await assert.rejects(pending, { code: "WECHAT_POWERSHELL_TIMEOUT" });
  assert.equal(child.killCalls, 1);
});

test("kills PowerShell when combined stdout and stderr exceed the cap", async () => {
  const child = createFakeChild();
  const runPowerShell = createProcessRunner({
    spawnProcess: () => child,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  const pending = runPowerShell("powershell.exe", ["-Command", "noop"], { timeoutMs: 100, maxOutputBytes: 5 });
  child.stdout.emit("data", Buffer.from("123"));
  child.stderr.emit("data", Buffer.from("456"));
  await assert.rejects(pending, { code: "WECHAT_POWERSHELL_OUTPUT_LIMIT" });
  assert.equal(child.killCalls, 1);
});

test("maps collector and metadata operational failures to stable codes", async () => {
  await assert.rejects(
    collectDefaultCandidates({ env: {}, runPowerShell: async () => { throw new Error("collector failed"); } }),
    { code: "WECHAT_DISCOVERY_FAILED", details: { stage: "collector", causeCode: "UNKNOWN" } },
  );
  await assert.rejects(
    readDefaultMetadata("D:\\Weixin\\Weixin.exe", { runPowerShell: async () => { throw new Error("metadata failed"); } }),
    { code: "WECHAT_DISCOVERY_METADATA_FAILED" },
  );
  await assert.rejects(
    createWechatDiscovery({
      platform: "win32",
      collectCandidates: async () => { throw new Error("injected collector failed"); },
    }).discover(),
    { code: "WECHAT_DISCOVERY_FAILED", details: { stage: "collector", causeCode: "UNKNOWN" } },
  );
  await assert.rejects(
    discovery(
      [{ path: "D:\\Portable\\Weixin\\Weixin.exe", source: "process", confidence: 30 }],
      "",
      { readMetadata: async () => { throw new Error("injected metadata failed"); } },
    ).discover(),
    { code: "WECHAT_DISCOVERY_FAILED", details: { stage: "metadata", causeCode: "UNKNOWN" } },
  );
});

test("skips candidates that disappear before identity validation", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const result = await discovery(
    [{ path: "D:\\Missing\\Weixin.exe", source: "registry", confidence: 20 }],
    "",
    { realpath: async () => { throw missing; }, readMetadata: async () => assert.fail("metadata should not run") },
  ).discover();
  assert.equal(result, null);
});

test("rejects realpath EACCES with stable sanitized discovery details", async () => {
  const denied = Object.assign(new Error("sensitive path must not leak"), { code: "EACCES" });
  await assert.rejects(
    discovery(
      [{ path: "D:\\Denied\\Weixin.exe", source: "process", confidence: 30 }],
      "",
      { realpath: async () => { throw denied; } },
    ).discover(),
    (error) => {
      assert.equal(error.code, "WECHAT_DISCOVERY_FAILED");
      assert.deepEqual(error.details, { stage: "realpath", causeCode: "EACCES" });
      assert.equal(JSON.stringify(error.details).includes("sensitive"), false);
      return true;
    },
  );
});

test("rejects stat EPERM with stable sanitized discovery details", async () => {
  const denied = Object.assign(new Error("private filename"), { code: "EPERM" });
  await assert.rejects(
    discovery(
      [{ path: "D:\\Denied\\Weixin.exe", source: "process", confidence: 30 }],
      "",
      { stat: async () => { throw denied; } },
    ).discover(),
    { code: "WECHAT_DISCOVERY_FAILED", details: { stage: "stat", causeCode: "EPERM" } },
  );
});

test("rejects malformed stat responses instead of treating them as candidates", async () => {
  for (const malformed of [{}, { isFile: () => "yes" }]) {
    await assert.rejects(
      discovery(
        [{ path: "D:\\Malformed\\Weixin.exe", source: "process", confidence: 30 }],
        "",
        { stat: async () => malformed },
      ).discover(),
      { code: "WECHAT_DISCOVERY_FAILED", details: { stage: "stat", causeCode: "INVALID_STAT" } },
    );
  }
});

test("does not select a lower-confidence candidate after a higher-confidence operational failure", async () => {
  const high = "D:\\High\\Weixin.exe";
  const low = "D:\\Low\\Weixin.exe";
  let metadataCalls = 0;
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  await assert.rejects(
    discovery(
      [
        { path: high, source: "process", confidence: 30 },
        { path: low, source: "registry", confidence: 20 },
      ],
      "",
      {
        realpath: async (value) => { if (value === high) throw denied; return value; },
        readMetadata: async () => { metadataCalls += 1; return { version: "4.1.10.27", productName: "Weixin" }; },
      },
    ).discover(),
    { code: "WECHAT_DISCOVERY_FAILED", details: { stage: "realpath", causeCode: "EACCES" } },
  );
  assert.equal(metadataCalls, 0);
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

test("rejects resolved relative paths before metadata inspection", async () => {
  let metadataCalls = 0;
  const result = await discovery(
    [{ path: "relative\\Weixin.exe", source: "registry", confidence: 20 }],
    "",
    { readMetadata: async () => { metadataCalls += 1; return { version: "4.1.10.27", productName: "Weixin" }; } },
  ).discover();
  assert.equal(result, null);
  assert.equal(metadataCalls, 0);
});

test("rejects non-file candidates before metadata inspection", async () => {
  let metadataCalls = 0;
  const result = await discovery(
    [{ path: "D:\\Portable\\Weixin\\Weixin.exe", source: "registry", confidence: 20 }],
    "",
    {
      stat: async () => ({ isFile: () => false }),
      readMetadata: async () => { metadataCalls += 1; return { version: "4.1.10.27", productName: "Weixin" }; },
    },
  ).discover();
  assert.equal(result, null);
  assert.equal(metadataCalls, 0);
});

test("requires an exact four-part 4.x file version", async () => {
  for (const version of ["4.1.10", "4.1.10.27.1", "4.1.x.27", "4.1.10.", "4. 1.10.27"]) {
    const result = await discovery(
      [{ path: "D:\\Portable\\Weixin\\Weixin.exe", source: "registry", confidence: 20 }],
      "",
      { readMetadata: async () => ({ version, productName: "Weixin" }) },
    ).discover();
    assert.equal(result, null, version);
  }
});

test("uses a narrow product allowlist and rejects related Tencent products", async () => {
  for (const productName of ["企业微信", "WeCom", "WXWork", "微信输入法", "Weixin Helper", "WeChat Beta"]) {
    const result = await discovery(
      [{ path: "D:\\Portable\\Weixin\\Weixin.exe", source: "registry", confidence: 20 }],
      "",
      { readMetadata: async () => ({ version: "4.1.10.27", productName }) },
    ).discover();
    assert.equal(result, null, productName);
  }
  for (const productName of ["微信", "微信电脑版", "Weixin", "WeChat", " weixin "]) {
    const result = await discovery(
      [{ path: "D:\\Portable\\Weixin\\Weixin.exe", source: "registry", confidence: 20 }],
      "",
      { readMetadata: async () => ({ version: "4.1.10.27", productName }) },
    ).discover();
    assert.equal(result.productName, productName);
  }
});

test("deduplicates resolved paths before stat and metadata while aggregating sources", async () => {
  const canonical = "D:\\Portable\\Weixin\\Weixin.exe";
  let statCalls = 0;
  let metadataCalls = 0;
  const result = await discovery(
    [
      { path: "D:\\Alias\\Registry.exe", source: "registry", confidence: 20 },
      { path: "D:\\Alias\\Fallback.exe", source: "fallback", confidence: 10 },
      { path: "D:\\Alias\\Process.exe", source: "process", confidence: 30 },
    ],
    "",
    {
      realpath: async () => canonical,
      stat: async () => { statCalls += 1; return { isFile: () => true }; },
      readMetadata: async () => { metadataCalls += 1; return { version: "4.1.12.26", productName: "Weixin" }; },
    },
  ).discover();
  assert.equal(result.executable, canonical);
  assert.equal(result.source, "process");
  assert.equal(result.confidence, 30);
  assert.deepEqual(new Set(result.sources), new Set(["registry", "fallback", "process"]));
  assert.equal(statCalls, 1);
  assert.equal(metadataCalls, 1);
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
