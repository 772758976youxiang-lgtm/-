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
 * @param {{ t: Function, readStatus: () => Promise<Array<{id:string,name:string,mode:string,status:string}>> }} props
 */
export default function ConnectionSection({ t, readStatus }) {
  const [items, setItems] = React.useState([]);
  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await readStatus();
        if (alive && Array.isArray(list)) setItems(list);
      } catch {}
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [readStatus]);

  const shown = items.filter((c) => c.status === "connected");
  const rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "16px 20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)", marginBottom: "12px" };
  const dot = () => <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", marginLeft: "8px" }} />;

  return (
    <div className={styles.section}>
      <h1 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }}>{t("external.title")}</h1>
      <p style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: "14px", lineHeight: "22px", margin: "0 0 24px" }}>{t("external.intro")}</p>
      {shown.length === 0
        ? <div style={{ color: "var(--dsw-alias-label-tertiary)", fontSize: "13px" }}>暂无已连接的 IM 通道。</div>
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
