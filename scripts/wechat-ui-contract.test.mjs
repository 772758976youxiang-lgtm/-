import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const files = ["client/connection-page.js", "lib/client.js"];

test("readable and shipped clients expose the same WeChat install confirmation flow", async () => {
  for (const file of files) {
    const source = await fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /WECHAT_VERSION_REQUIRED/);
    assert.match(source, /confirmationToken/);
    assert.match(source, /wechat\.versionPrompt/);
    assert.match(source, /wechat\.installTarget/);
    assert.match(source, /wechat\.cancelInstall/);
  }
  const shipped = await fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(shipped, /封禁风险/);
  assert.match(shipped, /account-ban risk/);
});

test("shipped client calls the runtime download endpoint and retains mismatch responses", async () => {
  const source = await fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /\/api\/wechat\/install/);
  assert.match(source, /r\.status === 409 && j\.code === "WECHAT_VERSION_REQUIRED"/);
  assert.doesNotMatch(source, /weixin_4\.1\.10\.27\.exe/);
});
