import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_WECHAT,
  createConfirmationStore,
  isTargetWechatVersion,
  normalizeWechatSnapshot,
} from "../wechat-version-policy.mjs";

test("accepts only the exact four-part target version", () => {
  assert.deepEqual(TARGET_WECHAT, {
    version: "4.1.10.27",
    url: "https://github.com/SiverKing/wechat4.0-windows-versions/releases/download/v4.1.10.27/weixin_4.1.10.27.exe",
    size: 239441904,
    sha256: "54203fc2b41983fa106b0af0d67f86befc56ccd3dc1005d4bab6de8ea36b4f74",
    signerOrganization: "Tencent Technology (Shenzhen) Company Limited",
  });
  assert.equal(Object.isFrozen(TARGET_WECHAT), true);
  assert.equal(isTargetWechatVersion("4.1.10.27"), true);
  for (const value of ["4.1.10.0", "4.1.10.270", "4.1.12.26", "3.9.12.55", "", null]) {
    assert.equal(isTargetWechatVersion(value), false, String(value));
  }
});

test("normalizes Windows executable slashes and case", () => {
  const normalized = normalizeWechatSnapshot({
    executable: "D:/Apps/Weixin/WEIXIN.EXE",
    version: "4.1.10.27",
  });
  assert.deepEqual(normalized, {
    executable: "d:\\apps\\weixin\\weixin.exe",
    version: "4.1.10.27",
  });
  assert.deepEqual(
    normalizeWechatSnapshot({ executable: "d:\\APPS\\WEIXIN\\weixin.exe", version: "4.1.10.27" }),
    normalized,
  );
});

test("confirmation tokens are one-use after successful consumption", () => {
  let at = 1000;
  let sequence = 0;
  const store = createConfirmationStore({ now: () => at, randomToken: () => `token-${++sequence}`, ttlMs: 5000 });
  const snapshot = normalizeWechatSnapshot({ executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" });
  const token = store.issue(snapshot);
  assert.deepEqual(store.consume(token, snapshot), snapshot);
  assert.throws(() => store.consume(token, snapshot), { code: "CONFIRMATION_INVALID" });
});

test("confirmation tokens expire at the exact boundary and remain one-use", () => {
  let at = 1000;
  let sequence = 0;
  const store = createConfirmationStore({ now: () => at, randomToken: () => `token-${++sequence}`, ttlMs: 5000 });
  const snapshot = normalizeWechatSnapshot({ executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" });
  const expired = store.issue(snapshot);
  at += 5000;
  assert.throws(() => store.consume(expired, snapshot), { code: "CONFIRMATION_EXPIRED" });
  assert.throws(() => store.consume(expired, snapshot), { code: "CONFIRMATION_INVALID" });
});

test("confirmation tokens are one-use after a state mismatch", () => {
  let sequence = 0;
  const store = createConfirmationStore({ randomToken: () => `token-${++sequence}` });
  const snapshot = normalizeWechatSnapshot({ executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" });
  const changed = store.issue(snapshot);
  assert.throws(
    () => store.consume(changed, normalizeWechatSnapshot({ executable: snapshot.executable, version: "4.1.10.31" })),
    { code: "CONFIRMATION_STATE_CHANGED" },
  );
  assert.throws(() => store.consume(changed, snapshot), { code: "CONFIRMATION_INVALID" });
});

test("sweeps expired pending tokens during issue and consume", () => {
  let at = 1000;
  let sequence = 0;
  const store = createConfirmationStore({ now: () => at, randomToken: () => `token-${++sequence}`, ttlMs: 5000 });
  const snapshot = normalizeWechatSnapshot({ executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" });

  const sweptOnIssue = store.issue(snapshot);
  at += 5000;
  store.issue(snapshot);
  assert.throws(() => store.consume(sweptOnIssue, snapshot), { code: "CONFIRMATION_INVALID" });

  const sweptOnConsume = store.issue(snapshot);
  at += 1;
  const current = store.issue(snapshot);
  at += 4999;
  assert.deepEqual(store.consume(current, snapshot), snapshot);
  assert.throws(() => store.consume(sweptOnConsume, snapshot), { code: "CONFIRMATION_INVALID" });
});

test("evicts the oldest pending confirmation token at capacity", () => {
  let sequence = 0;
  const store = createConfirmationStore({ randomToken: () => `token-${++sequence}`, maxPendingTokens: 2 });
  const snapshot = normalizeWechatSnapshot({ executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" });
  const first = store.issue(snapshot);
  const second = store.issue(snapshot);
  const third = store.issue(snapshot);

  assert.throws(() => store.consume(first, snapshot), { code: "CONFIRMATION_INVALID" });
  assert.deepEqual(store.consume(second, snapshot), snapshot);
  assert.deepEqual(store.consume(third, snapshot), snapshot);
});
