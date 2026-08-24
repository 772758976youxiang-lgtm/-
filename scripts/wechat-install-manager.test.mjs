import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createWechatInstallManager, runElevatedWechatHelper } from "../wechat-install-manager.mjs";

const oldSnapshot = { executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" };
const targetInstall = { executable: "E:\\Tencent\\Weixin\\Weixin.exe", installRoot: "E:\\Tencent\\Weixin", version: "4.1.10.27" };

function fixture(overrides = {}) {
  const phases = [];
  let cleaned = 0;
  const manager = createWechatInstallManager({
    discovery: { discover: async () => targetInstall },
    artifact: {
      download: async (_policy, progress) => { progress(25); return { directory: "D:\\Temp\\wechat-job", file: "D:\\Temp\\wechat-job\\installer.exe" }; },
      verifyFile: async () => {},
      cleanup: async () => { cleaned += 1; },
    },
    confirmationStore: { consume: (token, snapshot) => { assert.equal(token, "token"); assert.deepEqual(snapshot, oldSnapshot); } },
    runElevatedHelper: async ({ onPhase }) => { onPhase("installing"); return { ok: true, version: "4.1.10.27", updateSuppressed: true }; },
    verifySuppression: async () => true,
    phaseListener: (phase) => phases.push(phase),
    ...overrides,
  });
  return { manager, phases, cleaned: () => cleaned };
}

test("runs one confirmed job and exposes only safe progress", async () => {
  const value = fixture();
  const installed = await value.manager.start("token", oldSnapshot);
  assert.deepEqual(installed, targetInstall);
  assert.deepEqual(value.phases, ["downloading", "verifying", "requesting_admin", "installing", "verifying_install", "ready"]);
  assert.deepEqual(value.manager.status(), { phase: "ready", progress: null, errorCode: null, error: "" });
  assert.equal(value.manager.status().installerPath, undefined);
  assert.equal(value.cleaned(), 1);
});

test("rejects concurrent jobs and records a stable failure", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const value = fixture({
    artifact: {
      download: async () => pending,
      verifyFile: async () => {},
      cleanup: async () => {},
    },
  });
  const first = value.manager.start("token", oldSnapshot);
  assert.throws(() => value.manager.start("token", oldSnapshot), { code: "INSTALL_ALREADY_RUNNING" });
  release({ directory: "D:\\Temp\\wechat-job", file: "D:\\Temp\\wechat-job\\installer.exe" });
  await first;

  const failed = fixture({ runElevatedHelper: async () => ({ ok: false, code: "UAC_CANCELLED", message: "用户取消了管理员授权" }) });
  await assert.rejects(failed.manager.start("token", oldSnapshot), { code: "UAC_CANCELLED" });
  assert.equal(failed.manager.status().phase, "failed");
  assert.equal(failed.manager.status().errorCode, "UAC_CANCELLED");
});

test("fails closed when post-install version or update suppression is wrong", async () => {
  const wrongVersion = fixture({ discovery: { discover: async () => ({ ...targetInstall, version: "4.1.10.31" }) } });
  await assert.rejects(wrongVersion.manager.start("token", oldSnapshot), { code: "POST_INSTALL_VERSION_MISMATCH" });

  const updaterActive = fixture({ verifySuppression: async () => false });
  await assert.rejects(updaterActive.manager.start("token", oldSnapshot), { code: "UPDATE_SUPPRESSION_FAILED" });
});

test("preserves a structured elevated-helper failure and distinguishes UAC cancellation", async () => {
  const helperFailure = await runElevatedWechatHelper({
    installer: "D:\\Temp\\installer.exe",
    captureImpl: async (_command, args) => {
      const operationPath = args.at(-1);
      const operation = JSON.parse(await fs.readFile(operationPath, "utf8"));
      await fs.writeFile(operation.resultPath, JSON.stringify({ ok: false, code: "UPDATE_SUPPRESSION_FAILED", message: "更新关闭失败" }));
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(helperFailure, { ok: false, code: "UPDATE_SUPPRESSION_FAILED", message: "更新关闭失败" });

  await assert.rejects(runElevatedWechatHelper({
    installer: "D:\\Temp\\installer.exe",
    captureImpl: async () => ({ code: 1223, stdout: "", stderr: "UAC_CANCELLED" }),
  }), { code: "UAC_CANCELLED" });
});

test("does not report ready when the temporary installer cannot be cleaned", async () => {
  const value = fixture({
    artifact: {
      download: async () => ({ directory: "D:\\Temp\\wechat-job", file: "D:\\Temp\\wechat-job\\installer.exe" }),
      verifyFile: async () => {},
      cleanup: async () => { throw new Error("locked"); },
    },
  });
  await assert.rejects(value.manager.start("token", oldSnapshot), { code: "INSTALLER_CLEANUP_FAILED" });
  assert.equal(value.manager.status().phase, "failed");
});
