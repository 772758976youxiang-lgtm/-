/**
 * @deepseek-ai/dsh-channel-im · DSH Bundle 插件入口（桥接服务行）
 *
 * cordis 插件：挂载时托管桥接子进程（本包 server.mjs），dispose→停止；
 * 崩溃自动重启（指数退避，上限30s）；读取 ~/.dsh-im-channels.json，管理API 5175。
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const CHANNEL_TOOL_NAME = "im_channel_manage";

function sessionIdOf(exec) {
  return String(exec?.agent?.session?.header?.id || exec?.agent?.id || "");
}

function externalChannelSessionIds(mapFile) {
  try {
    const value = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    return new Set(Object.values(value || {}).map((item) => typeof item === "string" ? item : item?.sid).filter(Boolean).map(String));
  } catch { return new Set(); }
}

function assertLocalHarnessSession(exec, mapFile) {
  const sessionId = sessionIdOf(exec);
  if (!sessionId) throw new Error(CHANNEL_TOOL_NAME + " requires a local Harness session");
  if (externalChannelSessionIds(mapFile).has(sessionId)) {
    throw new Error("external channel sessions cannot manage channel installation or lifecycle");
  }
}

function onboardingSummary(bot) {
  const labels = {
    checking_environment: "正在检查运行环境与依赖",
    building_configuration: "正在生成独立配置",
    launching_new_wechat: "正在拉起新的微信登录实例",
    waiting_for_login: "等待在微信窗口完成扫码、点击登录或手机确认",
    detecting_logged_in_account: "微信主界面已出现，正在识别登录账号",
    waiting_for_scan: "等待在微信窗口完成扫码、点击登录或手机确认",
    validating_channel: "已识别账号，正在验证收发通道",
    starting_bridge: "正在启动通道桥接",
    connected: "已连接",
    error: "构建失败",
    stopped: "已停止",
  };
  return `${bot?.name || "微信机器人"} (${bot?.channelId || ""})：${labels[bot?.phase] || bot?.phase || "正在检查"}${bot?.error ? `；${bot.error}` : ""}`;
}
function startWechatProgressMonitor(exec, baseUrl, token, channelId, monitors) {
  const previous = monitors.get(channelId); if (previous) clearInterval(previous);
  const followup = (text, summary = "微信机器人搭建进度") => {
    const id = `wechat-onboarding-${randomUUID()}`;
    exec.agent.followup({ id, role: "user", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-channel-im", form: "notice", summary } });
  };
  const check = async () => {
    try {
      const value = await managementRequest(baseUrl, token, `/api/wechat/status?channelId=${encodeURIComponent(channelId)}`);
      const bot = value?.bots?.[0]; if (!bot) throw new Error("通道记录不存在");
      if (bot.phase === "connected") {
        followup(`持续任务“把微信机器人 ${bot.name || channelId} 真正接入并验证可用”检测到 connected，但这只是进入最终验收阶段。请调用 im_channel_manage(status) 检查接收、Hook 优先与 UIA/OCR 兜底健康状态；确认可用后调用 im_channel_manage(confirm_wechat_ready, channelId=${channelId}) 完成任务。如果验收失败，继续诊断修复，不要宣告完成，定时心跳会继续。`, "微信机器人已连通，正在最终验收");
        return;
      }
      if (bot.phase === "stopped") {
        followup(`持续任务“接入微信机器人 ${bot.name || channelId}”已被停止。请向用户说明任务已停止。`, "微信机器人搭建已停止");
        clearInterval(monitors.get(channelId)); monitors.delete(channelId); return;
      }
      followup(`这是持续任务“把微信机器人 ${bot.name || channelId} 真正接入并验证可用”的每 1 分钟心跳。当前状态：${onboardingSummary(bot)}。你的职责不是只复述状态：先判断下一步；可由 Harness 修复的问题请继续调用工具诊断和处理，需要用户扫码、点击登录或手机确认时明确告诉用户，随后保持任务继续监控。即使 phase=error 也不要放弃或宣告结束。`);
    } catch (error) {
      followup(`持续任务“把微信机器人 ${channelId} 真正接入并验证可用”的心跳检查遇到问题：${error?.message || error}。请主动诊断并尝试修复，向用户汇报正在处理的步骤，不要因为一次检查失败而停止任务。`, "微信机器人搭建遇到问题");
    }
  };
  monitors.set(channelId, setInterval(check, 60000));
}

async function managementRequest(baseUrl, token, apiPath, options = {}) {
  let lastError;
  const maxAttempts = Math.max(1, Number(options.attempts || 3));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(baseUrl + apiPath, {
        method: options.method || "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok || value?.ok === false) throw new Error(value?.error || `channel management HTTP ${response.status}`);
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

function startDingtalkPersonLogin(authPath, token, loginChildren) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [authPath, "login"], {
      env: { ...process.env, DSH_CHANNEL_MANAGEMENT_TOKEN: token },
      windowsHide: true,
    });
    loginChildren.add(child);
    let output = "", settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const receive = (data) => {
      output += String(data);
      if (/https?:\/\//i.test(output) && /(?:code|码)/i.test(output)) {
        finish(output.trim().slice(-4000));
      }
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => {
      loginChildren.delete(child);
      if (!settled) finish(output.trim() || `钉钉登录进程已退出 code=${code}`);
    });
    const timer = setTimeout(() => finish(output.trim() || "扫码登录已启动，请查看随后显示的授权信息。"), 10000);
  });
}

async function validateDingtalkCredentials(appKey, appSecret) {
  const response = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey, appSecret }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || !value?.accessToken) {
    throw new Error("钉钉机器人凭证校验失败: " + (value?.message || value?.code || `HTTP ${response.status}`));
  }
}

function registerChannelManagerTool(ctx, options) {
  const { baseUrl, token, mapFile, authPath, loginChildren, progressMonitors } = options;
  ctx.tools.register({
    name: CHANNEL_TOOL_NAME,
    description: "仅供本机普通 Harness 会话使用。检测当前设备并搭建、启停、诊断微信或钉钉通道，也可通过已连接的微信机器人向指定联系人主动发送消息。外部 IM 通道会话无权调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["status", "setup_wechat", "confirm_wechat_ready", "stop_wechat", "send_wechat_message", "configure_dingtalk_robot", "begin_dingtalk_person_login", "remove_channel"],
          description: "要执行的通道管理动作。",
        },
        channelId: { type: "string", description: "停止、重新接入或删除指定通道时使用。" },
        name: { type: "string", description: "微信机器人或钉钉机器人的显示名称。" },
        target: { type: "string", description: "主动发送的目标，可填写联系人/群聊备注、昵称、微信号或内部 ID。" },
        text: { type: "string", description: "要主动发送的微信消息正文。" },
        appKey: { type: "string", description: "钉钉机器人 Client ID/AppKey。" },
        appSecret: { type: "string", description: "钉钉机器人 Client Secret/AppSecret；不会写入工具输出。" },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          ok: { type: "boolean" },
          message: { type: "string" },
          details: { type: "string" },
        },
        required: ["action", "ok", "message", "details"],
      },
      render: (_args, value) => [{ type: "text", text: value.message + (value.details ? "\n" + value.details : "") }],
    },
    async execute(args, exec) {
      assertLocalHarnessSession(exec, mapFile);
      const action = String(args.action || "");
      if (action === "status") {
        const [channels, wechat] = await Promise.all([
          managementRequest(baseUrl, token, "/api/channels"),
          managementRequest(baseUrl, token, "/api/wechat/status"),
        ]);
        return { action, ok: true, message: "已检查本机通道环境。", details: JSON.stringify({ channels: channels.channels || [], wechat }, null, 2) };
      }
      if (action === "setup_wechat") {
        const value = await managementRequest(baseUrl, token, "/api/wechat/setup", { method: "POST", body: { channelId: String(args.channelId || ""), name: String(args.name || "") } });
        const bot = value?.bots?.[0]; if (bot?.channelId) startWechatProgressMonitor(exec, baseUrl, token, bot.channelId, progressMonitors);
        return { action, ok: true, message: "Harness 已开始按步骤检查和构建独立微信机器人，不会接管现有微信；构建期间每 1 分钟报告一次。", details: JSON.stringify(value, null, 2) };
      }
      if (action === "stop_wechat") {
        const id = String(args.channelId || "").trim(); if (!id) throw new Error("stop_wechat 需要 channelId");
        const value = await managementRequest(baseUrl, token, "/api/wechat/stop", { method: "POST", body: { channelId: id } });
        const monitor = progressMonitors.get(id); if (monitor) clearInterval(monitor); progressMonitors.delete(id);
        return { action, ok: true, message: "Harness 已停止该机器人桥接，未关闭任何微信进程。", details: JSON.stringify(value, null, 2) };
      }
      if (action === "confirm_wechat_ready") {
        const id = String(args.channelId || "").trim(); if (!id) throw new Error("confirm_wechat_ready 需要 channelId");
        const value = await managementRequest(baseUrl, token, `/api/wechat/status?channelId=${encodeURIComponent(id)}`);
        const bot = value?.bots?.[0];
        if (!bot || bot.phase !== "connected" || !bot.loggedIn || !bot.serviceRunning || !bot.sendReady) {
          throw new Error("微信机器人尚未通过最终健康检查，持续任务不能完成");
        }
        const monitor = progressMonitors.get(id); if (monitor) clearInterval(monitor); progressMonitors.delete(id);
        return { action, ok: true, message: `微信机器人 ${bot.name || id} 已通过最终健康检查，持续接入任务完成。`, details: JSON.stringify(bot, null, 2) };
      }
      if (action === "send_wechat_message") {
        const target = String(args.target || "").trim(), text = String(args.text || "").trim();
        if (!target || !text) throw new Error("send_wechat_message 需要 target 和 text");
        const value = await managementRequest(baseUrl, token, "/api/wechat/send", {
          method: "POST",
          body: { channelId: String(args.channelId || ""), target, text },
          attempts: 1,
        });
        const delivery = value?.delivery || {};
        const confirmed = delivery.status === "sent";
        return {
          action,
          ok: true,
          message: confirmed
            ? `微信消息已确认发给 ${value?.target?.name || target}。`
            : `微信消息已进入 ${value?.target?.name || target} 的发送队列。`,
          details: JSON.stringify({ channelId: value?.channelId, target: value?.target, delivery }, null, 2),
        };
      }
      if (action === "configure_dingtalk_robot") {
        const appKey = String(args.appKey || "").trim(), appSecret = String(args.appSecret || "").trim(), displayName = String(args.name || "").trim();
        if (!appKey || !appSecret || !displayName) throw new Error("配置钉钉机器人需要 name、appKey 和 appSecret");
        await validateDingtalkCredentials(appKey, appSecret);
        const safe = appKey.replace(/[^A-Za-z0-9_-]/g, "").slice(-12) || Date.now().toString(36);
        const id = "dingtalk-bot-" + safe;
        await managementRequest(baseUrl, token, "/api/channels", { method: "POST", body: {
          id, platform: "dingtalk", name: `钉钉-${displayName}-机器人`, mode: "stream", appKey, appSecret, enabled: true,
        } });
        return { action, ok: true, message: "钉钉机器人通道已配置并交由 Harness 托管。", details: JSON.stringify({ id, name: `钉钉-${displayName}-机器人` }, null, 2) };
      }
      if (action === "begin_dingtalk_person_login") {
        const instructions = await startDingtalkPersonLogin(authPath, token, loginChildren);
        return { action, ok: true, message: "钉钉真人通道扫码流程已启动；登录完成后会自动注册通道。", details: instructions };
      }
      if (action === "remove_channel") {
        const id = String(args.channelId || "").trim();
        if (!id) throw new Error("remove_channel 需要 channelId");
        await managementRequest(baseUrl, token, "/api/channels/" + encodeURIComponent(id), { method: "DELETE" });
        return { action, ok: true, message: `通道 ${id} 已由 Harness 删除。`, details: "" };
      }
      throw new Error("unsupported channel management action: " + action);
    },
    presentCall: (args) => ({ card: "generic", title: args.action === "status" ? "检查通道状态" : "由 Harness 管理通道", kind: "other" }),
  });
}

export const configSchema = {
  type: "object",
  properties: {
    bridgePath: { type: "string" },
    channelsFile: { type: "string" },
    statusFile: { type: "string" },
    managementPort: { type: "number" },
    wechatPython: { type: "string" },
    wechatConfig: { type: "string" },
    wechatExecutable: { type: "string" },
    mapFile: { type: "string" },
  },
  additionalProperties: false,
};

export function apply(ctx, config = {}) {
  const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const BRIDGE = config.bridgePath || path.join(PKG, "server.mjs");
  const AUTH = path.join(PKG, "auth.mjs");
  const MAP_FILE = config.mapFile || path.join(homedir(), ".dsh-im-bridge-map.json");
  const MANAGEMENT_PORT = Number(config.managementPort ?? 5175);
  const MANAGEMENT_TOKEN = randomBytes(32).toString("hex");
  const loginChildren = new Set();
  const progressMonitors = new Map();
  let child = null;
  let stopping = false;
  let restarts = 0;

  const env = {
    ...process.env,
    DSH_CHANNELS_FILE: config.channelsFile || path.join(homedir(), ".dsh-im-channels.json"),
    DSH_STATUS_FILE: config.statusFile || path.join(homedir(), ".dsh-im-channels-status.json"),
    DSH_BRIDGE_PORT: String(config.managementPort ?? 5175),
    DSH_CHANNEL_MANAGEMENT_TOKEN: MANAGEMENT_TOKEN,
    ...(config.wechatPython ? { DSH_WECHAT_PYTHON: config.wechatPython } : {}),
    ...(config.wechatConfig ? { DSH_WECHAT_CONFIG: config.wechatConfig } : {}),
    ...(config.wechatExecutable ? { DSH_WECHAT_EXECUTABLE: config.wechatExecutable } : {}),
  };

  registerChannelManagerTool(ctx, {
    baseUrl: `http://127.0.0.1:${MANAGEMENT_PORT}`,
    token: MANAGEMENT_TOKEN,
    mapFile: MAP_FILE,
    authPath: AUTH,
    loginChildren,
    progressMonitors,
  });

  const start = () => {
    if (stopping) return;
    if (!fs.existsSync(BRIDGE)) { ctx.logger?.error?.("[dsh-channel-im] bridge 缺失: " + BRIDGE); return; }
    child = spawn(process.execPath, [BRIDGE], { env, stdio: "inherit" });
    ctx.logger?.info?.("[dsh-channel-im] bridge 启动 pid=" + (child.pid ?? ""));
    child.on("exit", (code) => {
      child = null;
      if (stopping) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(restarts++, 5));
      ctx.logger?.warn?.("[dsh-channel-im] bridge 退出 code=" + code + "，" + delay + "ms 后重启");
      setTimeout(start, delay);
    });
  };

  start();
  const stop = () => {
    stopping = true;
    try { child?.kill("SIGTERM"); } catch {}
    for (const login of loginChildren) try { login.kill("SIGTERM"); } catch {}
    loginChildren.clear();
    for (const timer of progressMonitors.values()) clearInterval(timer);
    progressMonitors.clear();
  };
  ctx.on("dispose", stop);
  return stop;
}

export const name = "dsh-channel-im";
export const inject = ["tools"];
