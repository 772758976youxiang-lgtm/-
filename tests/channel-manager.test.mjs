import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";

function fixture(mapFile) {
  let tool;
  const ctx = {
    tools: { register(value) { tool = value; } },
    logger: { error() {}, info() {}, warn() {} },
    on() {},
  };
  const dispose = apply(ctx, { bridgePath: path.join(path.dirname(mapFile), "missing-server.mjs"), mapFile, managementPort: 59999 });
  return { tool, dispose };
}

test("normal Harness sessions can call the authenticated channel manager", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-channel-manager-"));
  const mapFile = path.join(temporary, "map.json");
  fs.writeFileSync(mapFile, "{}", "utf8");
  const { tool, dispose } = fixture(mapFile);
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const body = String(url).endsWith("/api/channels")
      ? { ok: true, channels: [] }
      : { ok: true, configured: false, enabled: false, phase: "disabled" };
    return { ok: true, status: 200, async json() { return body; } };
  };
  try {
    assert.equal(tool.name, "im_channel_manage");
    const value = await tool.execute({ action: "status" }, { agent: { session: { header: { id: "local-session" } } } });
    assert.equal(value.ok, true);
    assert.equal(requests.length, 2);
    for (const request of requests) assert.match(request.options.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
  } finally {
    globalThis.fetch = previousFetch;
    dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("external IM sessions cannot call channel lifecycle tools", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-channel-manager-"));
  const mapFile = path.join(temporary, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify({ contact: { sid: "external-session" } }), "utf8");
  const { tool, dispose } = fixture(mapFile);
  try {
    await assert.rejects(
      tool.execute({ action: "setup_wechat" }, { agent: { session: { header: { id: "external-session" } } } }),
      /external channel sessions cannot manage/,
    );
  } finally {
    dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
