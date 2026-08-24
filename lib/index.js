/**
 * @deepseek-ai/dsh-channel-im · DSH Bundle 插件入口（桥接服务行）
 *
 * cordis 插件：挂载时托管桥接子进程（本包 server.mjs），dispose→停止；
 * 崩溃自动重启（指数退避，上限30s）；读取 ~/.dsh-im-channels.json，管理API 5175。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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

async function managementRequest(baseUrl, token, apiPath, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
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
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
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
  const { baseUrl, token, mapFile, authPath, loginChildren } = options;
  ctx.tools.register({
    name: CHANNEL_TOOL_NAME,
    description: "仅供本机普通 Harness 会话使用。检测当前设备并搭建、启停、诊断微信或钉钉通道；自动生成本机配置、补齐依赖并验证状态。外部 IM 通道会话无权调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["status", "setup_wechat", "stop_wechat", "configure_dingtalk_robot", "begin_dingtalk_person_login", "remove_channel"],
          description: "要执行的通道管理动作。",
        },
        channelId: { type: "string", description: "删除通道时必填。" },
        name: { type: "string", description: "配置钉钉机器人时的显示名称。" },
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
      if (action === "setup_wechat" || action === "stop_wechat") {
        const enabled = action === "setup_wechat";
        const value = await managementRequest(baseUrl, token, "/api/wechat/toggle", { method: "POST", body: { enabled } });
        return { action, ok: true, message: enabled ? "Harness 已按当前设备配置并启动微信通道。" : "Harness 已停止微信通道。", details: JSON.stringify(value, null, 2) };
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
  };
  ctx.on("dispose", stop);
  return stop;
}

export const name = "dsh-channel-im";
export const inject = ["tools"];
