import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply, readSelfProfile } from "../lib/self-profile.js";

test("channel self-profile tool writes only its preset profile and refreshes persona", async () => {
  const preset = path.join(os.homedir(), ".dsh", ".agent-presets", "channel-test-" + process.pid);
  const profilePath = path.join(preset, "self-profile.md");
  const tools = [];
  const sections = [];
  let changes = 0;
  const ctx = {
    effect(factory) { return factory(); },
    emit(event) { if (event === "system-prompt/change") changes += 1; },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
  };
  try {
    apply(ctx, { channelId: "test", profilePath, maxChars: 2000 });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "channel_self_profile_update");
    assert.match(sections[0].text(), /尚未形成自我设定/);

    const result = await tools[0].execute({ profile: "- 身份：群聊里的产品助手\n- 风格：简洁" }, { agent: {} });
    assert.equal(result.updated, true);
    assert.equal(changes, 1);
    assert.equal(readSelfProfile(profilePath), "- 身份：群聊里的产品助手\n- 风格：简洁");
    assert.match(sections[0].text(), /群聊里的产品助手/);
    await assert.rejects(() => tools[0].execute({ profile: "x" }, {}), /owning robot agent/);
  } finally {
    fs.rmSync(preset, { recursive: true, force: true });
  }
});

test("channel self-profile rejects paths outside channel presets", () => {
  assert.throws(
    () => apply({ effect() {}, systemPrompt: {}, tools: {} }, { profilePath: path.join(os.tmpdir(), "self-profile.md") }),
    /inside ~\/\.dsh\/\.agent-presets/,
  );
});
