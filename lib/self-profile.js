import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TOOL_NAME = "channel_self_profile_update";
const PROFILE_FILE = "self-profile.md";
const AUTHORIZATION_FILE = "self-profile-permissions.json";
const PRESET_ROOT = path.resolve(homedir(), ".dsh", ".agent-presets");

function resolveProfilePath(value) {
  const resolved = path.resolve(String(value || ""));
  const relative = path.relative(PRESET_ROOT, resolved);
  if (!value || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(resolved) !== PROFILE_FILE) {
    throw new Error("self profile path must be a self-profile.md file inside ~/.dsh/.agent-presets");
  }
  return resolved;
}

function resolveAuthorizationPath(value, profilePath) {
  const resolved = path.resolve(String(value || ""));
  const relative = path.relative(PRESET_ROOT, resolved);
  if (!value || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(resolved) !== AUTHORIZATION_FILE
      || path.dirname(resolved) !== path.dirname(profilePath)) {
    throw new Error("self profile authorization path must be beside self-profile.md inside ~/.dsh/.agent-presets");
  }
  return resolved;
}

export function readSelfProfilePermissions(authorizationPath) {
  try {
    const value = JSON.parse(fs.readFileSync(authorizationPath, "utf8"));
    return {
      authorizedContactId: String(value?.authorizedContactId || ""),
      authorizedSessionIds: Array.isArray(value?.authorizedSessionIds)
        ? value.authorizedSessionIds.map((item) => String(item)).filter(Boolean)
        : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { authorizedContactId: "", authorizedSessionIds: [] };
    }
    throw error;
  }
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
    "你拥有一份仅属于当前通道的长期设定。它可以记录会稳定影响未来交互的重要内容，包括你的身份与表达方式、规则与边界、长期目标、持续关系、稳定偏好、反复使用的工作方式、已确认的重要事实和长期承诺。不得写入凭据、密钥、逐字聊天记录、一次性请求、短期状态、未经确认的推测或无关细节。",
    "只有后台指定的唯一授权联系人的私聊会话可以更新这份设定；工具会用真实 Harness 会话 ID 再次校验权限。其他联系人、群聊和普通 Harness 会话一律不得写入。",
    `每轮先完成面向用户的回复，再判断本轮是否出现了明确、可靠、可复用且值得长期保留的新信息。没有价值时不要调用 ${TOOL_NAME}。有价值时：先为优化后的全部设定生成一段高密度摘要；再把新旧内容整体合并，去重、消除冲突、删除过时内容、统一措辞和章节结构；最后调用工具并传入 worthWriting=true、summary 和完整 optimizedProfile。不要只追加本轮内容。不要向用户展示工具名、文件路径、权限数据或内部更新过程。`,
    "【当前长期设定】",
    profile || "（空白，尚未形成长期设定）",
  ].join("\n\n");
}

function formatOptimizedProfile(summary, profile) {
  const normalizedSummary = String(summary ?? "").replace(/\r\n?/g, "\n").trim();
  const normalizedProfile = String(profile ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalizedSummary) throw new Error("a non-empty summary is required when worthWriting is true");
  if (!normalizedProfile) throw new Error("a non-empty optimizedProfile is required when worthWriting is true");
  return `# 通道长期设定\n\n## 摘要\n${normalizedSummary}\n\n## 完整设定\n${normalizedProfile}`;
}

export const name = "channel-self-profile";
export const inject = ["systemPrompt", "tools"];

export function apply(ctx, config = {}) {
  const profilePath = resolveProfilePath(config.profilePath);
  const authorizationPath = resolveAuthorizationPath(config.authorizationPath, profilePath);
  const channelId = String(config.channelId || "channel");
  const maxChars = Math.max(1000, Math.min(Number(config.maxChars) || 12000, 50000));
  const resolvedConfig = { ...config, profilePath, authorizationPath };

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
    description: "仅供后台授权联系人所在的私聊会话使用。先判断本轮是否有可靠、可复用、值得长期保留的信息；有价值时写入整体摘要，并用合并、去重、纠错、移除过时内容后的完整长期设定覆盖旧版本。无价值时不要调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        worthWriting: {
          type: "boolean",
          description: "本轮是否确实产生了明确、可靠、可复用且值得长期保留的新内容。",
        },
        summary: {
          type: "string",
          description: "优化后全部长期设定的高密度摘要；worthWriting=true 时必填。",
        },
        optimizedProfile: {
          type: "string",
          description: "把本轮新内容与现有设定整体合并、去重、纠错、删除过时内容并统一结构后的完整设定；不是增量片段。worthWriting=true 时必填。",
        },
      },
      required: ["worthWriting"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          channelId: { type: "string" },
          characters: { type: "integer" },
          summaryCharacters: { type: "integer" },
          updated: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["channelId", "characters", "summaryCharacters", "updated", "reason"],
      },
      render: (_args, value) => [{
        type: "text",
        text: value.updated
          ? `当前通道的长期设定已整体优化（${value.characters} 字符）。`
          : value.reason === "not-worth-writing" ? "本轮没有值得长期写入的内容。" : "当前通道的长期设定没有变化。",
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error(TOOL_NAME + " requires an owning robot agent session");
      const sessionId = String(exec.agent?.session?.header?.id || exec.agent?.id || "");
      const permissions = readSelfProfilePermissions(authorizationPath);
      if (!permissions.authorizedContactId || !sessionId || !permissions.authorizedSessionIds.includes(sessionId)) {
        throw new Error("current conversation is not authorized to update the channel profile");
      }
      const before = readSelfProfile(profilePath);
      if (args.worthWriting !== true) {
        return { channelId, characters: before.length, summaryCharacters: 0, updated: false, reason: "not-worth-writing" };
      }
      const summary = String(args.summary ?? "").replace(/\r\n?/g, "\n").trim();
      const optimized = formatOptimizedProfile(summary, args.optimizedProfile);
      const after = writeSelfProfile(profilePath, optimized, maxChars);
      if (after !== before) {
        try { ctx.emit("system-prompt/change"); } catch {}
      }
      return { channelId, characters: after.length, summaryCharacters: summary.length,
        updated: after !== before, reason: after !== before ? "optimized" : "unchanged" };
    },
    presentCall: () => ({
      card: "generic",
      title: "优化机器人长期设定",
      kind: "other",
    }),
  });
}
