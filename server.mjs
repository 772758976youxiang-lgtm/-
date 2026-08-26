// 钉钉 ↔ DSH 会话桥接（配置驱动·多通道·热加载）
// 支持多模式：stream(机器人 SDK) / dws(真人账号, 官方 dws CLI, 每通道用 --profile 指定账号，可多真人同时在线)
// 通道配置：~/.dsh-im-channels.json  -> { channels: [{ id, platform, name, appKey, appSecret, mode:"stream", enabled }] }
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream-sdk-nodejs";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE = process.env.DSH_CHANNELS_FILE || path.join(os.homedir(), ".dsh-im-channels.json");
const HOST = process.env.DSH_HOST || "http://127.0.0.1:3080";
const CWD = process.env.DSH_CWD || path.join(os.homedir(), "DeepSeek");
const AGENT_PRESET = process.env.DSH_AGENT_PRESET || "qiuzhu";
const MAP_FILE = process.env.DSH_MAP_FILE || path.join(os.homedir(), ".dsh-im-bridge-map.json");
const STATUS_FILE = process.env.DSH_STATUS_FILE || path.join(os.homedir(), ".dsh-im-channels-status.json");
const DWS_BIN = process.env.DWS_BIN || path.join(os.homedir(), ".local", "bin", "dws");

