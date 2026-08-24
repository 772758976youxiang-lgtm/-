import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply, readSelfProfile } from "../lib/self-profile.js";

test("channel self-profile tool writes only its preset profile and refreshes persona", async () => {
  const preset = path.join(os.homedir(), ".dsh", ".agent-presets", "channel-test-" + process.pid);
  const profilePath = path.join(preset, "self-profile.md");
  const authorizationPath = path.join(preset, "self-profile-permissions.json");
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
    fs.mkdirSync(preset, { recursive: true });
    fs.writeFileSync(authorizationPath, JSON.stringify({
      authorizedContactId: "wxid_owner",
      authorizedSessionIds: ["session-owner"],
    }));
    apply(ctx, { channelId: "test", profilePath, authorizationPath, maxChars: 2000 });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "channel_self_profile_update");
    assert.match(sections[0].text(), /尚未形成长期设定/);

    const result = await tools[0].execute({
      worthWriting: true,
      summary: "负责产品协作，表达简洁。",
      optimizedProfile: "### 身份与职责\n- 群聊里的产品助手\n\n### 表达方式\n- 简洁",
    }, { agent: { session: { header: { id: "session-owner" } } } });
    assert.equal(result.updated, true);
    assert.equal(changes, 1);
    assert.match(readSelfProfile(profilePath), /## 摘要\n负责产品协作，表达简洁。/);
    assert.match(readSelfProfile(profilePath), /## 完整设定[\s\S]*群聊里的产品助手/);
    assert.match(sections[0].text(), /群聊里的产品助手/);
    await assert.rejects(() => tools[0].execute({ worthWriting: true, summary: "x", optimizedProfile: "x" }, {}), /owning robot agent/);
    await assert.rejects(
      () => tools[0].execute({ worthWriting: true, summary: "x", optimizedProfile: "x" }, { agent: { id: "session-other" } }),
      /not authorized/,
    );
    const skipped = await tools[0].execute({ worthWriting: false }, { agent: { id: "session-owner" } });
    assert.equal(skipped.updated, false);
    assert.equal(skipped.reason, "not-worth-writing");
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
