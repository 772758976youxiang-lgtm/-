/**
 * dsh-channel-im · 「外部打开」按钮源码（可读参考版）
 *
 * 在 DSH 会话详情面板（DetailsPanel）头部、标题右侧增加“外部打开”按钮，
 * 点击调用 openPath(file.path)（宿主 workspaces.openPath，在系统文件管理器中打开该文件）。
 *
 * 实际安装以编译形态（open-external.compiled.js）由 patch-conversation.mjs 注入
 * node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js（幂等）。
 * 需要 locale：settings/会话命名空间 details.openExternal（zh="外部打开" / en="Open externally"）。
 */

/* DetailsPanel 头部（大致结构）中，在标题 div 之后插入： */

<button
  type="button"
  style={{ color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "transparent", border: "none", borderRadius: "6px", padding: "4px 8px", fontSize: "12px", flex: "none" }}
  aria-label={t("details.openExternal")}
  onClick={() => { openPath(file.path).catch(() => {}); }}
>
  {t("details.openExternal")}
</button>