const NOW = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${NOW()}]`, ...a);

// ---------- 会话映射（externalId -> sessionId，全局共享） ----------
let sessionMap = {};
try { sessionMap = JSON.parse(fs.readFileSync(MAP_FILE, "utf8")); } catch {}
function saveMap() { fs.writeFileSync(MAP_FILE, JSON.stringify(sessionMap, null, 2)); }
const watermark = {}; // sessionId -> seq

// ---------- DSH /api ----------
let rpcSeq = 1;
async function api(method, payload) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${HOST}/api/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "bridge-" + (rpcSeq++), method, payload }),
      });
      const full = await res.json();
      if (!full?.result?.ok) throw new Error(`${method} 失败: ${full?.result?.error?.message ?? JSON.stringify(full?.result)}`);
      return full.result.value;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastErr;
}

let archivedCache = { ids: new Set(), at: 0 };
async function isArchived(sid) {
  if (Date.now() - archivedCache.at < 5000) return archivedCache.ids.has(sid);
  try {
    const v = await api("workspace.list", {});
    archivedCache = { ids: new Set(v.archivedSessionIds ?? []), at: Date.now() };
    return archivedCache.ids.has(sid);
  } catch { return false; }
}
const wsCache = new Map(); // channelId -> workspaceId
async function ensureWorkspace(cfg) {
  // 不盲信缓存：每次验证工作区是否仍在，缺失/被删则重建（含目录）
  const dir = path.join(CWD, "im-workspaces", cfg.id);
  fs.mkdirSync(dir, { recursive: true });
  let wsId = null;
  try {
    const v = await api("workspace.list", {});
    const found = v.items.find((w) => w.path === dir);
    if (found) wsId = found.workspaceId;
  } catch {}
  if (wsId === null) {
    const created = await api("workspace.create", { path: dir });
    wsId = created.workspace.workspaceId;
  }
  try { await api("workspace.rename", { workspaceId: wsId, title: cfg.name || cfg.id }); } catch {}
  wsCache.set(cfg.id, wsId);
  log(`[工作区] ${cfg.id} -> ${wsId} (标题: ${cfg.name})`);
  return wsId;
}
// 白名单成员(owner)不受工作时间限制；only Allowed 名单配置后才算 owner
function isOwner(cfg, id, name) {
  const a = cfg.allowed;
  if (!Array.isArray(a) || a.length === 0) return false;
  return a.includes(id) || a.includes(name);
}
// 工作时间：仅在 workHours.start ~ workHours.end（HH:MM）内处理；未配置=不限
function inWorkHours(cfg, now = new Date()) {
  const wh = cfg.workHours;
  if (!wh) return true;
  const [sh, sm] = String(wh.start ?? "00:00").split(":").map(Number);
  const [eh, em] = String(wh.end ?? "24:00").split(":").map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= (sh * 60 + (sm || 0)) && cur < (eh * 60 + (em || 0));
}
// 允许名单：只允许指定发送人（id 或名字）命令；未配置=不限制
function isAllowed(cfg, id, name) {
  const a = cfg.allowed;
  if (!Array.isArray(a) || a.length === 0) return true;
  return a.includes(id) || a.includes(name);
}
async function ensureSession(extKey, senderNick, cfg) {
  const existing = sessionMap[extKey];
  if (existing) {
    if (!(await isArchived(existing))) return { sid: existing, isNew: false };
    log(`[会话] ${existing} 已归档，消息将开启新会话`);
  }
  const created = await api("session.create", { workspaceId: await ensureWorkspace(cfg), agentPreset: AGENT_PRESET });
  sessionMap[extKey] = created.sessionId;
  watermark[created.sessionId] = 0;
  saveMap();
  log(`[会话] 新建 ${created.sessionId} <- ${extKey}`);
  return { sid: created.sessionId, isNew: true, sender: (senderNick || "用户") };
}
function extractText(message) {
  return (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
async function waitReply(sessionId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = watermark[sessionId] ?? 0;
  let best = null;
  while (Date.now() < deadline) {
    const h = await api("session.history", { sessionId, maxMessages: 20 });
    for (const e of h.events ?? []) {
      if (e.event?.type !== "assistant/message") continue;
      const seq = e.event.seq;
      if (seq > lastSeen) { lastSeen = seq; best = extractText(e.event.data?.message); }
    }
    const ended = (h.events ?? []).some((e) => e.event?.type === "turn/end" && e.event.seq > lastSeen);
    if (best !== null && ended) { watermark[sessionId] = lastSeen; return best; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  watermark[sessionId] = lastSeen;
  return best ?? "[超时无回复]";
}
async function initWatermark(sid) {
  if (watermark[sid] !== undefined) return;
  try {
    const h = await api("session.history", { sessionId: sid, maxMessages: 5 });
    let max = 0;
    for (const e of h.events ?? []) max = Math.max(max, Number(e.event?.seq ?? 0));
    watermark[sid] = max;
    log(`[watermark] ${sid} 初始化为 ${max}`);
  } catch { watermark[sid] = 0; }
}
async function promptContent(sessionId, content) {
  await api("session.prompt", { sessionId, mode: "queue", content });
  log(`[prompt] -> ${sessionId} (${content.length} 内容块)`);
}

// ---------- 钉钉工具（按通道凭证） ----------
const tokenCacheByKey = new Map(); // `${appKey}|${appSecret}` -> { token, expiresAt }
async function getAccessToken(appKey, appSecret) {
  const key = `${appKey}|${appSecret}`;
  const cached = tokenCacheByKey.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const r = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey, appSecret }),
  });
  const j = await r.json();
  if (!j?.accessToken) throw new Error("获取accessToken失败: " + (j?.errmsg ?? JSON.stringify(j)));
  tokenCacheByKey.set(key, { token: j.accessToken, expiresAt: Date.now() + (Number(j.expireIn ?? 7200) - 300) * 1000 });
  return j.accessToken;
}
async function emotionCall(appKey, appSecret, path, msgId, conversationId, emoId, emoName) {
  if (!msgId || !conversationId) return;
  try {
    const token = await getAccessToken(appKey, appSecret);
    const r = await fetch("https://api.dingtalk.com/v1.0/robot/emotion/" + path, {
      method: "POST",
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        robotCode: appKey,
        openMsgId: msgId,
        openConversationId: conversationId,
        emotionType: 2,
        emotionName: emoName,
        textEmotion: { emotionId: emoId, emotionName: emoName, text: emoName, backgroundId: "im_bg_1" },
      }),
    });
    const body = await r.text().catch(() => "");
    log(`[表情:${path}] ${r.ok ? "OK" : "FAIL"} status=${r.status} ${String(body).slice(0, 100)}`);
  } catch (e) {
    log(`[表情:${path} 失败(不影响主流程)]`, e?.message ?? e);
  }
}
async function downloadImage(appKey, appSecret, downloadCode) {
  const token = await getAccessToken(appKey, appSecret);
  const r = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
    method: "POST",
    headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ downloadCode, robotCode: appKey }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.downloadUrl) throw new Error("获取downloadUrl失败: " + JSON.stringify(j));
  const imgRes = await fetch(j.downloadUrl);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const ct = (imgRes.headers.get("content-type") || "image/png").split(";")[0].trim() || "image/png";
  const ext = (ct.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
  return { mediaType: ct, base64: buf.toString("base64"), name: "image." + ext };
}

// ---------- 消息处理（每个通道一份） ----------
const chains = {};
function enqueue(extKey, fn) { chains[extKey] = (chains[extKey] || Promise.resolve()).then(fn, fn); }
const msgState = new Map(); // msgId -> done
const inflight = new Set(); // msgId 处理中

function parseRichText(content) {
  const nodes = content?.richText ?? [];
  let text = "";
  const images = [];
  for (const node of nodes) {
    if (typeof node.text === "string") { text += node.text; continue; }
    if (node.type === "picture") {
      const code = node.downloadCode || node.pictureDownloadCode;
      if (code) images.push(code);
    }
  }
  return { text: text.trim(), images };
}
async function replyViaWebhook(webhook, text) {
  if (!webhook) return { ok: false, reason: "no webhook" };
  const r = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "text", text: { content: text } }) });
  return { ok: r.ok, status: r.status, body: await r.text().catch(() => "") };
}

function makeHandler(cfg, client) {
  const appKey = cfg.appKey;
  const appSecret = cfg.appSecret;
  const finishEmotion = async (msgId, cid) => {
    emotionCall(appKey, appSecret, "recall", msgId, cid, "2659900", "🤔思考中");
    await new Promise((r) => setTimeout(r, 1000));
    emotionCall(appKey, appSecret, "recall", msgId, cid, "2659900", "🤔思考中");
    emotionCall(appKey, appSecret, "reply", msgId, cid, "133501", "👌搞定啦");
  };
  return async (res) => {
    let data; try { data = JSON.parse(res.data); } catch { return; }
    const msgId = data?.msgId ?? "";
    const extKey = data?.conversationId ?? data?.msgId;
    if (!extKey || !msgId) return;
    const sender = data?.senderNick ?? "?";
    const senderId = data?.senderStaffId ?? "";
    if (!isAllowed(cfg, senderId, sender)) { log(`[${cfg.id} 允许名单跳过] ${sender}`); return; }
    if (!inWorkHours(cfg) && !isOwner(cfg, senderId, sender)) { log(`[${cfg.id} 非工作时间跳过] ${sender}`); return; }
    if (msgState.get(msgId) === "done" || inflight.has(msgId)) { log(`[重投·跳过] msgId=${msgId}`); return; }
    inflight.add(msgId);
    emotionCall(appKey, appSecret, "reply", msgId, data?.conversationId, "2659900", "🤔思考中");
    let text = "";
    let images = [];
    if (data.msgtype === "text") {
      text = (data.text?.content ?? "").trim();
      const replied = data.text?.isReplyMsg ? data.text?.repliedMsg : null;
      const quoted = typeof replied?.content?.text === "string" ? replied.content.text : "";
      if (quoted) text = `[用户引用了以下消息]：${quoted}\n\n[用户提问]：${text}`;
    } else if (data.msgtype === "richText") {
      const parsed = parseRichText(data.content);
      text = parsed.text; images = parsed.images;
    }
    log(`[${cfg.id} 收到] msgId=${msgId} ${sender}: ${text !== "" ? text : images.length ? "[图片 x" + images.length + "]" : "(无内容)"}`);
    if (images.length > 0 || text !== "") {
      enqueue(extKey, async () => {
        try {
          const { sid, isNew, sender: newSender } = await ensureSession(extKey, sender, cfg);
          await initWatermark(sid);
          const content = [];
          if (text !== "") content.push({ type: "text", text });
          for (const code of images) {
            const img = await downloadImage(appKey, appSecret, code);
            content.push({ type: "image", mediaType: img.mediaType, data: img.base64, name: img.name });
            log(`[图片] 已下载 ${img.mediaType} ${img.base64.length} chars`);
          }
          await promptContent(sid, content);
          const reply = await waitReply(sid);
          const via = await replyViaWebhook(data?.sessionWebhook, reply);
          log(`[回复] ${String(reply).slice(0, 80)}`);
          log(`[回包] ${JSON.stringify(via)}`);
          if (isNew) {
            const title = ("钉钉·" + newSender).slice(0, 40);
            try { await api("session.rename", { sessionId: sid, title }); log(`[会话命名] ${sid} <- ${title}`); } catch (e) { log("[命名失败]", e?.message ?? e); }
          }
          finishEmotion(msgId, data?.conversationId);
          msgState.set(msgId, "done"); inflight.delete(msgId);
          try { client.send(res.headers.messageId, { status: "SUCCESS" }); } catch {}
        } catch (e) {
          log("[错误]", e?.message ?? e);
          finishEmotion(msgId, data?.conversationId);
          inflight.delete(msgId);
        }
      });
    } else {
      log("[无内容·完整消息]", JSON.stringify(data));
      finishEmotion(msgId, data?.conversationId);
      inflight.delete(msgId); msgState.set(msgId, "done");
      try { client.send(res.headers.messageId, { status: "SUCCESS" }); } catch {}
      await replyViaWebhook(data?.sessionWebhook, "请发文字或图片消息～");
    }
  };
}

// ---------- DWS 真人通道（官方 dws CLI，以真人账号身份收发） ----------
const dwsState = new Map(); // 通道id -> { cfg, child }
function dwsRun(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(DWS_BIN, args, { shell: false }); } catch (e) { resolve({ code: -1, stdout: "", stderr: String(e) }); return; }
    let out = "", err = "";
    const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => err += d);
    child.on("close", (code) => { clearTimeout(to); resolve({ code, stdout: out, stderr: err }); });
  });
}
async function dwsReply(cfg, ev, text) {
  const profArgs = cfg.profile ? ["--profile", cfg.profile] : [];
  const args = ev.conversation_id && !ev.sender_open_dingtalk_id
    ? ["chat", "+messages-send", "--as", "user", "--group", ev.conversation_id, "--text", text, "--yes", ...profArgs]
    : ["chat", "+messages-send", "--as", "user", "--open-dingtalk-id", ev.sender_open_dingtalk_id, "--text", text, "--yes", ...profArgs];
  const r = await dwsRun(args);
  log(`[dws 回复] code=${r.code} ${String(r.stdout || r.stderr).slice(0, 140)}`);
  return r.code === 0;
}
function handleDwsEvent(cfg, ev) {
  const msgId = ev.message_id || ev.event_id || "";
  const text = typeof ev.content === "string" ? ev.content.trim() : "";
  if (!msgId) return;
  // 自环防护：跳过账号自己发出的消息（数字人回复自己 = 无限循环）
  if (cfg.selfUserId && ev.sender_open_dingtalk_id === cfg.selfUserId) { log(`[dws 自消息跳过] ${ev.sender}`); return; }
  // 忽略名单：跳过指定发送人（防止与其它机器人/自动化互聊死循环）
  const ignore = Array.isArray(cfg.ignoreSenders) ? cfg.ignoreSenders : [];
  if (ignore.includes(ev.sender) || ignore.includes(ev.sender_open_dingtalk_id)) { log(`[dws 忽略发送人] ${ev.sender}`); return; }
  if (!isAllowed(cfg, ev.sender_open_dingtalk_id, ev.sender)) { log(`[dws 允许名单跳过] ${ev.sender}`); return; }
  if (!inWorkHours(cfg) && !isOwner(cfg, ev.sender_open_dingtalk_id, ev.sender)) { log(`[dws 非工作时间跳过] ${ev.sender}`); return; }
  if (msgState.get(msgId) === "done" || inflight.has(msgId)) { log(`[dws 重投跳过] ${msgId}`); return; }
  inflight.add(msgId);
  const sender = ev.sender || "?";
  const extKey = ev.sender_open_dingtalk_id || ev.conversation_id || msgId;
  log(`[dws 收到] ${cfg.id} msgId=${msgId} ${sender}: ${text}`);
  if (!text) { inflight.delete(msgId); return; }
  enqueue(extKey, async () => {
    try {
      const { sid, isNew, sender: newSender } = await ensureSession(extKey, sender, cfg);
      await initWatermark(sid);
      await promptContent(sid, [{ type: "text", text }]);
      const reply = await waitReply(sid);
      const ok = await dwsReply(cfg, ev, reply);
      log(`[dws 回复] ${ok ? "OK" : "FAIL"} msgId=${msgId} ${String(reply).slice(0, 60)}`);
      msgState.set(msgId, "done"); inflight.delete(msgId);
    } catch (e) { log("[dws 错误]", e?.message ?? e); inflight.delete(msgId); }
  });
}
function startDwsListener(cfg) {
  if (dwsState.has(cfg.id)) return;
  ensureWorkspace(cfg).catch(() => {});
  const state = { cfg, child: null };
  const start = () => {
    const profArgs = cfg.profile ? ["--profile", cfg.profile] : [];
    const child = spawn(DWS_BIN, ["event", "+listen-im", "--kind", "all-direct", "-f", "ndjson", ...profArgs], { shell: false });
    state.child = child;
    log(`[dws 监听启动] ${cfg.id} (${cfg.name})`);
    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => { if (!line.trim()) return; let ev; try { ev = JSON.parse(line); } catch { return; } if (ev && typeof ev === "object") handleDwsEvent(cfg, ev); else log(`[dws] ${line}`); });
    readline.createInterface({ input: child.stderr }).on("line", (l) => log(`[dws listener] ${l}`));
    child.on("close", (code) => { state.child = null; log(`[dws 监听退出] ${cfg.id} code=${code}，3s 后重启`); setTimeout(() => { if (dwsState.has(cfg.id)) start(); }, 3000); });
  };
  start();
  dwsState.set(cfg.id, state);
}
function stopDwsListener(id) { const st = dwsState.get(id); if (!st) return; try { st.child?.kill("SIGTERM"); } catch {} dwsState.delete(id); log(`[dws 监听停止] ${id}`); }

// ---------- 通道管理（配置驱动 + 热加载） ----------
const channels = new Map(); // id -> { cfg, client, lastActivity, watchdog }
function loadConfig() {
  try { const j = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); return Array.isArray(j?.channels) ? j.channels : []; } catch { return []; }
}
function connectChannel(cfg) {
  if (channels.has(cfg.id)) return;
  const client = new DWClient({ clientId: cfg.appKey, clientSecret: cfg.appSecret, ua: "dsh-session-bridge" });
  const state = { cfg, client, lastActivity: Date.now(), connected: false };
  const orig = client.onDownStream.bind(client);
  client.onDownStream = (data) => { state.lastActivity = Date.now(); return orig(data); };
  state.watchdog = setInterval(() => {
    if (Date.now() - state.lastActivity > 300000) {
      log(`[通道 ${cfg.id}] watchdog ${Math.round((Date.now() - state.lastActivity) / 1000)}s 无活动，强制重连`);
      state.lastActivity = Date.now();
      try { client.disconnect(); } catch {}
      setTimeout(() => { try { client.connect().catch((e) => log(`[通道 ${cfg.id}] 重连失败`, e?.message ?? e)); } catch (e) { log(`[通道 ${cfg.id}] 重连异常`, e?.message ?? e); } }, 1500);
    }
  }, 20000);
  client.registerCallbackListener(TOPIC_ROBOT, makeHandler(cfg, client));
  ensureWorkspace(cfg).catch(() => {});
  client.connect()
    .then(() => { state.connected = true; log(`[通道 ${cfg.id}] 已连接 ${cfg.name ?? ""}`); writeStatus(); })
    .catch((e) => { state.connected = false; log(`[通道 ${cfg.id}] 连接失败(凭证可能无效): ${e?.message ?? e}`); writeStatus(); });
  channels.set(cfg.id, state);
}
function disconnectChannel(id) {
  const ch = channels.get(id);
  if (!ch) return;
  clearInterval(ch.watchdog);
  try { ch.client.disconnect(); } catch {}
  channels.delete(id);
  log(`[通道 ${id}] 已断开`);
}
function writeStatus() {
  const cfgs = loadConfig();
  const items = cfgs.map((c) => ({
    id: c.id, platform: c.platform, name: c.name, mode: c.mode, enabled: !!c.enabled,
    status: c.mode === "dws" ? (dwsState.has(c.id) ? "connected" : (c.enabled ? "failed" : "disabled")) : channels.has(c.id) ? (channels.get(c.id).connected ? "connected" : "connecting") : (c.enabled ? "failed" : "disabled"),
  }));
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ channels: items, ts: Date.now() }, null, 2)); } catch (e) { log("[写状态文件失败]", e?.message ?? e); }
}
function syncChannels() {
  const cfgs = loadConfig();
  const byId = new Map(cfgs.map((c) => [c.id, c]));
  for (const id of [...channels.keys()]) {
    const cfg = byId.get(id);
    if (!cfg || !cfg.enabled) disconnectChannel(id);
    else if (cfg.appKey !== channels.get(id).cfg.appKey || cfg.appSecret !== channels.get(id).cfg.appSecret) { disconnectChannel(id); connectChannel(cfg); }
  }
  for (const cfg of cfgs) if (cfg.enabled && cfg.mode !== "dws" && cfg.appKey && cfg.appSecret && !channels.has(cfg.id)) connectChannel(cfg);
  for (const id of [...dwsState.keys()]) { const cfg = byId.get(id); if (!cfg || !cfg.enabled) stopDwsListener(id); }
  for (const cfg of cfgs) if (cfg.enabled && cfg.mode === "dws" && !dwsState.has(cfg.id)) startDwsListener(cfg);
  log(`[sync] 已连接通道: ${[...channels.keys()].join(", ") || "(无)"}${dwsState.size ? " | dws: " + [...dwsState.keys()].join(", ") : ""}`);
  writeStatus();
}

let reloadTimer;
try {
  fs.watch(CONFIG_FILE, () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { log("[配置变更]"); syncChannels(); }, 800); });
} catch (e) { log("[watch 配置失败]", e?.message ?? e); }
syncChannels();

// ---------- 管理 API（供 agent 直接增删，无需改文件） ----------
const BRIDGE_PORT = Number(process.env.DSH_BRIDGE_PORT || 5175);
function saveConfig(cfgs) { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ channels: cfgs }, null, 2)); } catch (e) { log("[写配置失败]", e?.message ?? e); } }
const httpServer = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const path = new URL(req.url, "http://localhost").pathname;
  if (req.method === "GET" && path === "/api/channels") {
    const items = loadConfig().map((c) => ({ ...c, status: c.mode === "dws" ? (dwsState.has(c.id) ? "connected" : (c.enabled ? "failed" : "disabled")) : channels.has(c.id) ? (channels.get(c.id).connected ? "connected" : "connecting") : (c.enabled ? "failed" : "disabled") }));
    return send(200, { ok: true, channels: items });
  }
  if (req.method === "POST" && path === "/api/channels") {
    let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
      try {
        const cfg = JSON.parse(body || "{}");
        if (!cfg.id || (cfg.mode !== "dws" && (!cfg.appKey || !cfg.appSecret))) return send(400, { ok: false, error: "需要 id ，以及 appKey/appSecret（stream 模式）" });
        const cfgs = loadConfig();
        const idx = cfgs.findIndex((c) => c.id === cfg.id);
        if (idx >= 0) cfgs[idx] = { ...cfgs[idx], ...cfg }; else cfgs.push(cfg);
        saveConfig(cfgs);
        setTimeout(() => { syncChannels(); }, 300);
        log(`[管理API] 新增/更新通道 ${cfg.id}`);
        send(200, { ok: true, id: cfg.id });
      } catch (e) { send(400, { ok: false, error: e?.message ?? String(e) }); }
    });
    return;
  }
  if (req.method === "DELETE" && path.startsWith("/api/channels/")) {
    const id = decodeURIComponent(path.slice("/api/channels/".length));
    const cfgs = loadConfig().filter((c) => c.id !== id);
    saveConfig(cfgs);
    setTimeout(() => { syncChannels(); }, 300);
    log(`[管理API] 删除通道 ${id}`);
    return send(200, { ok: true, id });
  }
  send(404, { ok: false, error: "not found" });
});
httpServer.listen(BRIDGE_PORT, () => log(`[管理API] http://127.0.0.1:${BRIDGE_PORT}/api/channels (GET/POST/DELETE)`));

process.on("SIGINT", () => { for (const [, ch] of channels) try { ch.client.disconnect(); } catch {} process.exit(0); });
