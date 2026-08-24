import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDefaultCandidates,
  createWechatDiscovery,
  readDefaultMetadata,
} from "../wechat-windows-discovery.mjs";

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

test("collects UTF-8 candidate paths from PowerShell", async () => {
  const expected = [{ path: "D:\\便携微信\\Weixin.exe", source: "process", confidence: 30 }];
  let invocation;
  const candidates = await collectDefaultCandidates({
    env: {},
    runPowerShell: async (command, args) => {
      invocation = { command, args };
      return JSON.stringify(expected[0]);
    },
  });

  assert.deepEqual(candidates, expected);
  assert.equal(invocation.command, "powershell.exe");
  assert.match(invocation.args[3], /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
});

test("passes a spaced executable as a separate PowerShell argument", async () => {
  const executable = "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe";
  let invocation;
  const info = await readDefaultMetadata(executable, async (command, args) => {
    invocation = { command, args };
    return JSON.stringify({ version: "4.1.12.26", productName: "Weixin" });
  });

  assert.deepEqual(info, { version: "4.1.12.26", productName: "Weixin" });
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.args[3], invocation.args[3].trim());
  assert.match(invocation.args[3], /\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.equal(invocation.args[3].includes(executable), false);
  assert.equal(invocation.args[4], `"${executable}"`);
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
