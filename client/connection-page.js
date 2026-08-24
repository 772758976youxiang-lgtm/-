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
 * @param {{ t: Function, readStatus: Function, readWechat: Function, toggleWechat: Function }} props
 */
export default function ConnectionSection({ t, readStatus, readWechat, toggleWechat, readRules, saveRules, readContacts }) {
  const [items, setItems] = React.useState([]);
  const [wechat, setWechat] = React.useState({ supported: true, enabled: false, phase: "disabled" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [rulesOpen, setRulesOpen] = React.useState(false);
  const [rules, setRules] = React.useState({ direct_message: "allow", group_message: "allow", direct_whitelist: [], direct_blacklist: [], group_whitelist: [], group_blacklist: [], group_reply_only_when_mentioned_groups: [] });
  const [contacts, setContacts] = React.useState([]);
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [list, nextWechat] = await Promise.all([readStatus(), readWechat()]);
        if (alive && Array.isArray(list)) setItems(list);
        if (alive && nextWechat) setWechat(nextWechat);
        const nextRules = await readRules(); if (alive && nextRules?.policy) setRules((old) => ({ ...old, ...nextRules.policy }));
      } catch {}
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [readStatus, readWechat]);
  React.useEffect(() => { if (!rulesOpen) return; readContacts().then((v) => setContacts(v?.items || [])); }, [rulesOpen]);
  const persistRules = async (next) => { setRules(next); const saved = await saveRules(next); if (saved?.policy) setRules((old) => ({ ...old, ...saved.policy })); };
  const setMember = (type, id, action) => { const white = `${type}_whitelist`, black = `${type}_blacklist`; const next = { ...rules, [white]: (rules[white] || []).filter((x) => x !== id), [black]: (rules[black] || []).filter((x) => x !== id) }; if (action === "white") next[white].push(id); if (action === "black") next[black].push(id); persistRules(next).catch((e) => setError(String(e))); };
  const setGroupMention = (id, enabled) => { const next = { ...rules, group_reply_only_when_mentioned_groups: (rules.group_reply_only_when_mentioned_groups || []).filter((x) => x !== id) }; if (enabled) next.group_reply_only_when_mentioned_groups.push(id); persistRules(next).catch((e) => setError(String(e))); };

  const changeWechat = async () => {
    if (busy || wechat.supported === false) return;
    setBusy(true); setError("");
    try { setWechat(await toggleWechat(!wechat.enabled)); }
    catch (reason) { setError(reason?.message ?? String(reason)); }
    finally { setBusy(false); }
  };
  const shown = items.filter((c) => c.status === "connected" && c.mode !== "wechat_pc");
  const rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "16px 20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)", marginBottom: "12px" };
  const dot = () => <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", marginLeft: "8px" }} />;
  const phaseText = wechat.phase === "connected" ? t("wechat.connected") : wechat.phase === "waiting_for_scan" ? t("wechat.waiting") : wechat.phase === "starting" ? t("wechat.starting") : t("wechat.disabled");
  const phaseColor = wechat.phase === "connected" ? "var(--dsw-alias-state-success-primary)" : wechat.enabled ? "var(--dsw-alias-state-warning-primary, #d97706)" : "var(--dsw-alias-label-tertiary)";
  const rulesCardStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", overflow: "hidden", marginBottom: "12px", background: "var(--dsw-alias-bg-layer-1)" };
  const selectStyle = { height: "32px", padding: "0 28px 0 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", fontSize: "13px" };
  const actionStyle = { height: "28px", padding: "0 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "7px", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: "12px", whiteSpace: "nowrap" };
  const selectedActionStyle = { ...actionStyle, border: "1px solid var(--dsw-alias-brand-primary, #4f6ef7)", background: "var(--dsw-alias-brand-secondary, rgba(79,110,247,.1))", color: "var(--dsw-alias-brand-primary, #4f6ef7)" };

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
        <button type="button" role="switch" aria-label={t("wechat.aria")} aria-checked={!!wechat.enabled} disabled={busy || wechat.supported === false} onClick={changeWechat}
          style={{ width: "44px", height: "24px", padding: "2px", border: 0, borderRadius: "999px", cursor: busy || wechat.supported === false ? "not-allowed" : "pointer", opacity: busy ? 0.65 : 1, background: wechat.enabled ? "var(--dsw-alias-brand-primary, #4f6ef7)" : "var(--dsw-alias-fill-secondary, #aeb4bf)" }}>
          <span style={{ display: "block", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transform: wechat.enabled ? "translateX(20px)" : "translateX(0)", transition: "transform .18s ease", boxShadow: "0 1px 3px rgba(0,0,0,.25)" }} />
        </button>
      </div>
      <div style={rulesCardStyle}>
        <button type="button" onClick={() => setRulesOpen(!rulesOpen)} style={{ width: "100%", minHeight: "48px", border: 0, background: "transparent", padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", color: "var(--dsw-alias-label-primary)", fontWeight: 600, fontSize: "14px" }}><span>群聊与联系人规则</span><span style={{ color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, fontSize: "13px" }}>{rulesOpen ? "收起" : "展开"}</span></button>
        {rulesOpen && <div style={{ padding: "4px 16px 16px", borderTop: "1px solid var(--dsw-alias-border-l2)" }}>
          <p style={{ fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)", margin: "12px 0" }}>黑名单优先于白名单。群聊上下文由通道后台保存最近 200 条，不在此设置面板展示。</p>
          <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", paddingBottom: "14px", borderBottom: "1px solid var(--dsw-alias-border-l2)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }}>群聊规则 <select style={selectStyle} value={rules.group_message} onChange={(e) => persistRules({ ...rules, group_message: e.target.value })}><option value="allow">允许全部</option><option value="whitelist">仅白名单</option><option value="deny">全部拦截</option></select></label>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }}>联系人规则 <select style={selectStyle} value={rules.direct_message} onChange={(e) => persistRules({ ...rules, direct_message: e.target.value })}><option value="allow">允许全部</option><option value="whitelist">仅白名单</option><option value="deny">全部拦截</option></select></label>
          </div>
          {["group", "direct"].map((kind) => <section key={kind} style={{ marginTop: "16px" }}><div style={{ color: "var(--dsw-alias-label-primary)", fontWeight: 600, fontSize: "13px", marginBottom: "6px" }}>{kind === "group" ? "群聊列表" : "联系人列表"}</div>{contacts.filter((c) => c.type === kind).map((c) => { const white = (rules[`${kind}_whitelist`] || []).includes(c.id), black = (rules[`${kind}_blacklist`] || []).includes(c.id); return <div key={c.id} style={{ display: "flex", gap: "8px", padding: "10px 0", fontSize: "13px", alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--dsw-alias-border-l2)" }}><div style={{ flex: 1, minWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span style={{ color: "var(--dsw-alias-label-primary)" }}>{c.remark || c.nickname || c.name || c.id}</span><span style={{ color: "var(--dsw-alias-label-tertiary)" }}> · {c.id}</span></div>{kind === "group" && <label style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" }}><input type="checkbox" checked={(rules.group_reply_only_when_mentioned_groups || []).includes(c.id)} onChange={(e) => setGroupMention(c.id, e.target.checked)} />仅 @AI 回复</label>}<button style={white ? selectedActionStyle : actionStyle} onClick={() => setMember(kind, c.id, "white")}>白名单</button><button style={black ? selectedActionStyle : actionStyle} onClick={() => setMember(kind, c.id, "black")}>黑名单</button><button style={actionStyle} onClick={() => setMember(kind, c.id, "clear")}>清除</button></div>; })}</section>)}
        </div>}
      </div>
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
