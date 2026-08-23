/**
 * @deepseek-ai/dsh-channel-im · DSH Bundle 插件入口（桥接服务行）
 *
 * cordis 插件：挂载时托管桥接子进程（本包 server.mjs），dispose→停止；
 * 崩溃自动重启（指数退避，上限30s）；读取 ~/.dsh-im-channels.json，管理API 5175。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

export const configSchema = {
  type: "object",
  properties: {
    bridgePath: { type: "string" },
    channelsFile: { type: "string" },
    statusFile: { type: "string" },
    managementPort: { type: "number" },
  },
  additionalProperties: false,
};

export function apply(ctx, config = {}) {
  const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const BRIDGE = config.bridgePath || path.join(PKG, "server.mjs");
  let child = null;
  let stopping = false;
  let restarts = 0;

  const env = {
    ...process.env,
    DSH_CHANNELS_FILE: config.channelsFile || path.join(homedir(), ".dsh-im-channels.json"),
    DSH_STATUS_FILE: config.statusFile || path.join(homedir(), ".dsh-im-channels-status.json"),
    DSH_BRIDGE_PORT: String(config.managementPort ?? 5175),
  };

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
  ctx.on("dispose", () => { stopping = true; try { child?.kill("SIGTERM"); } catch {} });
  return () => { stopping = true; try { child?.kill("SIGTERM"); } catch {} };
}

export const name = "dsh-channel-im";
export default apply;
