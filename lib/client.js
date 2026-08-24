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

    function ExternalSection({ t, readStatus, readWechat, toggleWechat, readRules, saveRules, readContacts, readRecent }) {
      var items = react.useState([]);
      var list = items[0], setList = items[1];
      var wechatState = react.useState({ supported: true, enabled: false, phase: "disabled" });
      var wechat = wechatState[0], setWechat = wechatState[1];
      var busyState = react.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var errorState = react.useState("");
      var error = errorState[0], setError = errorState[1];
      var openState = react.useState(false), rulesOpen = openState[0], setRulesOpen = openState[1];
      var rulesState = react.useState({ direct_message: "allow", group_message: "allow", direct_whitelist: [], direct_blacklist: [], group_whitelist: [], group_blacklist: [], group_reply_only_when_mentioned: false });
      var rules = rulesState[0], setRules = rulesState[1];
      var contactsState = react.useState([]), contacts = contactsState[0], setContacts = contactsState[1];
      var contextsState = react.useState([]), contexts = contextsState[0], setContexts = contextsState[1];
      react.useEffect(function () {
        var alive = true;
        var load = function () {
          readStatus().then(function (xs) { if (alive && Array.isArray(xs)) setList(xs); }).catch(function () {});
          readWechat().then(function (value) { if (alive && value) setWechat(value); }).catch(function () {});
          readRules().then(function (value) { if (alive && value && value.policy) setRules(function (old) { return Object.assign({}, old, value.policy); }); }).catch(function () {});
        };
        load();
        var timer = setInterval(load, 3000);
        return function () { alive = false; clearInterval(timer); };
      }, [readStatus, readWechat]);
      react.useEffect(function () { if (!rulesOpen) return; readContacts().then(function (v) { setContacts((v && v.items) || []); }).catch(function () {}); readRecent().then(function (v) { setContexts(((v && v.items) || []).filter(function (x) { return x.message && x.message.conversation_type === "group"; }).slice(0, 12)); }).catch(function () {}); }, [rulesOpen]);
      var changeWechat = function () {
        if (busy || wechat.supported === false) return;
        setBusy(true);
        setError("");
        toggleWechat(!wechat.enabled).then(function (value) {
          if (value) setWechat(value);
        }).catch(function (reason) {
          setError((reason && reason.message) || String(reason));
        }).finally(function () { setBusy(false); });
      };
      var persistRules = function (next) { setRules(next); saveRules(next).then(function (v) { if (v && v.policy) setRules(function (old) { return Object.assign({}, old, v.policy); }); }).catch(function (e) { setError((e && e.message) || String(e)); }); };
      var setMode = function (key, value) { persistRules(Object.assign({}, rules, (function(){ var x={}; x[key]=value; return x; })())); };
      var setMention = function (value) { persistRules(Object.assign({}, rules, { group_reply_only_when_mentioned: value })); };
      var setMember = function (type, id, action) { var white = type === "group" ? "group_whitelist" : "direct_whitelist", black = type === "group" ? "group_blacklist" : "direct_blacklist"; var next = Object.assign({}, rules); next[white] = (rules[white] || []).filter(function (x) { return x !== id; }); next[black] = (rules[black] || []).filter(function (x) { return x !== id; }); if (action === "white") next[white].push(id); if (action === "black") next[black].push(id); persistRules(next); };
      var shown = list.filter(function (c) { return c.status === "connected" && c.mode !== "wechat_pc"; });
      var rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "16px 20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)", marginBottom: "12px" };
      var dot = function () { return jsx.jsx("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", marginLeft: "8px" } }); };
      var phaseText = wechat.phase === "connected" ? t("wechat.connected") : wechat.phase === "waiting_for_scan" ? t("wechat.waiting") : wechat.phase === "starting" ? t("wechat.starting") : t("wechat.disabled");
      var phaseColor = wechat.phase === "connected" ? "var(--dsw-alias-state-success-primary)" : wechat.enabled ? "var(--dsw-alias-state-warning-primary, #d97706)" : "var(--dsw-alias-label-tertiary)";
      var switchStyle = { width: "44px", height: "24px", padding: "2px", border: "0", borderRadius: "999px", cursor: busy || wechat.supported === false ? "not-allowed" : "pointer", opacity: busy ? 0.65 : 1, background: wechat.enabled ? "var(--dsw-alias-brand-primary, #4f6ef7)" : "var(--dsw-alias-fill-secondary, #aeb4bf)", transition: "background .18s ease" };
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
          jsx.jsx("button", { type: "button", role: "switch", "aria-label": t("wechat.aria"), "aria-checked": !!wechat.enabled, disabled: busy || wechat.supported === false, onClick: changeWechat, style: switchStyle, children: jsx.jsx("span", { style: knobStyle }) })
        ] }),
        jsx.jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", marginBottom: "12px", overflow: "hidden" }, children: [
          jsx.jsxs("button", { type: "button", onClick: function () { setRulesOpen(!rulesOpen); }, style: { width: "100%", border: 0, background: "var(--dsw-alias-bg-layer-1)", padding: "12px 16px", display: "flex", justifyContent: "space-between", cursor: "pointer", color: "var(--dsw-alias-label-primary)", fontWeight: "600" }, children: ["规则与上下文", jsx.jsx("span", { children: rulesOpen ? "收起" : "展开" })] }),
          rulesOpen ? jsx.jsxs("div", { style: { padding: "16px", background: "var(--dsw-alias-bg-layer-1)", borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: [
            jsx.jsx("div", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "12px" }, children: "黑名单优先于白名单；未获回复的群消息仍会记录在下方上下文。" }),
            jsx.jsxs("div", { style: { display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }, children: [
              jsx.jsxs("label", { children: ["群聊规则 ", jsx.jsx("select", { value: rules.group_message, onChange: function(e){setMode("group_message", e.target.value);}, children: [jsx.jsx("option", { value: "allow", children: "允许全部" }), jsx.jsx("option", { value: "whitelist", children: "仅白名单" }), jsx.jsx("option", { value: "deny", children: "全部拦截" })] })] }),
              jsx.jsxs("label", { children: ["联系人规则 ", jsx.jsx("select", { value: rules.direct_message, onChange: function(e){setMode("direct_message", e.target.value);}, children: [jsx.jsx("option", { value: "allow", children: "允许全部" }), jsx.jsx("option", { value: "whitelist", children: "仅白名单" }), jsx.jsx("option", { value: "deny", children: "全部拦截" })] })] }),
              jsx.jsxs("label", { children: [jsx.jsx("input", { type: "checkbox", checked: !!rules.group_reply_only_when_mentioned, onChange: function(e){setMention(e.target.checked);} }), " 仅群内 @我时回复"] })
            ] }),
            ["group", "direct"].map(function(kind){ var rows=contacts.filter(function(c){return c.type===kind;}); return jsx.jsxs("div", { style: { marginTop: "14px" }, children: [jsx.jsx("div", { style: { fontWeight: "600", marginBottom: "6px" }, children: kind === "group" ? "群聊名单" : "联系人名单" }), rows.map(function(c){ var w=(rules[kind+"_whitelist"]||[]).indexOf(c.id)>=0, b=(rules[kind+"_blacklist"]||[]).indexOf(c.id)>=0; return jsx.jsxs("div", { key:c.id, style:{display:"flex",gap:"8px",alignItems:"center",padding:"6px 0",fontSize:"13px"}, children:[jsx.jsx("span", {style:{flex:"1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}, children:(c.remark||c.nickname||c.name||c.id)+" · "+c.id}), jsx.jsx("button",{type:"button",onClick:function(){setMember(kind,c.id,"white");},children:w?"白名单✓":"白名单"}), jsx.jsx("button",{type:"button",onClick:function(){setMember(kind,c.id,"black");},children:b?"黑名单✓":"黑名单"}), jsx.jsx("button",{type:"button",onClick:function(){setMember(kind,c.id,"clear");},children:"清除"})]}); })] }, kind); }),
            jsx.jsx("div", { style: { fontWeight: "600", marginTop: "16px", marginBottom: "6px" }, children: "群聊上下文（最近 12 条）" }),
            contexts.length ? contexts.map(function(item){ var m=item.message||{}, c=m.context||{}; return jsx.jsxs("div", { key:item.message_id, style:{padding:"8px",marginBottom:"6px",background:"var(--dsw-alias-fill-secondary)",borderRadius:"8px",fontSize:"12px"}, children:[jsx.jsx("div",{children:(c.conversation_name||m.conversation_id||"群聊")+" · "+(c.sender_name||m.sender_id||"")+(m.reply_allowed?" · 已回复":" · 仅记录")}), jsx.jsx("div",{style:{marginTop:"3px"},children:m.content||""}), c.quoted_message ? jsx.jsx("div",{style:{marginTop:"3px",color:"var(--dsw-alias-label-tertiary)"},children:"引用："+c.quoted_message}):null]}); }) : jsx.jsx("div",{style:{fontSize:"12px",color:"var(--dsw-alias-label-tertiary)"},children:"暂无群聊上下文"})
          ] }) : null
        ] }),
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
        "wechat.windowsOnly": "仅支持 Windows 微信 4.x", "wechat.details": "数据库接收 · Hook/UIA/OCR 发送", "wechat.waitingHint": "已重新启动微信，请扫码或在手机上确认登录；登录后会自动建立通道。", "wechat.disabledHint": "打开后先关闭旧微信进程，再启动新的扫码窗口并建立本地通道。", "wechat.aria": "微信个人号通道"
      } : {
        title: "Connections", intro: "IM channels are managed by Harness. Enable a personal WeChat channel here.",
        "wechat.name": "Personal WeChat", "wechat.connected": "Connected", "wechat.waiting": "Waiting for QR scan", "wechat.starting": "Starting", "wechat.disabled": "Disabled", "wechat.processing": "Working",
        "wechat.windowsOnly": "Windows WeChat 4.x only", "wechat.details": "Database receive · Hook/UIA/OCR send", "wechat.waitingHint": "WeChat was restarted. Scan the QR code or confirm on your phone; the channel connects automatically after login.", "wechat.disabledHint": "Turn on to close the old WeChat process, open a fresh sign-in window, and establish the local channel.", "wechat.aria": "Personal WeChat channel"
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
          .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || (isZh ? "微信通道切换失败" : "Failed to toggle WeChat channel")); return j; }); });
      };
      var readRules = function () { return fetch("http://127.0.0.1:5175/api/wechat/rules").then(function (r) { return r.json(); }); };
      var saveRules = function (policy) { return fetch("http://127.0.0.1:5175/api/wechat/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: policy }) }).then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || "保存规则失败"); return j; }); }); };
      var readContacts = function () { return fetch("http://127.0.0.1:5176/api/contacts?limit=200").then(function (r) { return r.json(); }); };
      var readRecent = function () { return fetch("http://127.0.0.1:5176/api/recent?limit=100").then(function (r) { return r.json(); }); };
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({ name: "settings.section", id: "external-connections", order: 20, label: function () { return "连接"; }, inject: function () { return { t: t, readStatus: readStatus, readWechat: readWechat, toggleWechat: toggleWechat, readRules: readRules, saveRules: saveRules, readContacts: readContacts, readRecent: readRecent }; } }, ExternalSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
