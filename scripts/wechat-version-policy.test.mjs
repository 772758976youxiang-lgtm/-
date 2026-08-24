import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGET_WECHAT,
  createConfirmationStore,
  isTargetWechatVersion,
  normalizeWechatSnapshot,
} from "../wechat-version-policy.mjs";

test("accepts only the exact four-part target version", () => {
  assert.equal(isTargetWechatVersion("4.1.10.27"), true);
  for (const value of ["4.1.10.0", "4.1.10.270", "4.1.12.26", "3.9.12.55", "", null]) {
    assert.equal(isTargetWechatVersion(value), false, String(value));
  }
  assert.equal(TARGET_WECHAT.sha256.length, 64);
});

test("confirmation tokens are one-use, expire, and bind to the observed snapshot", () => {
  let at = 1000;
  let sequence = 0;
  const store = createConfirmationStore({ now: () => at, randomToken: () => `token-${++sequence}`, ttlMs: 5000 });
  const snapshot = normalizeWechatSnapshot({ executable: "D:\\Apps\\Weixin\\Weixin.exe", version: "4.1.12.26" });
  const token = store.issue(snapshot);
  assert.deepEqual(store.consume(token, snapshot), snapshot);
  assert.throws(() => store.consume(token, snapshot), { code: "CONFIRMATION_INVALID" });

  const expired = store.issue(snapshot);
  at += 5001;
  assert.throws(() => store.consume(expired, snapshot), { code: "CONFIRMATION_EXPIRED" });

  const changed = store.issue(snapshot);
  assert.throws(
    () => store.consume(changed, normalizeWechatSnapshot({ executable: snapshot.executable, version: "4.1.10.31" })),
    { code: "CONFIRMATION_STATE_CHANGED" },
  );
});
