import { TARGET_WECHAT, isTargetWechatVersion } from "./wechat-version-policy.mjs";

const RISK_WARNING = "继续使用其他版本可能导致兼容异常，并增加账号封禁风险。";

export function createWechatChannelController({
  discovery,
  confirmationStore,
  installManager,
  readEnabled,
  persistEnabled,
  stopChannel,
  launchChannel,
  supported = process.platform === "win32",
} = {}) {
  let installCompletion = null;
  let intentGeneration = 0;

  const inspect = async () => supported ? await discovery.discover() : null;

  async function status() {
    const installed = await inspect();
    const enabled = Boolean(await readEnabled());
    return {
      ok: true,
      supported,
      enabled,
      installedVersion: installed?.version || null,
      executable: installed?.executable || null,
      targetVersion: TARGET_WECHAT.version,
      versionCompatible: Boolean(installed && isTargetWechatVersion(installed.version)),
      install: installManager.status(),
    };
  }

  async function toggle(enabled) {
    const generation = ++intentGeneration;
    if (!enabled) {
      await stopChannel();
      await persistEnabled(false);
      return { httpStatus: 200, body: await status() };
    }
    await stopChannel();
    await persistEnabled(false);
    const installed = await inspect();
    if (!installed || !isTargetWechatVersion(installed.version)) {
      const snapshot = installed || {};
      return {
        httpStatus: 409,
        body: {
          ...(await status()),
          ok: false,
          code: "WECHAT_VERSION_REQUIRED",
          installedVersion: installed?.version || null,
          confirmationToken: confirmationStore.issue(snapshot),
          riskWarning: RISK_WARNING,
        },
      };
    }
    try {
      await launchChannel(installed.executable);
      if (generation !== intentGeneration) {
        await stopChannel();
        await persistEnabled(false);
        return { httpStatus: 200, body: await status() };
      }
      await persistEnabled(true);
    } catch (error) {
      await persistEnabled(false);
      throw error;
    }
    return { httpStatus: 200, body: await status() };
  }

  async function beginInstall(confirmationToken) {
    const generation = ++intentGeneration;
    const installed = await inspect();
    await stopChannel();
    await persistEnabled(false);
    const job = installManager.start(confirmationToken, installed || {});
    installCompletion = Promise.resolve(job).then(async (result) => {
      if (generation !== intentGeneration) return result;
      await launchChannel(result.executable);
      if (generation !== intentGeneration) {
        await stopChannel();
        await persistEnabled(false);
        return result;
      }
      await persistEnabled(true);
      return result;
    }).catch(async (error) => {
      if (generation === intentGeneration) {
        await stopChannel();
        await persistEnabled(false);
      }
      throw error;
    });
    installCompletion.catch(() => {});
    return { httpStatus: 202, body: { ...(await status()), accepted: true } };
  }

  async function reconcileStartup({ cancelPendingOnDisabled = false } = {}) {
    if (!(await readEnabled())) {
      if (cancelPendingOnDisabled) {
        intentGeneration += 1;
        await stopChannel();
      }
      return { disabled: false, authorized: false };
    }
    let installed;
    try { installed = await inspect(); }
    catch (error) {
      await stopChannel();
      await persistEnabled(false);
      return { disabled: true, authorized: false, error };
    }
    if (installed && isTargetWechatVersion(installed.version)) return { disabled: false, authorized: true, installed };
    await stopChannel();
    await persistEnabled(false);
    return { disabled: true, authorized: false, installedVersion: installed?.version || null, targetVersion: TARGET_WECHAT.version };
  }

  return {
    status,
    toggle,
    beginInstall,
    reconcileStartup,
    waitForInstall: () => installCompletion || Promise.resolve(null),
  };
}
