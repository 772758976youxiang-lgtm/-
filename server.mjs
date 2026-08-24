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
const MAP_FILE = process.env.DSH_MAP_FILE || path.join(os.homedir(), ".dsh-im-bridge-map.json");
const STATUS_FILE = process.env.DSH_STATUS_FILE || path.join(os.homedir(), ".dsh-im-channels-status.json");
const DWS_BIN = process.env.DWS_BIN || path.join(os.homedir(), ".local", "bin", "dws");
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = process.env.DSH_WECHAT_PYTHON || (process.platform === "win32" ? "python" : "python3");
const DEFAULT_WECHAT_CONFIG = process.env.DSH_WECHAT_CONFIG || path.join(os.homedir(), ".dsh-wechat-channel.json");
const WECHAT_EXECUTABLE = process.env.DSH_WECHAT_EXECUTABLE || "";
const WECHAT_CHANNEL_ID = "wechat-personal";
const WECHAT_BOTS_ROOT = path.join(os.homedir(), ".dsh", "wechat-bots");
const WECHAT_SERVICE_PORT_START = 5180;
const MANAGEMENT_TOKEN = process.env.DSH_CHANNEL_MANAGEMENT_TOKEN || "";
const PRESET_ROOT = path.join(os.homedir(), ".dsh", ".agent-presets");
const PRESET_ARCHIVE_ROOT = path.join(os.homedir(), ".dsh", "preset-archive");
const WECHAT_LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const WECHAT_ONBOARDING_POLL_MS = 5000;

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

// ---------- 通道专属 Agent 预设 ----------
function channelPresetId(cfg) {
  if (cfg?.mode === "wechat_pc") {
    const wxid = String(cfg?.accountId || cfg?.expectedAccountId || "").trim();
    if (!wxid) return "";
    const safeWxid = wxid.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return safeWxid ? "wechat-" + safeWxid : "";
  }
  const safe = String(cfg?.id || "channel").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "channel";
  return "channel-" + safe;
}
function yamlScalar(value) {
  return JSON.stringify(String(value || ""));
}
function channelPresetDefinition(cfg, directory) {
  return [
    "# 通道机器人专属预设：只挂载受权限会话约束的长期设定整理插件。",
    "- id: channel-self-profile",
    "  name: '@deepseek-ai/dsh-channel-im/self-profile'",
    "  config:",
    "    channelId: " + yamlScalar(cfg?.id || "channel"),
    "    profilePath: " + yamlScalar(path.join(directory, "self-profile.md")),
    "    authorizationPath: " + yamlScalar(path.join(directory, "self-profile-permissions.json")),
    "    maxChars: 12000",
    "",
  ].join("\n");
}
function ensureChannelPreset(cfg) {
  const preset = channelPresetId(cfg);
  // 微信账号尚未识别时不创建空壳预设；识别出 wxid 后才建立一对一预设。
  if (!preset) return "";
  const directory = path.join(PRESET_ROOT, preset);
  fs.mkdirSync(directory, { recursive: true });
  const metadata = path.join(directory, "preset.yml");
  const definition = path.join(directory, "agent.cordis.yml");
  const profile = path.join(directory, "self-profile.md");
  const permissions = path.join(directory, "self-profile-permissions.json");
  const marker = path.join(directory, ".dsh-channel-im-managed.json");
  const accountDescription = cfg?.mode === "wechat_pc" ? `，绑定微信 ID「${cfg?.accountId || cfg?.expectedAccountId}」` : "";
  const newDescription = "为通道「" + (cfg?.name || cfg?.id || "") + `」自动创建的独立机器人预设${accountDescription}，可持续完善自身设定。`;
  fs.writeFileSync(metadata, [
    "name: " + yamlScalar((cfg?.name || cfg?.id || "通道") + " 通道"),
    "description: " + yamlScalar(newDescription),
    "order: 100",
    "",
  ].join("\n"));
  const previous = fs.existsSync(definition) ? fs.readFileSync(definition, "utf8") : "";
  const legacyBlank = previous.trim() === "# 通道专属预设：人设与工具调用暂为空白。\n[]";
  if (!previous || legacyBlank || (previous.includes("@deepseek-ai/dsh-channel-im/self-profile") && !previous.includes("authorizationPath:"))) {
    fs.writeFileSync(definition, channelPresetDefinition(cfg, directory));
  }
  if (!fs.existsSync(profile)) {
    fs.writeFileSync(profile, "", "utf8");
  }
  if (!fs.existsSync(permissions)) {
    fs.writeFileSync(permissions, JSON.stringify({ authorizedContactId: "", authorizedSessionIds: [], updatedAt: Date.now() }, null, 2) + "\n", "utf8");
  }
  fs.writeFileSync(marker, JSON.stringify({
    owner: "@deepseek-ai/dsh-channel-im",
    channelId: String(cfg?.id || ""),
    wechatId: cfg?.mode === "wechat_pc" ? String(cfg?.accountId || cfg?.expectedAccountId || "") : "",
    updatedAt: Date.now(),
  }, null, 2) + "\n", "utf8");
  return preset;
}

