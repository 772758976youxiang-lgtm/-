import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TOOL_NAME = "channel_self_profile_update";
const PROFILE_FILE = "self-profile.md";
const PRESET_ROOT = path.resolve(homedir(), ".dsh", ".agent-presets");

function resolveProfilePath(value) {
  const resolved = path.resolve(String(value || ""));
  const relative = path.relative(PRESET_ROOT, resolved);
  if (!value || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(resolved) !== PROFILE_FILE) {
    throw new Error("self profile path must be a self-profile.md file inside ~/.dsh/.agent-presets");
  }
  return resolved;
}

export function readSelfProfile(profilePath) {
  try {
    return fs.readFileSync(resolveProfilePath(profilePath), "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function writeSelfProfile(profilePath, profile, maxChars = 12000) {
  const target = resolveProfilePath(profilePath);
  const normalized = String(profile ?? "").replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maxChars) {
    throw new Error(`self profile exceeds ${maxChars} characters`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(temporary, normalized ? normalized + "\n" : "", "utf8");
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return normalized;
}

function personaText(config) {
  const profile = readSelfProfile(config.profilePath);
  return [
    "你是一个通过即时通信通道与用户交流的机器人。",
    "你拥有一份仅属于当前通道的持久自我设定。它只能记录你自身稳定的身份、人设、表达风格、职责、能力边界和偏好；不得记录用户资料、聊天摘要、原话、临时任务、事件、联系人信息、凭据或任何形式的对话记忆。",
    `在完成面向用户的回复后、该轮结束前，如果本轮对话产生了值得长期保留的新自我设定，调用 ${TOOL_NAME}，传入合并整理后的完整设定以覆盖旧版本。没有稳定变化时不要调用。不要向用户展示工具名、文件路径或内部更新过程。`,
    "【当前自我设定】",
    profile || "（空白，尚未形成自我设定）",
  ].join("\n\n");
}

export const name = "channel-self-profile";
export const inject = ["systemPrompt", "tools"];

export function apply(ctx, config = {}) {
  const profilePath = resolveProfilePath(config.profilePath);
  const channelId = String(config.channelId || "channel");
  const maxChars = Math.max(1000, Math.min(Number(config.maxChars) || 12000, 50000));
  const resolvedConfig = { ...config, profilePath };

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: "deployment:persona",
      order: 0,
      text: () => personaText(resolvedConfig),
    }),
    "channel-self-profile.persona()",
  );

  ctx.tools.register({
    name: TOOL_NAME,
    description: "在本轮面向用户的回复完成后，更新当前通道机器人的完整持久自我设定。只保存机器人的身份、人设、表达风格、职责、能力边界和偏好；不得保存用户资料、聊天内容、事件、任务或记忆。传入完整设定会覆盖旧版本；没有稳定变化时不要调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: {
          type: "string",
          description: "合并整理后的完整自我设定。只写机器人自身的稳定设定；传空字符串可清空。",
        },
      },
      required: ["profile"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          channelId: { type: "string" },
          characters: { type: "integer" },
          updated: { type: "boolean" },
        },
        required: ["channelId", "characters", "updated"],
      },
      render: (_args, value) => [{
        type: "text",
        text: value.updated
          ? `当前通道的自我设定已更新（${value.characters} 字符）。`
          : "当前通道的自我设定没有变化。",
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error(TOOL_NAME + " requires an owning robot agent session");
      const before = readSelfProfile(profilePath);
      const after = writeSelfProfile(profilePath, args.profile, maxChars);
      if (after !== before) {
        try { ctx.emit("system-prompt/change"); } catch {}
      }
      return { channelId, characters: after.length, updated: after !== before };
    },
    presentCall: () => ({
      card: "generic",
      title: "更新机器人自我设定",
      kind: "other",
    }),
  });
}
