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

    function ExternalSection({ t, readStatus, readWechat, readRules, saveRules, readContacts }) {
      var items = react.useState([]);
      var list = items[0], setList = items[1];
      var wechatState = react.useState({ supported: true, enabled: false, phase: "disabled" });
      var wechat = wechatState[0], setWechat = wechatState[1];
      var errorState = react.useState("");
      var error = errorState[0], setError = errorState[1];
      var openState = react.useState(false), rulesOpen = openState[0], setRulesOpen = openState[1];
      var activeState = react.useState(""), activeChannelId = activeState[0], setActiveChannelId = activeState[1];
      var rulesState = react.useState({ direct_message: "allow", group_message: "allow", direct_whitelist: [], direct_blacklist: [], group_whitelist: [], group_blacklist: [], group_reply_only_when_mentioned_groups: [], profile_write_authorized_contact: "" });
      var rules = rulesState[0], setRules = rulesState[1];
      var contactsState = react.useState([]), contacts = contactsState[0], setContacts = contactsState[1];
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
      react.useEffect(function () { if (!rulesOpen || !activeChannelId) return; Promise.all([readRules(activeChannelId), readContacts(activeChannelId)]).then(function (values) { var saved=values[0], found=values[1]; if(saved&&saved.policy)setRules(function(old){return Object.assign({},old,saved.policy);}); setContacts((found&&found.items)||[]); }).catch(function(e){setError((e&&e.message)||String(e));}); }, [rulesOpen, activeChannelId]);
      var persistRules = function (next) { if(!activeChannelId)return; setRules(next); saveRules(activeChannelId, next).then(function (v) { if (v && v.policy) setRules(function (old) { return Object.assign({}, old, v.policy); }); }).catch(function (e) { setError((e && e.message) || String(e)); }); };
      var setMode = function (key, value) { persistRules(Object.assign({}, rules, (function(){ var x={}; x[key]=value; return x; })())); };
      var setGroupMention = function (id, value) { var next = Object.assign({}, rules); next.group_reply_only_when_mentioned_groups = (rules.group_reply_only_when_mentioned_groups || []).filter(function (x) { return x !== id; }); if (value) next.group_reply_only_when_mentioned_groups.push(id); persistRules(next); };
      var setProfileWriter = function (id) { var next = Object.assign({}, rules); next.profile_write_authorized_contact = rules.profile_write_authorized_contact === id ? "" : id; persistRules(next); };
      var setMember = function (type, id, action) { var white = type === "group" ? "group_whitelist" : "direct_whitelist", black = type === "group" ? "group_blacklist" : "direct_blacklist"; var next = Object.assign({}, rules); next[white] = (rules[white] || []).filter(function (x) { return x !== id; }); next[black] = (rules[black] || []).filter(function (x) { return x !== id; }); if (action === "white") next[white].push(id); if (action === "black") next[black].push(id); persistRules(next); };
      var shown = list.filter(function (c) { return c.status === "connected" && c.mode !== "wechat_pc"; });
      var rowStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "16px 20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", background: "var(--dsw-alias-bg-layer-1)", marginBottom: "12px" };
      var dot = function () { return jsx.jsx("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: "var(--dsw-alias-state-success-primary)", marginLeft: "8px" } }); };
      var connectedBots = ((wechat && wechat.bots) || []).filter(function(bot){return bot.phase === "connected";});
      var rulesCardStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px", marginBottom: "12px", overflow: "hidden", background: "var(--dsw-alias-bg-layer-1)" };
      var rulesHeaderStyle = { width: "100%", border: 0, background: "transparent", minHeight: "48px", padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", color: "var(--dsw-alias-label-primary)", fontWeight: "600", fontSize: "14px" };
      var selectStyle = { height: "32px", padding: "0 28px 0 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", fontSize: "13px", outline: "none" };
      var actionStyle = { height: "28px", padding: "0 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "7px", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: "12px", whiteSpace: "nowrap" };
      var selectedActionStyle = { height: "28px", padding: "0 10px", border: "1px solid var(--dsw-alias-brand-primary, #4f6ef7)", borderRadius: "7px", background: "var(--dsw-alias-brand-secondary, rgba(79,110,247,.1))", color: "var(--dsw-alias-brand-primary, #4f6ef7)", cursor: "pointer", fontSize: "12px", whiteSpace: "nowrap" };
      return jsx.jsxs("div", { children: [
        jsx.jsx("h1", { style: { margin: "0 0 8px", fontSize: "18px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" }, children: t("title") }),
        jsx.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "14px", lineHeight: "22px", margin: "0 0 24px" }, children: t("intro") }),
        connectedBots.map(function(bot){ var opened=rulesOpen&&activeChannelId===bot.channelId; return jsx.jsxs("div", { key:bot.channelId, style: rulesCardStyle, children: [
          jsx.jsxs("button", { type: "button", onClick: function () { setActiveChannelId(bot.channelId); setRulesOpen(!opened); setError(""); }, style: Object.assign({}, rulesHeaderStyle, { minHeight: "56px" }), children: [jsx.jsxs("span", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [(bot.account&&bot.account.nickname)||bot.name||t("wechat.name"), dot(), jsx.jsx("span", { style: { color: "var(--dsw-alias-state-success-primary)", fontSize: "12px", fontWeight: "500" }, children: t("wechat.connected") })] }), jsx.jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontWeight: "400", fontSize: "13px" }, children: opened ? t("collapse") : t("configure") })] }),
          opened ? jsx.jsxs("div", { style: { padding: "4px 16px 16px", borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: [
            (error || bot.error) ? jsx.jsx("div", { role: "alert", style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #dc2626)", margin: "12px 0 0" }, children: error || bot.error }) : null,
            jsx.jsx("div", { style: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)", padding: "12px 0" }, children: "黑名单优先于白名单。群聊上下文由通道后台保存最近 200 条，不在此设置面板展示。" }),
            jsx.jsxs("div", { style: { display: "flex", gap: "20px", flexWrap: "wrap", paddingBottom: "14px", borderBottom: "1px solid var(--dsw-alias-border-l2)" }, children: [
              jsx.jsxs("label", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }, children: ["群聊规则", jsx.jsx("select", { style: selectStyle, value: rules.group_message, onChange: function(e){setMode("group_message", e.target.value);}, children: [jsx.jsx("option", { value: "allow", children: "允许全部" }), jsx.jsx("option", { value: "whitelist", children: "仅白名单" }), jsx.jsx("option", { value: "deny", children: "全部拦截" })] })] }),
              jsx.jsxs("label", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }, children: ["联系人规则", jsx.jsx("select", { style: selectStyle, value: rules.direct_message, onChange: function(e){setMode("direct_message", e.target.value);}, children: [jsx.jsx("option", { value: "allow", children: "允许全部" }), jsx.jsx("option", { value: "whitelist", children: "仅白名单" }), jsx.jsx("option", { value: "deny", children: "全部拦截" })] })] }),
            ] }),
            jsx.jsx("div", { style: { padding: "14px 0 2px", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" }, children: "预设写入权限人只能选择一位联系人。只有该联系人的私聊会话可以把值得长期保留的内容写入并整体优化通道预设；再次点击可取消授权。" }),
            ["group", "direct"].map(function(kind){ var rows=contacts.filter(function(c){return c.type===kind;}); return jsx.jsxs("section", { style: { marginTop: "16px" }, children: [jsx.jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: "600", fontSize: "13px", marginBottom: "6px" }, children: kind === "group" ? "群聊列表" : "联系人列表" }), rows.map(function(c){ var w=(rules[kind+"_whitelist"]||[]).indexOf(c.id)>=0, b=(rules[kind+"_blacklist"]||[]).indexOf(c.id)>=0, mention=(rules.group_reply_only_when_mentioned_groups||[]).indexOf(c.id)>=0, profileWriter=kind==="direct"&&rules.profile_write_authorized_contact===c.id; return jsx.jsxs("div", { key:c.id, style:{display:"flex",gap:"8px",alignItems:"center",padding:"10px 0",fontSize:"13px",borderTop:"1px solid var(--dsw-alias-border-l2)",flexWrap:"wrap"}, children:[jsx.jsxs("div", {style:{flex:"1",minWidth:"180px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}, children:[jsx.jsx("span",{style:{color:"var(--dsw-alias-label-primary)"},children:c.remark||c.nickname||c.name||c.id}),jsx.jsx("span",{style:{color:"var(--dsw-alias-label-tertiary)"},children:" · "+c.id})]}), kind === "group" ? jsx.jsxs("label",{style:{display:"flex",alignItems:"center",gap:"5px",fontSize:"12px",color:"var(--dsw-alias-label-secondary)",whiteSpace:"nowrap"},children:[jsx.jsx("input",{type:"checkbox",checked:mention,onChange:function(e){setGroupMention(c.id,e.target.checked);}}),"仅 @AI 回复"]}):null, kind === "direct" ? jsx.jsx("button",{type:"button",style:profileWriter?selectedActionStyle:actionStyle,onClick:function(){setProfileWriter(c.id);},children:profileWriter?"预设写入已授权":"设为权限人"}):null, jsx.jsx("button",{type:"button",style:w?selectedActionStyle:actionStyle,onClick:function(){setMember(kind,c.id,"white");},children:"白名单"}), jsx.jsx("button",{type:"button",style:b?selectedActionStyle:actionStyle,onClick:function(){setMember(kind,c.id,"black");},children:"黑名单"}), jsx.jsx("button",{type:"button",style:actionStyle,onClick:function(){setMember(kind,c.id,"clear");},children:"清除"})]}); })] }, kind); })
          ] }) : null
        ] }); }),
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
        title: "连接", intro: "连接后可在这里配置通道。", configure: "配置", collapse: "收起",
        "wechat.name": "微信", "wechat.connected": "已连接"
      } : {
        title: "Connections", intro: "Connected channels can be configured here.", configure: "Configure", collapse: "Collapse",
        "wechat.name": "WeChat", "wechat.connected": "Connected"
      };
      var t = function (k) { return locale[k] || k; };
      var readStatus = function () {
        return fetch("http://127.0.0.1:5175/api/channels").then(function (r) { return r.json(); })
          .then(function (j) { return (j && j.channels) || []; }).catch(function () { return []; });
      };
      var readWechat = function () {
        return fetch("http://127.0.0.1:5175/api/wechat/status").then(function (r) { return r.json(); });
      };
      var readRules = function (channelId) { return fetch("http://127.0.0.1:5175/api/wechat/rules?channelId="+encodeURIComponent(channelId)).then(function (r) { return r.json(); }); };
      var saveRules = function (channelId, policy) { return fetch("http://127.0.0.1:5175/api/wechat/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId:channelId, policy: policy }) }).then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || "保存规则失败"); return j; }); }); };
      var readContacts = function (channelId) { return fetch("http://127.0.0.1:5175/api/wechat/contacts?channelId="+encodeURIComponent(channelId)).then(function (r) { return r.json(); }); };
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({ name: "settings.section", id: "external-connections", order: 20, label: function () { return "连接"; }, inject: function () { return { t: t, readStatus: readStatus, readWechat: readWechat, readRules: readRules, saveRules: saveRules, readContacts: readContacts }; } }, ExternalSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
