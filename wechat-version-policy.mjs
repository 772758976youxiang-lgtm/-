import crypto from "node:crypto";
import path from "node:path";

export const TARGET_WECHAT = Object.freeze({
  version: "4.1.10.27",
  url: "https://github.com/SiverKing/wechat4.0-windows-versions/releases/download/v4.1.10.27/weixin_4.1.10.27.exe",
  size: 239441904,
  sha256: "54203fc2b41983fa106b0af0d67f86befc56ccd3dc1005d4bab6de8ea36b4f74",
  signerOrganization: "Tencent Technology (Shenzhen) Company Limited",
});

export class WechatControlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WechatControlError";
    this.code = code;
    this.details = details;
  }
}

export const isTargetWechatVersion = (version) => version === TARGET_WECHAT.version;

export function normalizeWechatSnapshot(value = {}) {
  return Object.freeze({
    executable: value.executable ? path.win32.normalize(String(value.executable)).toLowerCase() : "",
    version: String(value.version || ""),
  });
}

export function createConfirmationStore({
  now = Date.now,
  randomToken = () => crypto.randomBytes(32).toString("base64url"),
  ttlMs = 5 * 60 * 1000,
  maxPendingTokens = 256,
} = {}) {
  if (!Number.isInteger(maxPendingTokens) || maxPendingTokens < 1) {
    throw new RangeError("maxPendingTokens must be a positive integer");
  }
  const tokens = new Map();
  const sweepExpired = (currentTime) => {
    for (const [token, record] of tokens) {
      if (record.expiresAt <= currentTime) tokens.delete(token);
    }
  };
  return {
    issue(snapshot) {
      const currentTime = now();
      sweepExpired(currentTime);
      while (tokens.size >= maxPendingTokens) {
        tokens.delete(tokens.keys().next().value);
      }
      const token = randomToken();
      tokens.set(token, { snapshot: normalizeWechatSnapshot(snapshot), expiresAt: currentTime + ttlMs });
      return token;
    },
    consume(token, currentSnapshot) {
      const currentTime = now();
      const record = tokens.get(token);
      tokens.delete(token);
      sweepExpired(currentTime);
      if (!record) throw new WechatControlError("CONFIRMATION_INVALID", "安装确认已失效，请重新检查微信版本");
      if (currentTime >= record.expiresAt) {
        throw new WechatControlError("CONFIRMATION_EXPIRED", "安装确认已过期，请重新确认");
      }
      const current = normalizeWechatSnapshot(currentSnapshot);
      if (JSON.stringify(current) !== JSON.stringify(record.snapshot)) {
        throw new WechatControlError("CONFIRMATION_STATE_CHANGED", "微信安装状态已变化，请重新确认");
      }
      return record.snapshot;
    },
  };
}
