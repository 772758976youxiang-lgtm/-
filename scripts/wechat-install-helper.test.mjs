import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = ["wechat-elevate.ps1", "wechat-install-helper.ps1"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("PowerShell installation helpers parse without running", async () => {
  for (const name of scripts) {
    const file = path.join(root, "scripts", name);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[void][scriptblock]::Create([IO.File]::ReadAllText('${file.replaceAll("'", "''")}'))`], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test("elevated helper is scoped to Weixin 4.x and verifies the pinned artifact", async () => {
  const source = await fs.readFile(path.join(root, "scripts", "wechat-install-helper.ps1"), "utf8");
  assert.match(source, /Get-FileHash[\s\S]*SHA256/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /Weixin\.exe/);
  assert.match(source, /WeixinUpdate\.exe/);
  assert.match(source, /4\.1\.10\.27/);
  assert.match(source, /New-NetFirewallRule/);
  assert.doesNotMatch(source, /taskkill[\s\S]*WeChat\.exe/i);
  assert.match(source, /Test-ExcludedProductPath/);
  assert.match(source, /Test-ReparseInPath \$root/);
  assert.match(source, /wxwork/i);
  assert.match(source, /wecom/i);
  assert.match(source, /wechat/i);
  assert.match(source, /safeUpdaterPaths/);
});

test("plugin contains no embedded installer executable", async () => {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else assert.notEqual(path.extname(entry.name).toLowerCase(), ".exe", file);
    }
  }
});
