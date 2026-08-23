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
import { fileURLToPath } from "node:url";

const CONFIG_FILE = process.env.DSH_CHANNELS_FILE || path.join(os.homedir(), ".dsh-im-channels.json");
const HOST = process.env.DSH_HOST || "http://127.0.0.1:3080";
const CWD = process.env.DSH_CWD || path.join(os.homedir(), "DeepSeek");
const AGENT_PRESET = process.env.DSH_AGENT_PRESET || "robot-assistant";
const MAP_FILE = process.env.DSH_MAP_FILE || path.join(os.homedir(), ".dsh-im-bridge-map.json");
const STATUS_FILE = process.env.DSH_STATUS_FILE || path.join(os.homedir(), ".dsh-im-channels-status.json");
const DWS_BIN = process.env.DWS_BIN || path.join(os.homedir(), ".local", "bin", "dws");
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = process.env.DSH_WECHAT_PYTHON || (process.platform === "win32" ? "python" : "python3");
const DEFAULT_WECHAT_CONFIG = process.env.DSH_WECHAT_CONFIG || path.join(os.homedir(), ".dsh-wechat-channel.json");
const WECHAT_EXECUTABLE = process.env.DSH_WECHAT_EXECUTABLE || "";
const WECHAT_CHANNEL_ID = "wechat-personal";

const NOW = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${NOW()}]`, ...a);

function ensureConfigFile() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ channels: [] }, null, 2), { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

ensureConfigFile();

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

// ---------- 微信个人号通道（数据库接收 + Hook/UIA/OCR 发送） ----------
const wechatState = new Map(); // 通道id -> { cfg, child, connected, loggedIn, stopping, lastError }
const wechatLaunchState = { launchedAt: 0, executable: "", lastError: "" };
const wechatHealthCache = { url: "", at: 0, value: null, pending: null };
function startWechatChannel(cfg) {
  if (wechatState.has(cfg.id)) return;
  const state = { cfg, child: null, connected: false, loggedIn: false, stopping: false, lastError: "", lastStderr: "" };
  const start = () => {
    const configFile = cfg.configFile || DEFAULT_WECHAT_CONFIG;
    const args = ["-m", "wechat_channel", "run"];
    if (fs.existsSync(configFile)) args.push("--config", configFile);
    const child = spawn(PYTHON_BIN, args, {
      cwd: PLUGIN_ROOT,
      shell: false,
      env: { ...process.env, PYTHONPATH: [PLUGIN_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
      windowsHide: true,
    });
    state.child = child;
    state.connected = false;
    state.loggedIn = false;
    state.lastError = "";
    state.lastStderr = "";
    log(`[微信通道] 启动 ${cfg.id} (${cfg.name ?? "微信个人号"}) config=${configFile}`);
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.includes("WeChat management API:")) { state.connected = true; writeStatus(); }
      log(`[微信 ${cfg.id}] ${line}`);
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      state.lastStderr = String(line).slice(0, 500);
      log(`[微信 ${cfg.id} stderr] ${line}`);
    });
    child.on("error", (error) => {
      state.connected = false;
      state.loggedIn = false;
      state.lastError = error?.message ?? String(error);
      log(`[微信 ${cfg.id}] 启动失败: ${state.lastError}`);
      writeStatus();
    });
    child.on("close", (code) => {
      state.child = null;
      state.connected = false;
      state.loggedIn = false;
      if (!state.stopping && code !== 0) state.lastError = state.lastStderr || `微信通道进程退出 code=${code}`;
      writeStatus();
      log(`[微信 ${cfg.id}] 退出 code=${code}${state.stopping ? "" : "，3s 后重启"}`);
      if (!state.stopping && wechatState.has(cfg.id)) setTimeout(start, 3000);
    });
  };
  wechatState.set(cfg.id, state);
  start();
}
function stopWechatChannel(id) {
  const state = wechatState.get(id);
  if (!state) return;
  state.stopping = true;
  try { state.child?.kill("SIGTERM"); } catch {}
  wechatState.delete(id);
  log(`[微信通道] 停止 ${id}`);
}

function capture(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { shell: false, windowsHide: true }); }
    catch (error) { resolve({ code: -1, stdout: "", stderr: error?.message ?? String(error) }); return; }
    let stdout = "", stderr = "", settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: Number(code ?? -1), stdout, stderr });
    };
    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr?.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { stderr += error?.message ?? String(error); finish(-1); });
    child.on("close", finish);
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} finish(-1); }, timeoutMs);
  });
}

async function isWeChatProcessRunning() {
  if (process.platform !== "win32") return false;
  const result = await capture("tasklist.exe", ["/FI", "IMAGENAME eq Weixin.exe", "/FI", "STATUS eq RUNNING", "/FO", "CSV", "/NH"]);
  if (/Weixin\.exe/i.test(result.stdout)) return true;
  const legacy = await capture("tasklist.exe", ["/FI", "IMAGENAME eq WeChat.exe", "/FO", "CSV", "/NH"]);
  return /WeChat\.exe/i.test(legacy.stdout);
}

function findWeChatExecutable() {
  if (process.platform !== "win32") return "";
  const candidates = [
    WECHAT_EXECUTABLE,
    path.join(process.env.ProgramW6432 || "C:\\Program Files", "Tencent", "Weixin", "Weixin.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Tencent", "Weixin", "Weixin.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Tencent", "WeChat", "WeChat.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Tencent", "Weixin", "Weixin.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function closeExistingWeChatProcesses() {
  if (process.platform !== "win32") return;
  for (const image of ["Weixin.exe", "WeChat.exe"]) {
    const result = await capture("taskkill.exe", ["/IM", image, "/T", "/F"], 10000);
    if (result.code === 0) log(`[微信登录] 已关闭旧进程 ${image}`);
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await isWeChatProcessRunning())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("旧微信进程未能在 10 秒内退出，请手动关闭后重试");
}

async function launchWeChatLoginWindow() {
  if (process.platform !== "win32") throw new Error("微信个人号通道仅支持 Windows");
  const executable = findWeChatExecutable();
  if (!executable) throw new Error("未找到微信客户端，请安装微信 4.x，或配置 DSH_WECHAT_EXECUTABLE");
  await closeExistingWeChatProcesses();
  const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
  child.unref();
  wechatLaunchState.launchedAt = Date.now();
  wechatLaunchState.executable = executable;
  wechatLaunchState.lastError = "";
  log(`[微信登录] 已拉起 ${executable}`);
  return executable;
}

function wechatManagementUrl(cfg) {
  let service = { host: "127.0.0.1", port: 5176 };
  const configFile = cfg?.configFile || DEFAULT_WECHAT_CONFIG;
  try {
    const custom = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (custom?.service && typeof custom.service === "object") service = { ...service, ...custom.service };
  } catch {}
  const host = service.host === "localhost" || service.host === "::1" ? "127.0.0.1" : service.host;
  return `http://${host}:${Number(service.port || 5176)}/api/status`;
}