function cleanupOrphanChannelPresets(cfgs) {
  if (!fs.existsSync(PRESET_ROOT)) return;
  const active = new Set(cfgs.map(channelPresetId).filter(Boolean));
  const wechatCfgs = cfgs.filter((item) => item.mode === "wechat_pc" && channelPresetId(item));
  for (const entry of fs.readdirSync(PRESET_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || (!entry.name.startsWith("channel-") && !entry.name.startsWith("wechat-")) || active.has(entry.name)) continue;
    const source = path.join(PRESET_ROOT, entry.name);
    const definition = path.join(source, "agent.cordis.yml");
    const marker = path.join(source, ".dsh-channel-im-managed.json");
    let managed = fs.existsSync(marker);
    if (!managed) {
      try { managed = fs.readFileSync(definition, "utf8").includes("@deepseek-ai/dsh-channel-im/self-profile"); } catch {}
    }
    if (!managed) continue;

    // 旧版固定微信通道的长期设定只在目标唯一且目标仍为空时迁移，避免跨机器人串设定。
    if (entry.name === "channel-wechat-personal" && wechatCfgs.length === 1) {
      const targetPreset = ensureChannelPreset(wechatCfgs[0]);
      if (!targetPreset) continue;
      const target = path.join(PRESET_ROOT, targetPreset);
      const sourceProfile = path.join(source, "self-profile.md");
      const targetProfile = path.join(target, "self-profile.md");
      try {
        const legacyProfile = fs.readFileSync(sourceProfile, "utf8");
        const currentProfile = fs.readFileSync(targetProfile, "utf8");
        if (legacyProfile.trim() && !currentProfile.trim()) {
          fs.writeFileSync(targetProfile, legacyProfile, "utf8");
          const sourcePermissions = path.join(source, "self-profile-permissions.json");
          if (fs.existsSync(sourcePermissions)) fs.copyFileSync(sourcePermissions, path.join(target, "self-profile-permissions.json"));
          log(`[通道预设] 已将旧微信长期设定迁移到 ${path.basename(target)}`);
        }
      } catch (error) { log(`[通道预设] 旧设定迁移失败: ${error?.message || error}`); }
    }

    fs.mkdirSync(PRESET_ARCHIVE_ROOT, { recursive: true });
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    let archived = path.join(PRESET_ARCHIVE_ROOT, `${entry.name}-${suffix}`), sequence = 1;
    while (fs.existsSync(archived)) archived = path.join(PRESET_ARCHIVE_ROOT, `${entry.name}-${suffix}-${sequence++}`);
    try {
      fs.renameSync(source, archived);
      log(`[通道预设] 已归档孤儿预设 ${entry.name} -> ${archived}`);
    } catch (error) { log(`[通道预设] 归档 ${entry.name} 失败: ${error?.message || error}`); }
  }
}
function ensureWechatPresetConfig(cfg) {
  const preset = ensureChannelPreset(cfg);
  if (!preset) return "";
  const configFile = cfg.configFile || DEFAULT_WECHAT_CONFIG;
  let custom = {};
  try { custom = JSON.parse(fs.readFileSync(configFile, "utf8")); } catch {}
  if (custom?.agent?.preset === preset) return preset;
  custom.agent = { ...(custom.agent || {}), preset };
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(custom, null, 2));
  log(`[通道预设] ${cfg.id} -> ${preset}`);
  return preset;
}

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
  const expectedPreset = ensureChannelPreset(cfg);
  if (!expectedPreset) throw new Error("微信账号尚未识别，无法创建账号专属 Agent 会话");
  const mapped = sessionMap[extKey];
  const existing = typeof mapped === "string" ? mapped : mapped?.sid;
  const existingPreset = typeof mapped === "object" ? mapped?.preset : undefined;
  if (existing && existingPreset === expectedPreset) {
    if (!(await isArchived(existing))) return { sid: existing, isNew: false };
    log(`[会话] ${existing} 已归档，消息将开启新会话`);
  } else if (existing) {
    log(`[会话] ${existing} 使用旧预设，后续消息将切换到 ${expectedPreset}`);
  }
  const created = await api("session.create", { workspaceId: await ensureWorkspace(cfg), agentPreset: expectedPreset });
  sessionMap[extKey] = { sid: created.sessionId, preset: expectedPreset };
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
const wechatLaunchStates = new Map(); // 通道id -> 仅记录 Harness 为该机器人新拉起的实例
const wechatOnboarding = new Map(); // 通道id -> { timer, running }
const wechatSupervisor = { pending: null, dependenciesReady: false, lastDependencyCheck: 0 };
const wechatHealthCache = new Map(); // 每个机器人独立的管理端口健康缓存
function wechatLaunchState(id) {
  if (!wechatLaunchStates.has(id)) wechatLaunchStates.set(id, { launchedAt: 0, executable: "", lastError: "", action: "idle", hwnd: 0 });
  return wechatLaunchStates.get(id);
}
function startWechatChannel(cfg) {
  if (wechatState.has(cfg.id)) return;
  ensureWechatPresetConfig(cfg);
  const state = { cfg, child: null, connected: false, loggedIn: false, stopping: false, lastError: "", lastStderr: "" };
  const start = () => {
    const configFile = cfg.configFile || DEFAULT_WECHAT_CONFIG;
    const runtimeRoot = path.dirname(configFile);
    const tempRoot = path.join(runtimeRoot, "tmp");
    fs.mkdirSync(path.join(runtimeRoot, "wechatauto_logs"), { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const args = ["-m", "wechat_channel", "run"];
    if (fs.existsSync(configFile)) args.push("--config", configFile);
    const child = spawn(PYTHON_BIN, args, {
      cwd: runtimeRoot,
      shell: false,
      env: {
        ...process.env,
        PYTHONPATH: [PLUGIN_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        TEMP: tempRoot,
        TMP: tempRoot,
        TMPDIR: tempRoot,
      },
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

function capture(command, args, timeoutMs = 5000, options = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { shell: false, windowsHide: true, ...options }); }
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

async function ensureWechatPythonDependencies() {
  if (wechatSupervisor.dependenciesReady) return;
  if (wechatSupervisor.pending) return wechatSupervisor.pending;
  wechatSupervisor.pending = (async () => {
    // zstandard 在 Python 3.14+ 被 requirements 的环境标记排除，不能把它当成必需项。
    const probe = await capture(PYTHON_BIN, ["-c", "import wechatauto"], 15000);
    if (probe.code === 0) {
      wechatSupervisor.dependenciesReady = true;
      wechatSupervisor.lastDependencyCheck = Date.now();
      return;
    }
    const requirements = path.join(PLUGIN_ROOT, "wechat_channel", "requirements.txt");
    if (!fs.existsSync(requirements)) throw new Error("微信通道依赖清单缺失: " + requirements);
    log("[微信托管] 正在补齐 Python 依赖");
    const install = await capture(PYTHON_BIN, ["-m", "pip", "install", "-r", requirements], 180000);
    if (install.code !== 0) throw new Error("微信通道依赖安装失败: " + (install.stderr || install.stdout || "python/pip 不可用").slice(-500));
    const verify = await capture(PYTHON_BIN, ["-c", "import wechatauto"], 15000);
    if (verify.code !== 0) throw new Error("微信通道依赖校验失败: " + (verify.stderr || verify.stdout || "未知错误").slice(-500));
    wechatSupervisor.dependenciesReady = true;
    wechatSupervisor.lastDependencyCheck = Date.now();
    log("[微信托管] Python 依赖已就绪");
  })();
  try { await wechatSupervisor.pending; }
  finally { wechatSupervisor.pending = null; }
}
function findWeChatExecutable(cfg = {}) {
  if (process.platform !== "win32") return "";
  const candidates = [
    cfg.wechatExecutable,
    WECHAT_EXECUTABLE,
    path.join(process.env.ProgramW6432 || "C:\\Program Files", "Tencent", "Weixin", "Weixin.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Tencent", "Weixin", "Weixin.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Tencent", "WeChat", "WeChat.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Tencent", "Weixin", "Weixin.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function probeWechat(kind) {
  const result = await capture(PYTHON_BIN, ["-m", "wechat_channel.probe", kind], 20000, {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, PYTHONPATH: [PLUGIN_ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  if (result.code !== 0) throw new Error(`微信 ${kind} 检查失败: ${(result.stderr || result.stdout || "未知错误").slice(-500)}`);
  try { const value = JSON.parse(result.stdout || "[]"); return Array.isArray(value) ? value : []; }
  catch { throw new Error(`微信 ${kind} 检查返回了无效数据`); }
}

async function detectWechatHookEndpoint(hwnd) {
  if (process.platform !== "win32" || !Number(hwnd)) return "";
  try {
    const windows = await probeWechat("all_windows");
    const bound = windows.find((item) => Number(item?.hwnd || 0) === Number(hwnd));
    const pid = Number(bound?.pid || 0);
    if (!pid) return "";
    const netstat = await capture("netstat.exe", ["-ano", "-p", "tcp"], 8000);
    const ports = [];
    for (const line of String(netstat.stdout || "").split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (match && Number(match[2]) === pid) ports.push(Number(match[1]));
    }
    ports.sort((a, b) => (a === 30001 ? -1 : b === 30001 ? 1 : a - b));
    for (const port of [...new Set(ports)]) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/QueryDB/status`, { signal: controller.signal });
        if (response.ok) return `http://127.0.0.1:${port}`;
      } catch {}
      finally { clearTimeout(timer); }
    }
  } catch (error) {
    log(`[微信 Hook] 自动检测失败: ${error?.message ?? error}`);
  }
  return "";
}

function accountKey(item) { return String(item?.account || item?.wxid || item?.id || "").trim(); }
function accountActivity(item) { return Number(item?.last_activity || item?.lastActivity || 0); }
function updateWechatConfigEntry(id, patch) {
  const cfgs = loadConfig();
  const index = cfgs.findIndex((item) => item.id === id && item.mode === "wechat_pc");
  if (index < 0) throw new Error(`微信机器人不存在: ${id}`);
  cfgs[index] = { ...cfgs[index], ...patch };
  saveConfig(cfgs);
  return cfgs[index];
}
function nextWechatPort(cfgs) {
  const used = new Set(cfgs.filter((item) => item.mode === "wechat_pc").map((item) => Number(item.servicePort || 0)));
  let port = WECHAT_SERVICE_PORT_START;
  while (used.has(port)) port += 1;
  return port;
}
function makeWechatRuntimeConfig(cfg, accountId = "", hwnd = 0, hookEndpoint = "") {
  const root = path.dirname(cfg.configFile);
  return {
    service: { host: "127.0.0.1", port: Number(cfg.servicePort) },
    channel: { type: "wechat_pc", account_id: accountId || "auto", poll_interval_ms: 1500, recent_conversation_limit: 15, message_limit_per_conversation: 3 },
    send: { primary: hookEndpoint ? "aixed_hook" : "wechatauto_uia", hook_endpoint: hookEndpoint, group_reply_mention_sender: true, fallbacks: ["wechatauto_uia", "wechatauto_ocr"], timeout_seconds: 90, max_retries: 2 },
    agent: { adapter: "dsh", endpoint: HOST, token_env: "AGENT_TOKEN", session_scope: "conversation", workspace_dir: path.join(CWD, "im-workspaces", cfg.id), preset: channelPresetId(cfg), reply_timeout_seconds: 90 },
    policy: { direct_message: "allow", group_message: "allow", group_whitelist: [], group_blacklist: [], direct_whitelist: [], direct_blacklist: [], group_reply_only_when_mentioned_groups: [], profile_write_authorized_contact: "", sensitive_words: [], rate_limit_per_minute: 10, enabled: true },
    state: { database: path.join(root, "state.sqlite3"), recent_context_limit: 200, media_dir: path.join(root, "media") },
    runtime: { echo: false, wechatHwnd: Number(hwnd || 0), managedBy: "harness", managedDevice: os.hostname() },
  };
}
function writeWechatRuntimeConfig(cfg, accountId = cfg.accountId || "", hwnd = cfg.wechatHwnd || 0, hookEndpoint = "") {
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(cfg.configFile, "utf8")); } catch {}
  const generated = makeWechatRuntimeConfig(cfg, accountId, hwnd, hookEndpoint);
  generated.policy = { ...generated.policy, ...(previous.policy || {}) };
  fs.mkdirSync(path.dirname(cfg.configFile), { recursive: true });
  fs.writeFileSync(cfg.configFile, JSON.stringify(generated, null, 2));
}

async function launchWeChatLoginWindow(cfg) {
  if (process.platform !== "win32") throw new Error("微信个人号通道仅支持 Windows");
  const executable = findWeChatExecutable(cfg);
  if (!executable) throw new Error("未找到微信客户端，请安装微信 4.x，或配置 DSH_WECHAT_EXECUTABLE");
  const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
  child.unref();
  const launch = wechatLaunchState(cfg.id);
  launch.launchedAt = Date.now(); launch.executable = executable; launch.lastError = ""; launch.action = "waiting_for_window";
  log(`[微信机器人 ${cfg.id}] 已单独拉起新微信登录实例，不接管现有微信`);
  return executable;
}

async function bindWechatCandidate(cfg, baselineAccounts, baselineWindows) {
  const [accounts, windows] = await Promise.all([probeWechat("accounts"), probeWechat("all_windows")]);
  const used = new Set(loadConfig().filter((item) => item.mode === "wechat_pc" && item.id !== cfg.id).map((item) => String(item.accountId || "")).filter(Boolean));
  const baseline = new Map(baselineAccounts.map((item) => [accountKey(item), accountActivity(item)]));
  const expectedAccountId = String(cfg.expectedAccountId || "");
  const candidates = accounts.filter((item) => {
    const key = accountKey(item); if (!key || used.has(key)) return false;
    return key === expectedAccountId || !baseline.has(key) || accountActivity(item) > Number(baseline.get(key) || 0);
  }).sort((a, b) => accountActivity(b) - accountActivity(a));
  const oldWindows = new Set(baselineWindows.map((item) => Number(item?.hwnd || 0)));
  const newWindow = windows
    .filter((item) => !oldWindows.has(Number(item?.hwnd || 0)))
    .sort((a, b) => Number(b?.state === "main") - Number(a?.state === "main")
      || Number(b?.visible) - Number(a?.visible)
      || Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0))[0] || null;
  if (newWindow) {
    const phase = newWindow.state === "main" ? "detecting_logged_in_account" : "waiting_for_login";
    const launch = wechatLaunchState(cfg.id); launch.hwnd = Number(newWindow.hwnd || 0); launch.action = phase;
    updateWechatConfigEntry(cfg.id, { wechatHwnd: launch.hwnd, onboardingPhase: phase, onboardingWindowState: newWindow.state || "unknown", onboardingUpdatedAt: Date.now() });
  }
  // 账号数据库目录可能在登录小窗出现时就更新，不能据此判定已经登录。
  // 只有微信主界面尺寸的窗口出现后，才允许绑定账号并启动通道。
  if (!newWindow || newWindow.state !== "main") return null;
  if (!candidates.length) return null;
  const account = candidates[0], accountId = accountKey(account), hwnd = Number(newWindow?.hwnd || wechatLaunchState(cfg.id).hwnd || 0);
  const next = updateWechatConfigEntry(cfg.id, {
    accountId, expectedAccountId: "", onboardingBaselineAccounts: [], onboardingBaselineWindows: [],
    wechatHwnd: hwnd, enabled: true, onboardingPhase: "validating_channel", onboardingUpdatedAt: Date.now(),
    name: String(account?.nickname || account?.remark || cfg.name || "微信机器人"),
  });
  ensureChannelPreset(next);
  const hookEndpoint = await detectWechatHookEndpoint(hwnd);
  writeWechatRuntimeConfig(next, accountId, hwnd, hookEndpoint);
  log(`[微信机器人 ${next.id}] 发送顺序: ${hookEndpoint ? `Hook ${hookEndpoint} → UIA/OCR` : "UIA/OCR（未检测到属于该窗口的 Hook）"}`);
  stopWechatChannel(next.id); startWechatChannel(next);
  const launch = wechatLaunchState(next.id); launch.action = "validating_channel"; launch.hwnd = hwnd;
  return { cfg: next, account };
}

async function onboardingTick(id) {
  const state = wechatOnboarding.get(id); if (!state || state.running) return;
  state.running = true;
  try {
    let cfg = loadConfig().find((item) => item.id === id && item.mode === "wechat_pc");
    if (!cfg) { clearInterval(state.timer); wechatOnboarding.delete(id); return; }
    const bound = cfg.accountId ? { cfg } : await bindWechatCandidate(cfg, state.baselineAccounts, state.baselineWindows);
    if (!bound) {
      const deadline = Number(cfg.onboardingDeadlineAt || 0);
      if (deadline && Date.now() >= deadline) {
        updateWechatConfigEntry(id, {
          enabled: false,
          onboardingPhase: "login_timeout",
          onboardingError: "3 分钟内未完成微信登录，本次接入任务已自动取消",
          onboardingUpdatedAt: Date.now(),
        });
        const launch = wechatLaunchState(id); launch.action = "login_timeout"; launch.lastError = "";
        clearInterval(state.timer); wechatOnboarding.delete(id); writeStatus();
        log(`[微信机器人 ${id}] 3 分钟内未检测到已登录主界面，本次接入任务已取消；微信进程保持不变`);
      }
      return;
    }
    cfg = bound.cfg;
    const service = await readWechatServiceStatus(cfg, true);
    const sendReady = Array.isArray(service?.send) && service.send.some((item) => item?.ok);
    if (service?.running && service?.receive?.ok && sendReady) {
      const nickname = service?.receive?.details?.nickname || bound.account?.nickname || cfg.name || "微信";
      updateWechatConfigEntry(id, { name: nickname, onboardingPhase: "connected", onboardingUpdatedAt: Date.now() });
      const launch = wechatLaunchState(id); launch.action = "connected"; launch.lastError = "";
      clearInterval(state.timer); wechatOnboarding.delete(id); writeStatus();
      log(`[微信机器人 ${id}] 通道验证通过，账号=${cfg.accountId}`);
    }
  } catch (error) {
    const message = error?.message ?? String(error); const launch = wechatLaunchState(id);
    launch.lastError = message; launch.action = "error";
    try { updateWechatConfigEntry(id, { onboardingPhase: "error", onboardingError: message, onboardingUpdatedAt: Date.now() }); } catch {}
    log(`[微信机器人 ${id}] 分步检查失败: ${message}`);
  } finally { state.running = false; writeStatus(); }
}

function startWechatOnboardingMonitor(cfg, baselineAccounts, baselineWindows) {
  const old = wechatOnboarding.get(cfg.id); if (old?.timer) clearInterval(old.timer);
  const onboarding = { baselineAccounts: baselineAccounts || [], baselineWindows: baselineWindows || [], running: false, timer: null };
  onboarding.timer = setInterval(() => onboardingTick(cfg.id), WECHAT_ONBOARDING_POLL_MS);
  wechatOnboarding.set(cfg.id, onboarding);
  setTimeout(() => onboardingTick(cfg.id), 2500);
}
function resumePendingWechatOnboarding() {
  for (const cfg of loadConfig()) {
    if (cfg.mode !== "wechat_pc" || !cfg.enabled || cfg.accountId || !cfg.servicePort) continue;
    if (!["checking_environment", "building_configuration", "launching_new_wechat", "waiting_for_scan", "waiting_for_login", "detecting_logged_in_account", "error"].includes(String(cfg.onboardingPhase || ""))) continue;
    startWechatOnboardingMonitor(cfg, Array.isArray(cfg.onboardingBaselineAccounts) ? cfg.onboardingBaselineAccounts : [], Array.isArray(cfg.onboardingBaselineWindows) ? cfg.onboardingBaselineWindows : []);
    log(`[微信机器人 ${cfg.id}] 已恢复未完成的登录检测`);
  }
}

function wechatManagementUrl(cfg) {
  let service = { host: "127.0.0.1", port: Number(cfg?.servicePort || 5176) };
  const configFile = cfg?.configFile || DEFAULT_WECHAT_CONFIG;
  try {
    const custom = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (custom?.service && typeof custom.service === "object") service = { ...service, ...custom.service };
  } catch {}
  const host = service.host === "localhost" || service.host === "::1" ? "127.0.0.1" : service.host;
  return `http://${host}:${Number(service.port || 5176)}/api/status`;
}
function wechatManagementBase(cfg) { return wechatManagementUrl(cfg).replace(/\/api\/status$/, ""); }

async function readWechatServiceStatus(cfg, fresh = false) {
  if (!cfg?.enabled) return null;
  const url = wechatManagementUrl(cfg);
  const cache = wechatHealthCache.get?.(url);
  if (!fresh && cache && Date.now() - cache.at < 3000) return cache.value;
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
  const value = await probe;
  if (wechatHealthCache.set) wechatHealthCache.set(url, { at: Date.now(), value });
  return value;
}

function normalizedContactValue(value) {
  return String(value || "").trim().toLocaleLowerCase();
}
function contactLabels(contact) {
  return [contact?.id, contact?.remark, contact?.name, contact?.nickname, contact?.wechat_id]
    .map(normalizedContactValue).filter(Boolean);
}
function resolveWechatContact(items, target) {
  const query = normalizedContactValue(target);
  if (!query) throw new Error("主动发送需要 target");
  if (["filehelper", "文件传输助手", "self"].includes(query)) {
    return { id: "filehelper", name: "文件传输助手", type: "direct", nickname: "文件传输助手", remark: "", wechat_id: "" };
  }
  const contacts = Array.isArray(items) ? items : [];
  const byId = contacts.filter((item) => normalizedContactValue(item?.id) === query);
  const exact = byId.length ? byId : contacts.filter((item) => contactLabels(item).includes(query));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`联系人“${target}”匹配到 ${exact.length} 条记录，请使用微信内部 ID 精确指定`);
  const partial = contacts.filter((item) => contactLabels(item).some((label) => label.includes(query)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`联系人“${target}”存在 ${partial.length} 个模糊匹配，请使用完整备注、昵称、微信号或内部 ID`);
  throw new Error(`未找到联系人“${target}”；请先在该微信账号中产生会话，或使用微信内部 ID`);
}
async function selectWechatBot(channelId = "") {
  const configs = loadConfig().filter((item) => item.mode === "wechat_pc" && item.accountId && item.enabled);
  if (channelId) {
    const selected = configs.find((item) => item.id === channelId);
    if (!selected) throw new Error(`微信机器人不存在、未启用或尚未绑定: ${channelId}`);
    const status = await wechatBotStatus(selected);
    if (!status.loggedIn) throw new Error(`微信机器人 ${channelId} 当前未连接`);
    return selected;
  }
  const ready = [];
  for (const item of configs) {
    const status = await wechatBotStatus(item);
    if (status.loggedIn) ready.push(item);
  }
  if (ready.length === 1) return ready[0];
  if (!ready.length) throw new Error("当前没有已连接且可发送的微信机器人");
  throw new Error("当前有多个已连接微信机器人，请指定 channelId");
}
async function fetchWechatJson(cfg, apiPath, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15000));
  try {
    const response = await fetch(wechatManagementBase(cfg) + apiPath, {
      method: options.method || "GET",
      headers: options.body === undefined ? {} : { "Content-Type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value?.ok === false) throw new Error(value?.error || `微信通道 HTTP ${response.status}`);
    return value;
  } finally { clearTimeout(timer); }
}
async function sendWechatMessage(options = {}) {
  const target = String(options.target || "").trim();
  const text = String(options.text || "").trim();
  if (!target || !text) throw new Error("主动发送需要 target 和 text");
  if (text.length > 10000) throw new Error("主动发送内容不能超过 10000 个字符");
  const cfg = await selectWechatBot(String(options.channelId || "").trim());
  const contacts = await fetchWechatJson(cfg, "/api/contacts?limit=500");
  const contact = resolveWechatContact(contacts?.items, target);
  const sourceMessageId = `harness-manual-${Date.now()}`;
  const queued = await fetchWechatJson(cfg, "/api/send", {
    method: "POST",
    body: { target_id: contact.id, text, source_message_id: sourceMessageId },
  });
  const key = String(queued?.idempotency_key || "");
  let delivery = { status: "queued", driver: "", attempts: 0, error: null };
  const deadline = Date.now() + 90000;
  while (key && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const history = await fetchWechatJson(cfg, "/api/history?limit=100");
    const item = (history?.items || []).find((entry) => entry?.idempotency_key === key);
    if (!item) continue;
    delivery = { status: item.status, driver: item.driver || "", attempts: Number(item.attempts || 0), error: item.error || null };
    if (["sent", "failed"].includes(item.status)) break;
  }
  if (delivery.status === "failed") throw new Error(`微信发送失败: ${delivery.error || "发送驱动未返回原因"}`);
  return {
    ok: true,
    channelId: cfg.id,
    target: { id: contact.id, name: contact.name || contact.remark || contact.nickname || contact.id, type: contact.type || "direct" },
    delivery,
    idempotencyKey: key,
  };
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

function getWechatConfigEntry(channelId = "") {
  const all = loadConfig().filter((item) => item.mode === "wechat_pc");
  return (channelId ? all.find((item) => item.id === channelId) : all[0]) || null;
}

async function wechatBotStatus(cfg) {
  // 状态查询同时承担账号预设自愈：用户手动删除后会按 wxid 自动重建。
  ensureChannelPreset(cfg);
  const service = await readWechatServiceStatus(cfg);
  const state = wechatState.get(cfg.id), launch = wechatLaunchState(cfg.id);
  const serviceRunning = !!service?.running;
  const sendReady = Array.isArray(service?.send) && service.send.some((item) => item?.ok);
  const loggedIn = !!cfg.accountId && serviceRunning && !!service?.receive?.ok && sendReady;
  if (state) { state.connected = serviceRunning; state.loggedIn = loggedIn; }
  const phase = loggedIn ? "connected" : String(cfg.onboardingPhase || (cfg.accountId ? "starting_bridge" : "waiting_for_login"));
  return {
    channelId: cfg.id, name: cfg.name || "微信机器人", enabled: !!cfg.enabled, phase,
    servicePort: Number(cfg.servicePort || 0), serviceRunning, sendReady, loggedIn,
    account: cfg.accountId ? { id: cfg.accountId, nickname: service?.receive?.details?.nickname || cfg.name || "微信" } : null,
    launchedAt: launch.launchedAt || null, wechatHwnd: Number(cfg.wechatHwnd || launch.hwnd || 0),
    stage: phase, error: cfg.onboardingError || state?.lastError || launch.lastError || service?.last_error || "",
    reportIntervalSeconds: 60, monitorIntervalSeconds: WECHAT_ONBOARDING_POLL_MS / 1000,
    onboardingDeadlineAt: Number(cfg.onboardingDeadlineAt || 0) || null,
  };
}
async function getWechatControlStatus(channelId = "") {
  const cfgs = loadConfig().filter((item) => item.mode === "wechat_pc" && (!channelId || item.id === channelId));
  const bots = await Promise.all(cfgs.map(wechatBotStatus));
  return { ok: true, supported: process.platform === "win32", bots, phase: bots.length === 1 ? bots[0].phase : (bots.some((item) => item.phase === "connected") ? "connected" : "disabled") };
}

async function setupWechatChannel(options = {}) {
  if (process.platform !== "win32") throw new Error("微信个人号通道仅支持 Windows");
  const requestedId = String(options.channelId || "").trim();
  let cfgs = loadConfig();
  let cfg = requestedId ? cfgs.find((item) => item.id === requestedId && item.mode === "wechat_pc") : null;
  if (!requestedId) {
    // “重新连接”优先复用最近停用的已绑定机器人，保留其会话、预设和规则。
    cfg = cfgs
      .filter((item) => item.mode === "wechat_pc" && item.accountId && !item.enabled)
      .sort((a, b) => Number(b.onboardingUpdatedAt || 0) - Number(a.onboardingUpdatedAt || 0))[0] || null;
    if (!cfg) cfg = cfgs
      .filter((item) => item.mode === "wechat_pc" && !item.accountId && item.servicePort)
      .sort((a, b) => Number(b.onboardingUpdatedAt || 0) - Number(a.onboardingUpdatedAt || 0))[0] || null;
    if (cfg) {
      cfgs = cfgs.filter((item) => item.id === cfg.id || item.mode !== "wechat_pc" || item.accountId);
      saveConfig(cfgs);
    }
  }
  if (!cfg) {
    if (!requestedId) {
      cfgs = cfgs.filter((item) => item.mode !== "wechat_pc" || item.accountId);
    }
    const id = `wechat-bot-${Date.now().toString(36)}`;
    const root = path.join(WECHAT_BOTS_ROOT, id);
    cfg = { id, platform: "wechat", name: String(options.name || "微信机器人").trim() || "微信机器人", mode: "wechat_pc", configFile: path.join(root, "config.json"), servicePort: nextWechatPort(cfgs), accountId: "", wechatHwnd: 0, managedBy: "harness", managedDevice: os.hostname(), enabled: true };
    cfgs.push(cfg); saveConfig(cfgs);
  } else {
    stopWechatChannel(cfg.id);
    cfg = updateWechatConfigEntry(cfg.id, {
      expectedAccountId: cfg.accountId || cfg.expectedAccountId || "",
      accountId: "", wechatHwnd: 0, enabled: true, onboardingError: "",
    });
  }
  const launch = wechatLaunchState(cfg.id); launch.action = "checking_environment"; launch.lastError = "";
  cfg = updateWechatConfigEntry(cfg.id, { onboardingPhase: "checking_environment", onboardingStartedAt: Date.now(), onboardingUpdatedAt: Date.now() });
  await ensureWechatPythonDependencies();
  cfg = updateWechatConfigEntry(cfg.id, { onboardingPhase: "building_configuration", onboardingUpdatedAt: Date.now() });
  ensureChannelPreset(cfg); writeWechatRuntimeConfig(cfg);
  const [baselineAccounts, baselineWindows] = await Promise.all([probeWechat("accounts"), probeWechat("all_windows")]);
  cfg = updateWechatConfigEntry(cfg.id, {
    onboardingPhase: "launching_new_wechat", onboardingUpdatedAt: Date.now(),
    onboardingBaselineAccounts: baselineAccounts.map((item) => ({ account: accountKey(item), last_activity: accountActivity(item) })),
    onboardingBaselineWindows: baselineWindows.map((item) => ({ hwnd: Number(item?.hwnd || 0) })).filter((item) => item.hwnd),
  });
  await launchWeChatLoginWindow(cfg);
  cfg = updateWechatConfigEntry(cfg.id, {
    onboardingPhase: "waiting_for_login",
    onboardingDeadlineAt: Date.now() + WECHAT_LOGIN_TIMEOUT_MS,
    onboardingUpdatedAt: Date.now(),
  });
  startWechatOnboardingMonitor(cfg, baselineAccounts, baselineWindows);
  syncChannels();
  return getWechatControlStatus(cfg.id);
}
async function stopWechatManagedChannel(channelId) {
  const cfg = getWechatConfigEntry(channelId); if (!cfg) throw new Error("微信机器人不存在");
  const onboarding = wechatOnboarding.get(cfg.id); if (onboarding?.timer) clearInterval(onboarding.timer); wechatOnboarding.delete(cfg.id);
  stopWechatChannel(cfg.id); updateWechatConfigEntry(cfg.id, { enabled: false, onboardingPhase: "stopped", onboardingUpdatedAt: Date.now() });
  const launch = wechatLaunchState(cfg.id); launch.action = "stopped";
  // 只停止插件桥接；不关闭、不结束、不接管任何微信进程。
  return getWechatControlStatus(cfg.id);
}
function readWechatRules(channelId = "") {
  const cfg = getWechatConfigEntry(channelId);
  const file = cfg?.configFile || DEFAULT_WECHAT_CONFIG;
  let custom = {};
  try { custom = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  return { ok: true, policy: custom.policy || {} };
}
async function updateWechatRules(policy, channelId = "") {
  const cfg = getWechatConfigEntry(channelId);
  if (!cfg) throw new Error("微信通道尚未配置");
  const modes = new Set(["allow", "whitelist", "deny"]);
  const cleanList = (value) => [...new Set((Array.isArray(value) ? value : []).map((v) => String(v).trim()).filter(Boolean))].slice(0, 500);
  const next = {
    direct_message: modes.has(policy?.direct_message) ? policy.direct_message : "allow",
    group_message: modes.has(policy?.group_message) ? policy.group_message : "allow",
    direct_whitelist: cleanList(policy?.direct_whitelist), direct_blacklist: cleanList(policy?.direct_blacklist),
    group_whitelist: cleanList(policy?.group_whitelist), group_blacklist: cleanList(policy?.group_blacklist),
    group_reply_only_when_mentioned_groups: cleanList(policy?.group_reply_only_when_mentioned_groups),
    profile_write_authorized_contact: String(policy?.profile_write_authorized_contact || "").trim().slice(0, 256),
  };
  const file = cfg.configFile || DEFAULT_WECHAT_CONFIG;
  let custom = {};
  try { custom = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (custom.policy) delete custom.policy.group_reply_only_when_mentioned;
  custom.policy = { ...(custom.policy || {}), ...next };
  fs.writeFileSync(file, JSON.stringify(custom, null, 2));
  stopWechatChannel(cfg.id); startWechatChannel(cfg);
  return { ok: true, channelId: cfg.id, policy: custom.policy };
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
  for (const cfg of cfgs) ensureChannelPreset(cfg);
  cleanupOrphanChannelPresets(cfgs);
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
    else if ((cfg.configFile || DEFAULT_WECHAT_CONFIG) !== (current?.configFile || DEFAULT_WECHAT_CONFIG)) { stopWechatChannel(id); if (cfg.accountId && fs.existsSync(cfg.configFile)) startWechatChannel(cfg); }
  }
  // Harness 重启只恢复已绑定的桥接服务；绝不扫描、附着、关闭或拉起微信客户端。
  for (const cfg of cfgs) if (cfg.enabled && cfg.mode === "wechat_pc" && cfg.accountId && fs.existsSync(cfg.configFile) && !wechatState.has(cfg.id)) startWechatChannel(cfg);
  log(`[sync] 已连接通道: ${[...channels.keys()].join(", ") || "(无)"}${dwsState.size ? " | dws: " + [...dwsState.keys()].join(", ") : ""}${wechatState.size ? " | wechat: " + [...wechatState.keys()].join(", ") : ""}`);
  writeStatus();
}

let reloadTimer;
try {
  fs.watch(CONFIG_FILE, () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { log("[配置变更]"); syncChannels(); }, 800); });
} catch (e) { log("[watch 配置失败]", e?.message ?? e); }
syncChannels();
resumePendingWechatOnboarding();

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
  const requestUrl = new URL(req.url, "http://localhost");
  const path = requestUrl.pathname;
  const harnessMutation = (req.method === "POST" && ["/api/wechat/setup", "/api/wechat/stop", "/api/wechat/send"].includes(path))
    || (req.method === "POST" && path === "/api/channels")
    || (req.method === "DELETE" && path.startsWith("/api/channels/"));
  if (harnessMutation) {
    const authorization = String(req.headers.authorization || "");
    if (!MANAGEMENT_TOKEN || authorization !== `Bearer ${MANAGEMENT_TOKEN}`) {
      return send(403, { ok: false, error: "通道生命周期只能由本机 Harness Agent 管理" });
    }
  }
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
    try { return send(200, await getWechatControlStatus(requestUrl.searchParams.get("channelId") || "")); }
    catch (error) { return send(500, { ok: false, error: error?.message ?? String(error) }); }
  }
  if (req.method === "GET" && path === "/api/wechat/rules") return send(200, readWechatRules(requestUrl.searchParams.get("channelId") || ""));
  if (req.method === "POST" && path === "/api/wechat/rules") {
    try { const body = await readJsonBody(req); return send(200, await updateWechatRules(body.policy, body.channelId)); }
    catch (error) { return send(400, { ok: false, error: error?.message ?? String(error) }); }
  }
  if (req.method === "GET" && path === "/api/wechat/contacts") {
    try {
      const cfg = getWechatConfigEntry(requestUrl.searchParams.get("channelId") || "");
      if (!cfg) return send(404, { ok: false, error: "微信机器人不存在" });
      const response = await fetch(`${wechatManagementBase(cfg)}/api/contacts?limit=200`);
      return send(response.status, await response.json());
    } catch (error) { return send(502, { ok: false, error: error?.message ?? String(error) }); }
  }
  if (req.method === "POST" && path === "/api/wechat/setup") {
    try { return send(200, await setupWechatChannel(await readJsonBody(req))); }
    catch (error) { return send(500, { ok: false, error: error?.message ?? String(error) }); }
  }
  if (req.method === "POST" && path === "/api/wechat/stop") {
    try { const body = await readJsonBody(req); return send(200, await stopWechatManagedChannel(String(body.channelId || ""))); }
    catch (error) { return send(500, { ok: false, error: error?.message ?? String(error) }); }
  }
  if (req.method === "POST" && path === "/api/wechat/send") {
    try { return send(200, await sendWechatMessage(await readJsonBody(req))); }
    catch (error) { return send(400, { ok: false, error: error?.message ?? String(error) }); }
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
httpServer.listen(BRIDGE_PORT, "127.0.0.1", () => log(`[管理API] http://127.0.0.1:${BRIDGE_PORT}/api/channels · /api/wechat/status · /api/wechat/setup`));

function shutdown() {
  for (const [, ch] of channels) try { ch.client.disconnect(); } catch {}
  for (const id of [...dwsState.keys()]) stopDwsListener(id);
  for (const id of [...wechatState.keys()]) stopWechatChannel(id);
  for (const [, state] of wechatOnboarding) if (state?.timer) clearInterval(state.timer);
  try { httpServer.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
