// @deepseek-ai/dsh-channel-im · 浏览器半（原生 client 插件）：「连接」设置页
// 依赖：ui-settings 声明的 settings.section 槽；状态经 127.0.0.1:5175 管理API 读取（免本机路径）。
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-channel-im",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var jsx = require("react/jsx-runtime");

    function ExternalSection({ t, readStatus, readWechat, toggleWechat, installWechat }) {
      var items = react.useState([]);
      var list = items[0], setList = items[1];
      var wechatState = react.useState({ supported: true, enabled: false, phase: "disabled" });
      var wechat = wechatState[0], setWechat = wechatState[1];
      var busyState = react.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var errorState = react.useState("");
      var error = errorState[0], setError = errorState[1];
      var confirmationState = react.useState(null);
      var confirmation = confirmationState[0], setConfirmation = confirmationState[1];
      react.useEffect(function () {
        var alive = true;
        var load = function () {
          readStatus().then(function (xs) { if (alive && Array.isArray(xs)) setList(xs); }).catch(function () {});
          readWechat().then(function (value) { if (alive && value) setWechat(value); }).catch(function () {});
        };
        load();
        var timer = setInterval(load, 3000);
        return function () { alive = false; clearInterval(timer); };
      }, [readStatus, readWechat]);
      var changeWechat = function () {
        if (busy || wechat.supported === false) return;
        setBusy(true);
        setError("");
        toggleWechat(!wechat.enabled).then(function (value) {
          if (value) setWechat(value);
          if (value && value.code === "WECHAT_VERSION_REQUIRED") setConfirmation(value);
        }).catch(function (reason) {
          setError((reason && reason.message) || String(reason));
        }).finally(function () { setBusy(false); });
      };
      var confirmInstall = function () {
        if (!confirmation || !confirmation.confirmationToken) return;
        setBusy(true);
        setError("");
        installWechat(confirmation.confirmationToken).then(function (value) {
          if (value) setWechat(value);
          setConfirmation(null);
        }).catch(function (reason) {
          setError((reason && reason.message) || String(reason));
        }).finally(function () { setBusy(false); });
      };
      var cancelInstall = function () {
        setConfirmation(null);
        setError(t("wechat.riskWarning"));
      };
      var shown = list.filter(function (c) { return c.status === "connected" && c.mode !== "wechat_pc"; });
      var rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "16px 20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)", marginBottom: "12px" };
      var dot = function () { return jsx.jsx("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", marginLeft: "8px" } }); };
      var installActive = ["downloading", "verifying", "requesting_admin", "installing", "verifying_install"].indexOf(wechat.phase) >= 0;
      var phaseText = installActive ? t("wechat." + wechat.phase) : wechat.phase === "connected" ? t("wechat.connected") : wechat.phase === "waiting_for_scan" ? t("wechat.waiting") : wechat.phase === "starting" ? t("wechat.starting") : wechat.phase === "failed" ? t("wechat.failed") : t("wechat.disabled");
      var phaseColor = wechat.phase === "connected" ? "var(--dsw-alias-state-success-primary)" : wechat.enabled ? "var(--dsw-alias-state-warning-primary, #d97706)" : "var(--dsw-alias-label-tertiary)";
      var switchStyle = { width: "44px", height: "24px", padding: "2px", border: "0", borderRadius: "999px", cursor: busy || installActive || wechat.supported === false ? "not-allowed" : "pointer", opacity: busy || installActive ? 0.65 : 1, background: wechat.enabled ? "var(--dsw-alias-brand-primary, #4f6ef7)" : "var(--dsw-alias-fill-secondary, #aeb4bf)", transition: "background .18s ease" };
      var knobStyle = { display: "block", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transform: wechat.enabled ? "translateX(20px)" : "translateX(0)", transition: "transform .18s ease", boxShadow: "0 1px 3px rgba(0,0,0,.25)" };
      return jsx.jsxs("div", { children: [
        jsx.jsx("h1", { style: { margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: t("title") }),
        jsx.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "14px", lineHeight: "22px", margin: "0 0 24px" }, children: t("intro") }),
        jsx.jsxs("div", { style: rowStyle, children: [
          jsx.jsxs("div", { style: { flex: "1", minWidth: "0" }, children: [
            jsx.jsxs("div", { style: { fontWeight: "600", fontSize: "15px", display: "flex", alignItems: "center", gap: "8px" }, children: [
              t("wechat.name"),
              jsx.jsx("span", { style: { fontSize: "12px", color: phaseColor }, children: busy ? t("wechat.processing") : phaseText })
            ] }),
            jsx.jsx("div", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary)", marginTop: "4px", lineHeight: "19px" }, children: wechat.supported === false ? t("wechat.windowsOnly") : wechat.phase === "connected" ? ((wechat.account && wechat.account.nickname ? wechat.account.nickname + " · " : "") + t("wechat.details")) : wechat.enabled ? t("wechat.waitingHint") : t("wechat.disabledHint") }),
            (error || wechat.error) ? jsx.jsx("div", { role: "alert", style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #dc2626)", marginTop: "6px" }, children: error || wechat.error }) : null
          ] }),
          jsx.jsx("button", { type: "button", role: "switch", "aria-label": t("wechat.aria"), "aria-checked": !!wechat.enabled, disabled: busy || installActive || wechat.supported === false, onClick: changeWechat, style: switchStyle, children: jsx.jsx("span", { style: knobStyle }) })
        ] }),
        confirmation ? jsx.jsx("div", { role: "dialog", "aria-modal": "true", "aria-label": t("wechat.versionTitle"), style: { position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", background: "rgba(0,0,0,.45)" }, children:
          jsx.jsxs("div", { style: { width: "min(440px, 100%)", padding: "22px", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1, #fff)", boxShadow: "0 18px 50px rgba(0,0,0,.25)" }, children: [
            jsx.jsx("h2", { style: { margin: "0 0 12px", fontSize: "17px" }, children: t("wechat.versionTitle") }),
            jsx.jsx("p", { style: { margin: "0 0 18px", fontSize: "14px", lineHeight: "22px" }, children: t("wechat.versionPrompt").replace("{current}", confirmation.installedVersion || t("wechat.notFound")) }),
            jsx.jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: "10px" }, children: [
              jsx.jsx("button", { type: "button", onClick: cancelInstall, children: t("wechat.cancelInstall") }),
              jsx.jsx("button", { type: "button", disabled: busy, onClick: confirmInstall, children: t("wechat.installTarget") })
            ] })
          ] })
        }) : null,
        shown.length === 0
          ? null
          : shown.map(function (c) {
              return jsx.jsxs("div", { key: c.id, style: rowStyle, children: [
                jsx.jsxs("div", { style: { flex: "1", minWidth: "0" }, children: [
                  jsx.jsxs("div", { style: { fontWeight: "600", fontSize: "15px", display: "flex", alignItems: "center", gap: "8px" }, children: [ c.name, dot(), jsx.jsx("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" }, children: "已连接" }) ] }),
                  jsx.jsx("div", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary)", marginTop: "2px" }, children: c.mode === "stream" ? "Stream 模式 · 无需公网" : c.mode === "wechat_pc" ? "微信 PC · 数据库接收 · Hook/UIA/OCR 发送" : (c.mode || "") })
                ] })
              ] });
            })
      ] });
    }

    function apply(ctx) {
      var isZh = !globalThis.navigator || /^zh(?:-|$)/i.test(globalThis.navigator.language || "zh");
      var locale = isZh ? {
        title: "连接", intro: "IM 通道由 Harness 统一管理，可在此直接启用微信个人号通道。",
        "wechat.name": "微信个人号", "wechat.connected": "已连接", "wechat.waiting": "等待扫码登录", "wechat.starting": "正在启动", "wechat.disabled": "未启用", "wechat.processing": "处理中",
        "wechat.downloading": "正在下载微信", "wechat.verifying": "正在校验安装包", "wechat.requesting_admin": "等待管理员授权", "wechat.installing": "正在安装", "wechat.verifying_install": "正在复检", "wechat.failed": "安装失败",
        "wechat.windowsOnly": "仅支持 Windows 微信 4.x", "wechat.details": "数据库接收 · Hook/UIA/OCR 发送", "wechat.waitingHint": "已重新启动微信，请扫码或在手机上确认登录；登录后会自动建立通道。", "wechat.disabledHint": "打开后会先校验微信是否为 4.1.10.27。", "wechat.aria": "微信个人号通道",
        "wechat.versionTitle": "需要微信 4.1.10.27", "wechat.versionPrompt": "检测到的微信版本为 {current}，微信通道仅支持 4.1.10.27。继续使用其他版本可能导致兼容异常，并增加账号封禁风险。是否安装微信 4.1.10.27？", "wechat.notFound": "未安装", "wechat.installTarget": "安装 4.1.10.27", "wechat.cancelInstall": "取消，保持关闭", "wechat.riskWarning": "微信通道仍保持关闭：其他版本可能导致兼容异常，并增加账号封禁风险。"
      } : {
        title: "Connections", intro: "IM channels are managed by Harness. Enable a personal WeChat channel here.",
        "wechat.name": "Personal WeChat", "wechat.connected": "Connected", "wechat.waiting": "Waiting for QR scan", "wechat.starting": "Starting", "wechat.disabled": "Disabled", "wechat.processing": "Working",
        "wechat.downloading": "Downloading WeChat", "wechat.verifying": "Verifying installer", "wechat.requesting_admin": "Waiting for administrator approval", "wechat.installing": "Installing", "wechat.verifying_install": "Checking installation", "wechat.failed": "Installation failed",
        "wechat.windowsOnly": "Windows WeChat 4.x only", "wechat.details": "Database receive · Hook/UIA/OCR send", "wechat.waitingHint": "WeChat was restarted. Scan the QR code or confirm on your phone; the channel connects automatically after login.", "wechat.disabledHint": "The plugin checks for WeChat 4.1.10.27 before enabling.", "wechat.aria": "Personal WeChat channel",
        "wechat.versionTitle": "WeChat 4.1.10.27 required", "wechat.versionPrompt": "Detected WeChat version: {current}. This channel supports only 4.1.10.27. Other versions may cause compatibility problems and increase account-ban risk. Install WeChat 4.1.10.27?", "wechat.notFound": "not installed", "wechat.installTarget": "Install 4.1.10.27", "wechat.cancelInstall": "Cancel and keep disabled", "wechat.riskWarning": "The WeChat channel remains disabled because other versions may increase compatibility and account-ban risk."
      };
      var t = function (k) { return locale[k] || k; };
      var readStatus = function () {
        return fetch("http://127.0.0.1:5175/api/channels").then(function (r) { return r.json(); })
          .then(function (j) { return (j && j.channels) || []; }).catch(function () { return []; });
      };
      var readWechat = function () {
        return fetch("http://127.0.0.1:5175/api/wechat/status").then(function (r) { return r.json(); });
      };
      var toggleWechat = function (enabled) {
        return fetch("http://127.0.0.1:5175/api/wechat/toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: enabled }) })
          .then(function (r) { return r.json().then(function (j) { if (r.status === 409 && j.code === "WECHAT_VERSION_REQUIRED") return j; if (!r.ok || !j.ok) throw new Error(j.error || (isZh ? "微信通道切换失败" : "Failed to toggle WeChat channel")); return j; }); });
      };
      var installWechat = function (confirmationToken) {
        return fetch("http://127.0.0.1:5175/api/wechat/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationToken: confirmationToken }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || (isZh ? "微信安装启动失败" : "Failed to start WeChat installation")); return j; }); });
      };
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({ name: "settings.section", id: "external-connections", order: 20, label: function () { return "连接"; }, inject: function () { return { t: t, readStatus: readStatus, readWechat: readWechat, toggleWechat: toggleWechat, installWechat: installWechat }; } }, ExternalSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