async function readWechatServiceStatus(cfg) {
  if (!cfg?.enabled) return null;
  const url = wechatManagementUrl(cfg);
  if (wechatHealthCache.url === url && Date.now() - wechatHealthCache.at < 3000) return wechatHealthCache.value;
  if (wechatHealthCache.url === url && wechatHealthCache.pending) return wechatHealthCache.pending;
  const probe = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const token = process.env.WECHAT_CHANNEL_TOKEN || "";
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch { return null; }
    finally { clearTimeout(timer); }
  })();
  wechatHealthCache.url = url;
  wechatHealthCache.pending = probe;
  const value = await probe;
  wechatHealthCache.value = value;
  wechatHealthCache.at = Date.now();
  wechatHealthCache.pending = null;
  return value;
}

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
function channelStatus(c) {
  if (!c.enabled) return "disabled";
  if (c.mode === "wechat_pc") {
    const state = wechatState.get(c.id);
    return state?.loggedIn ? "connected" : state?.child ? "connecting" : "failed";
  }
  if (c.mode === "dws") return dwsState.has(c.id) ? "connected" : "failed";
  return channels.has(c.id) ? (channels.get(c.id).connected ? "connected" : "connecting") : "failed";
}

function getWechatConfigEntry() {
  return loadConfig().find((item) => item.mode === "wechat_pc") || null;
}

async function getWechatControlStatus() {
  const cfg = getWechatConfigEntry();
  const enabled = !!cfg?.enabled;
  const [processRunning, service] = await Promise.all([isWeChatProcessRunning(), readWechatServiceStatus(cfg)]);
  const state = cfg ? wechatState.get(cfg.id) : null;
  const serviceRunning = !!service?.running;
  const loggedIn = !!service?.receive?.ok;
  if (state) {
    state.connected = serviceRunning;
    state.loggedIn = loggedIn;
    if (service?.last_error) state.lastError = service.last_error;
    else if (loggedIn) state.lastError = "";
  }
  let phase = "disabled";
  if (enabled && loggedIn) phase = "connected";
  else if (enabled && processRunning) phase = "waiting_for_scan";
  else if (enabled) phase = "starting";
  return {
    ok: true,
    supported: process.platform === "win32",
    configured: !!cfg,
    enabled,
    channelId: cfg?.id || WECHAT_CHANNEL_ID,
    phase,
    processRunning,
    serviceRunning,
    loggedIn,
    executable: wechatLaunchState.executable || findWeChatExecutable(),
    launchedAt: wechatLaunchState.launchedAt || null,
    account: loggedIn ? {
      id: service?.receive?.details?.account_id || "",
      nickname: service?.receive?.details?.nickname || "",
    } : null,
    error: state?.lastError || wechatLaunchState.lastError || service?.last_error || "",
  };
}

