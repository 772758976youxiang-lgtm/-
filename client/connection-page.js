/**
 * dsh-channel-im · 「连接」设置页（external-connections）源码（可读参考版）
 *
 * 这是注入到 DSH 设置面板的【连接】页组件（读取桥接状态文件并 5 秒轮询）。
 * 发布时对应 lib/client.js 的原生 dsh.client 模块，不再修改官方设置包。
 * node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js。
 *
 * 需配合：
 *  - locale 键：settings.external.nav / .title / .intro（zh + en）
 *  - 注册：settings.section slot，id="external-connections"，order 20，inject 提供 readStatus
 */

/**
 * @param {{ t: Function, readStatus: Function, readWechat: Function, toggleWechat: Function, installWechat: Function }} props
 */
export default function ConnectionSection({ t, readStatus, readWechat, toggleWechat, installWechat }) {
  const [items, setItems] = React.useState([]);
  const [wechat, setWechat] = React.useState({ supported: true, enabled: false, phase: "disabled" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [confirmation, setConfirmation] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [list, nextWechat] = await Promise.all([readStatus(), readWechat()]);
        if (alive && Array.isArray(list)) setItems(list);
        if (alive && nextWechat) setWechat(nextWechat);
      } catch {}
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [readStatus, readWechat]);

  const changeWechat = async () => {
    if (busy || wechat.supported === false) return;
    setBusy(true); setError("");
    try {
      const next = await toggleWechat(!wechat.enabled);
      setWechat(next);
      if (next.code === "WECHAT_VERSION_REQUIRED") setConfirmation(next);
    }
    catch (reason) { setError(reason?.message ?? String(reason)); }
    finally { setBusy(false); }
  };
  const confirmInstall = async () => {
    if (!confirmation?.confirmationToken) return;
    setBusy(true); setError("");
    try {
      setWechat(await installWechat(confirmation.confirmationToken));
      setConfirmation(null);
    } catch (reason) { setError(reason?.message ?? String(reason)); }
    finally { setBusy(false); }
  };
  const cancelInstall = () => {
    setConfirmation(null);
    setError(t("wechat.riskWarning"));
  };
  const shown = items.filter((c) => c.status === "connected" && c.mode !== "wechat_pc");
  const rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "16px 20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)", marginBottom: "12px" };
  const dot = () => <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", marginLeft: "8px" }} />;
  const installActive = ["downloading", "verifying", "requesting_admin", "installing", "verifying_install"].includes(wechat.phase);
  const phaseText = installActive ? t(`wechat.${wechat.phase}`) : wechat.phase === "connected" ? t("wechat.connected") : wechat.phase === "waiting_for_scan" ? t("wechat.waiting") : wechat.phase === "starting" ? t("wechat.starting") : wechat.phase === "failed" ? t("wechat.failed") : t("wechat.disabled");
  const phaseColor = wechat.phase === "connected" ? "var(--dsw-alias-state-success-primary)" : wechat.enabled ? "var(--dsw-alias-state-warning-primary, #d97706)" : "var(--dsw-alias-label-tertiary)";

  return (
    <div>
      <h1 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }}>{t("title")}</h1>
      <p style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: "14px", lineHeight: "22px", margin: "0 0 24px" }}>{t("intro")}</p>
      <div style={rowStyle}>
        <div style={{ flex: "1", minWidth: "0" }}>
          <div style={{ fontWeight: "600", fontSize: "15px", display: "flex", alignItems: "center", gap: "8px" }}>
            {t("wechat.name")}<span style={{ fontSize: "12px", color: phaseColor }}>{busy ? t("wechat.processing") : phaseText}</span>
          </div>
          <div style={{ fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary)", marginTop: "4px", lineHeight: "19px" }}>
            {wechat.supported === false ? t("wechat.windowsOnly") : wechat.phase === "connected" ? `${wechat.account?.nickname ? `${wechat.account.nickname} · ` : ""}${t("wechat.details")}` : wechat.enabled ? t("wechat.waitingHint") : t("wechat.disabledHint")}
          </div>
          {(error || wechat.error) && <div role="alert" style={{ fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #dc2626)", marginTop: "6px" }}>{error || wechat.error}</div>}
        </div>
        <button type="button" role="switch" aria-label={t("wechat.aria")} aria-checked={!!wechat.enabled} disabled={busy || installActive || wechat.supported === false} onClick={changeWechat}
          style={{ width: "44px", height: "24px", padding: "2px", border: 0, borderRadius: "999px", cursor: busy || installActive || wechat.supported === false ? "not-allowed" : "pointer", opacity: busy || installActive ? 0.65 : 1, background: wechat.enabled ? "var(--dsw-alias-brand-primary, #4f6ef7)" : "var(--dsw-alias-fill-secondary, #aeb4bf)" }}>
          <span style={{ display: "block", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transform: wechat.enabled ? "translateX(20px)" : "translateX(0)", transition: "transform .18s ease", boxShadow: "0 1px 3px rgba(0,0,0,.25)" }} />
        </button>
      </div>
      {confirmation && (
        <div role="dialog" aria-modal="true" aria-label={t("wechat.versionTitle")} style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", background: "rgba(0,0,0,.45)" }}>
          <div style={{ width: "min(440px, 100%)", padding: "22px", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1, #fff)", boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
            <h2 style={{ margin: "0 0 12px", fontSize: "17px" }}>{t("wechat.versionTitle")}</h2>
            <p style={{ margin: "0 0 18px", fontSize: "14px", lineHeight: "22px" }}>{t("wechat.versionPrompt").replace("{current}", confirmation.installedVersion || t("wechat.notFound"))}</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button type="button" onClick={cancelInstall}>{t("wechat.cancelInstall")}</button>
              <button type="button" disabled={busy} onClick={confirmInstall}>{t("wechat.installTarget")}</button>
            </div>
          </div>
        </div>
      )}
      {shown.length === 0
        ? null
        : shown.map((c) => (
            <div key={c.id} style={rowStyle}>
              <div style={{ flex: "1", minWidth: "0" }}>
                <div style={{ fontWeight: "600", fontSize: "15px", display: "flex", alignItems: "center", gap: "8px" }}>
                  {c.name}{dot()}<span style={{ fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" }}>已连接</span>
                </div>
                <div style={{ fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary)", marginTop: "2px" }}>
                  {c.mode === "stream" ? "Stream 模式 · 无需公网" : c.mode === "wechat_pc" ? "微信 PC · 数据库接收 · Hook/UIA/OCR 发送" : (c.mode ?? "")}
                </div>
              </div>
            </div>
          ))}
    </div>
  );
}

/* locale（settings 命名空间，zh + en）：
   zh: external.nav="连接" external.title="连接" external.intro="IM 通道由 Harness 统一管理，以下为当前已接入的通道及其连接状态。"
   en: external.nav="Connections" external.title="Connections" external.intro="IM channels are managed by Harness. Below are the currently connected channels and their status."
*/
