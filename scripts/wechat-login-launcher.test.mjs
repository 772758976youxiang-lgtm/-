import assert from "node:assert/strict";
import test from "node:test";
import { createWechatLoginLauncher } from "../wechat-login-launcher.mjs";

test("launches a new Weixin instance without terminating existing processes", () => {
  const calls = [];
  let unrefCalled = false;
  const launcher = createWechatLoginLauncher({
    platform: "win32",
    spawnProcess: (...args) => {
      calls.push(args);
      return { unref: () => { unrefCalled = true; } };
    },
  });

  assert.equal(launcher.launch("C:\\Program Files\\Tencent\\Weixin\\Weixin.exe"), "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe");
  assert.deepEqual(calls, [[
    "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe",
    [],
    { detached: true, stdio: "ignore", windowsHide: false, shell: false },
  ]]);
  assert.equal(unrefCalled, true);
});