async function toggleWechatChannel(enabled) {
  if (process.platform !== "win32") throw new Error("微信个人号通道仅支持 Windows");
  const cfgs = loadConfig();
  let index = cfgs.findIndex((item) => item.mode === "wechat_pc");
  const previous = index >= 0 ? cfgs[index] : {};
  const next = {
    ...previous,
    id: previous.id || WECHAT_CHANNEL_ID,
    platform: "wechat",
    name: previous.name || "微信个人号",
    mode: "wechat_pc",
    configFile: previous.configFile || DEFAULT_WECHAT_CONFIG,
    enabled: !!enabled,
  };
  wechatHealthCache.at = 0;
  wechatHealthCache.value = null;

  if (enabled) {
    try {
      stopWechatChannel(next.id);
      await launchWeChatLoginWindow();
    }
    catch (error) {
      wechatLaunchState.lastError = error?.message ?? String(error);
      throw error;
    }
  }
  if (index >= 0) cfgs[index] = next;
  else cfgs.push(next);
  saveConfig(cfgs);
  syncChannels();
  log(`[微信开关] ${enabled ? "开启，等待扫码/登录" : "关闭"}`);
  return getWechatControlStatus();
}
function writeStatus() {
  const cfgs = loadConfig();
  const items = cfgs.map((c) => ({
    id: c.id, platform: c.platform, name: c.name, mode: c.mode, enabled: !!c.enabled,
    status: channelStatus(c),
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
  for (const cfg of cfgs) if (cfg.enabled && cfg.mode !== "dws" && cfg.mode !== "wechat_pc" && cfg.appKey && cfg.appSecret && !channels.has(cfg.id)) connectChannel(cfg);
  for (const id of [...dwsState.keys()]) { const cfg = byId.get(id); if (!cfg || !cfg.enabled) stopDwsListener(id); }
  for (const cfg of cfgs) if (cfg.enabled && cfg.mode === "dws" && !dwsState.has(cfg.id)) startDwsListener(cfg);
  for (const id of [...wechatState.keys()]) {
    const cfg = byId.get(id);
    const current = wechatState.get(id)?.cfg;
    if (!cfg || !cfg.enabled || cfg.mode !== "wechat_pc") stopWechatChannel(id);
    else if ((cfg.configFile || DEFAULT_WECHAT_CONFIG) !== (current?.configFile || DEFAULT_WECHAT_CONFIG)) { stopWechatChannel(id); startWechatChannel(cfg); }
  }
  for (const cfg of cfgs) if (cfg.enabled && cfg.mode === "wechat_pc" && !wechatState.has(cfg.id)) startWechatChannel(cfg);
  log(`[sync] 已连接通道: ${[...channels.keys()].join(", ") || "(无)"}${dwsState.size ? " | dws: " + [...dwsState.keys()].join(", ") : ""}${wechatState.size ? " | wechat: " + [...wechatState.keys()].join(", ") : ""}`);
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
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (data) => {
      body += data;
      if (body.length > 1024 * 1024) reject(new Error("request body is too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}
const httpServer = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowOrigin = typeof origin === "string" && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin) ? origin : null;
  const headers = {
    "Content-Type": "application/json",
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin, Vary: "Origin" } : {}),
  };
  const send = (code, obj) => { res.writeHead(code, headers); res.end(JSON.stringify(obj)); };
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...headers,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  const path = new URL(req.url, "http://localhost").pathname;
  if (req.method === "GET" && path === "/api/channels") {
    const items = loadConfig().map((c) => ({
      id: c.id,
      platform: c.platform,
      name: c.name,
      mode: c.mode,
      enabled: c.enabled,
      status: channelStatus(c),
    }));
    return send(200, { ok: true, channels: items });
  }
  if (req.method === "GET" && path === "/api/wechat/status") {
    try { return send(200, await getWechatControlStatus()); }
    catch (error) { return send(500, { ok: false, error: error?.message ?? String(error) }); }
  }
  if (req.method === "POST" && path === "/api/wechat/toggle") {
    try {
      const body = await readJsonBody(req);
      if (typeof body.enabled !== "boolean") return send(400, { ok: false, error: "enabled 必须是布尔值" });
      return send(200, await toggleWechatChannel(body.enabled));
    } catch (error) {
      return send(500, { ok: false, error: error?.message ?? String(error) });
    }
  }
  if (req.method === "POST" && path === "/api/channels") {
    let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
      try {
        const cfg = JSON.parse(body || "{}");
        if (!cfg.id || (!["dws", "wechat_pc"].includes(cfg.mode) && (!cfg.appKey || !cfg.appSecret))) return send(400, { ok: false, error: "需要 id；stream 模式还需要 appKey/appSecret" });
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
httpServer.listen(BRIDGE_PORT, "127.0.0.1", () => log(`[管理API] http://127.0.0.1:${BRIDGE_PORT}/api/channels · /api/wechat/status · /api/wechat/toggle`));

function shutdown() {
  for (const [, ch] of channels) try { ch.client.disconnect(); } catch {}
  for (const id of [...dwsState.keys()]) stopDwsListener(id);
  for (const id of [...wechatState.keys()]) stopWechatChannel(id);
  try { httpServer.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
