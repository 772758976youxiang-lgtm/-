import assert from "node:assert/strict";
import test from "node:test";
import { createWechatChannelController } from "../wechat-channel-controller.mjs";

const oldWechat = { executable: "D:\\Apps\\Weixin\\Weixin.exe", installRoot: "D:\\Apps\\Weixin", version: "4.1.12.26" };
const targetWechat = { ...oldWechat, version: "4.1.10.27" };

function fixture({ installed = oldWechat, installResult = targetWechat, installFailure, initiallyEnabled = false } = {}) {
  let enabled = initiallyEnabled;
  let stopped = 0;
  const launched = [];
  const issued = [];
  let resolveInstall;
  let rejectInstall;
  const pending = new Promise((resolve, reject) => { resolveInstall = resolve; rejectInstall = reject; });
  const controller = createWechatChannelController({
    discovery: { discover: async () => installed },
    confirmationStore: { issue: (snapshot) => { issued.push(snapshot); return "confirmation-token"; } },
    installManager: {
      start: (_token, _snapshot) => installFailure ? Promise.reject(installFailure) : pending,
      status: () => ({ phase: "idle", progress: null, errorCode: null, error: "" }),
    },
    readEnabled: async () => enabled,
    persistEnabled: async (value) => { enabled = value; },
    stopChannel: async () => { stopped += 1; },
    launchChannel: async (executable) => { launched.push(executable); },
  });
  return { controller, enabled: () => enabled, stopped: () => stopped, launched, issued, finish: () => resolveInstall(installResult), fail: (error) => rejectInstall(error) };
}

test("enables immediately only when the exact WeChat version is installed", async () => {
  const value = fixture({ installed: targetWechat });
  const response = await value.controller.toggle(true);
  assert.equal(response.httpStatus, 200);
  assert.equal(value.enabled(), true);
  assert.deepEqual(value.launched, [targetWechat.executable]);
  assert.equal(response.body.versionCompatible, true);
});

test("keeps the switch off and requests one confirmation for a mismatched version", async () => {
  const value = fixture();
  const response = await value.controller.toggle(true);
  assert.equal(response.httpStatus, 409);
  assert.equal(response.body.code, "WECHAT_VERSION_REQUIRED");
  assert.equal(response.body.confirmationToken, "confirmation-token");
  assert.equal(response.body.installedVersion, "4.1.12.26");
  assert.match(response.body.riskWarning, /封禁风险/);
  assert.equal(value.enabled(), false);
  assert.deepEqual(value.issued, [oldWechat]);
});

test("enables only after a confirmed installation completes", async () => {
  const value = fixture();
  const accepted = await value.controller.beginInstall("confirmation-token");
  assert.equal(accepted.httpStatus, 202);
  assert.equal(value.enabled(), false);
  value.finish();
  await value.controller.waitForInstall();
  assert.equal(value.enabled(), true);
  assert.deepEqual(value.launched, [targetWechat.executable]);
});

test("installation failure and startup mismatch both fail closed", async () => {
  const failed = fixture({ installFailure: Object.assign(new Error("cancelled"), { code: "UAC_CANCELLED" }) });
  await failed.controller.beginInstall("confirmation-token");
  await assert.rejects(failed.controller.waitForInstall(), { code: "UAC_CANCELLED" });
  assert.equal(failed.enabled(), false);

  const startup = fixture({ initiallyEnabled: true });
  const result = await startup.controller.reconcileStartup();
  assert.equal(result.disabled, true);
  assert.equal(startup.enabled(), false);
  assert.equal(startup.stopped(), 1);
});

test("a disable request made during installation is never overwritten", async () => {
  const value = fixture();
  await value.controller.beginInstall("confirmation-token");
  await value.controller.toggle(false);
  value.finish();
  await value.controller.waitForInstall();
  assert.equal(value.enabled(), false);
  assert.deepEqual(value.launched, []);
});

test("an external config disable invalidates an active install intent", async () => {
  const value = fixture();
  await value.controller.beginInstall("confirmation-token");
  await value.controller.reconcileStartup({ cancelPendingOnDisabled: true });
  value.finish();
  await value.controller.waitForInstall();
  assert.equal(value.enabled(), false);
  assert.deepEqual(value.launched, []);
});
