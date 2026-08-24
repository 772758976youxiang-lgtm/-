import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TARGET_WECHAT, WechatControlError, isTargetWechatVersion } from "./wechat-version-policy.mjs";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WECHAT_INSTALL_STATE = path.join(os.homedir(), ".dsh", "wechat-install-state.json");

const safeStatus = (state) => ({ phase: state.phase, progress: state.progress, errorCode: state.errorCode, error: state.error });

const asControlError = (error, fallbackCode = "INSTALL_FAILED") => error instanceof WechatControlError
  ? error
  : new WechatControlError(fallbackCode, error?.message || String(error));

export function createWechatInstallManager({
  discovery,
  artifact,
  confirmationStore,
  runElevatedHelper,
  verifySuppression,
  phaseListener = () => {},
} = {}) {
  let state = { phase: "idle", progress: null, errorCode: null, error: "" };
  let active = null;

  const setPhase = (phase, progress = null) => {
    state = { phase, progress, errorCode: null, error: "" };
    phaseListener(phase);
  };

  function start(token, observedSnapshot) {
    if (active) throw new WechatControlError("INSTALL_ALREADY_RUNNING", "微信安装任务正在进行中");
    confirmationStore.consume(token, observedSnapshot);
    active = (async () => {
      let downloaded;
      try {
        setPhase("downloading", 0);
        downloaded = await artifact.download(TARGET_WECHAT, (progress) => {
          state = { ...state, progress: Number.isFinite(progress) ? progress : null };
        });
        setPhase("verifying");
        await artifact.verifyFile(downloaded.file, TARGET_WECHAT, { allocationDirectory: downloaded.directory });
        setPhase("requesting_admin");
        const helper = await runElevatedHelper({
          installer: downloaded.file,
          target: TARGET_WECHAT,
          onPhase: (phase) => setPhase(phase),
        });
        if (!helper?.ok) {
          throw new WechatControlError(helper?.code || "INSTALL_FAILED", helper?.message || "微信安装失败");
        }
        setPhase("verifying_install");
        const installed = await discovery.discover();
        if (!installed || !isTargetWechatVersion(installed.version)) {
          throw new WechatControlError("POST_INSTALL_VERSION_MISMATCH", "安装后微信版本仍不是 4.1.10.27");
        }
        if (!helper.updateSuppressed || !(await verifySuppression(installed, helper))) {
          throw new WechatControlError("UPDATE_SUPPRESSION_FAILED", "微信自动更新未能关闭");
        }
        setPhase("ready");
        return installed;
      } catch (cause) {
        const error = asControlError(cause);
        state = { phase: "failed", progress: null, errorCode: error.code, error: error.message };
        throw error;
      } finally {
        let cleanupFailure = null;
        if (downloaded?.directory) {
          try { await artifact.cleanup(downloaded.directory); }
          catch (cleanupError) {
            if (state.phase !== "failed") {
              const error = asControlError(cleanupError, "INSTALLER_CLEANUP_FAILED");
              state = { phase: "failed", progress: null, errorCode: error.code, error: error.message };
              cleanupFailure = error;
            }
          }
        }
        active = null;
        if (cleanupFailure) throw cleanupFailure;
      }
    })();
    return active;
  }

  return { start, status: () => safeStatus(state) };
}

function capture(command, args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (error, code = -1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (value) => { if (stdout.length < 65536) stdout += value; });
    child.stderr.on("data", (value) => { if (stderr.length < 65536) stderr += value; });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(null, Number(code ?? -1)));
    timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(new WechatControlError("INSTALL_FAILED", "微信安装等待超时"));
    }, timeoutMs);
  });
}

export async function runElevatedWechatHelper({
  installer,
  target = TARGET_WECHAT,
  onPhase = () => {},
  statePath = DEFAULT_WECHAT_INSTALL_STATE,
  helperPath = path.join(moduleRoot, "scripts", "wechat-install-helper.ps1"),
  launcherPath = path.join(moduleRoot, "scripts", "wechat-elevate.ps1"),
  captureImpl = capture,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-wechat-operation-"));
  const operationPath = path.join(directory, "operation.json");
  const resultPath = path.join(directory, "result.json");
  try {
    await fs.writeFile(operationPath, JSON.stringify({ installer, resultPath, statePath, target }), { encoding: "utf8", mode: 0o600 });
    onPhase("installing");
    const result = await captureImpl("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
      "-HelperPath", helperPath, "-OperationPath", operationPath,
    ]);
    let parsed;
    try { parsed = JSON.parse((await fs.readFile(resultPath, "utf8")).replace(/^\uFEFF/, "")); }
    catch {}
    if (parsed && typeof parsed.ok === "boolean") return parsed;
    if (result.code !== 0) {
      const cancelled = result.code === 1223 || /1223|cancel|取消/i.test(`${result.stdout}\n${result.stderr}`);
      throw new WechatControlError(cancelled ? "UAC_CANCELLED" : "INSTALL_FAILED", cancelled ? "用户取消了管理员授权" : "微信安装助手启动失败");
    }
    throw new WechatControlError("INSTALL_FAILED", "微信安装助手未返回有效结果");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function verifyWechatUpdateSuppression(installed, _helper, { statePath = DEFAULT_WECHAT_INSTALL_STATE } = {}) {
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, "utf8")); }
  catch { return false; }
  const root = path.win32.normalize(installed.installRoot || path.win32.dirname(installed.executable)).toLowerCase();
  if (String(state.version) !== TARGET_WECHAT.version || path.win32.normalize(String(state.installRoot || "")).toLowerCase() !== root) return false;
  if (!Array.isArray(state.updaters) || state.updaters.length === 0) return false;
  for (const record of state.updaters) {
    const original = path.win32.normalize(String(record.original || ""));
    const backup = path.win32.normalize(String(record.backup || ""));
    if (!original.toLowerCase().startsWith(`${root}\\`) || !backup.toLowerCase().startsWith(`${root}\\`)) return false;
    try { await fs.access(backup); } catch { return false; }
    try { await fs.access(original); return false; } catch {}
  }
  return true;
}
