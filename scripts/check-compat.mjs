import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const pkg = JSON.parse(read("package.json"));

assert.equal(pkg.dsh?.bundle?.patch, "bundle/dsh-channel-im.cordis.yml");
assert.equal(pkg.exports?.["./package.json"], "./package.json");
assert.equal(pkg.packageManager, "pnpm@11.19.0");
assert.equal(pkg.dependencies?.["dingtalk-stream-sdk-nodejs"], "2.0.4");
assert.equal(pkg.peerDependenciesMeta?.["@deepseek-ai/cordis"]?.optional, true);
assert.match(pkg.scripts?.prepack ?? "", /npm test/);
assert.match(pkg.scripts?.["verify:install"] ?? "", /verify-overrides\.mjs/);

const bundle = read("bundle/dsh-channel-im.cordis.yml");
assert.match(bundle, /^- insert:\s*$/m);
assert.match(bundle, /id: channel-im-bridge/);
assert.equal((bundle.match(/@deepseek-ai\/dsh-channel-im/g) ?? []).length, 1);

const serverPlugin = await import(pathToFileURL(path.join(root, "lib/index.js")));
assert.equal(typeof serverPlugin.apply, "function");
assert.equal(serverPlugin.name, "dsh-channel-im");

const client = read("lib/client.js");
assert.match(client, /exports\.inject\s*=\s*\["slots"\]/);
assert.match(client, /name:\s*"settings\.section"/);

const server = read("server.mjs");
assert.match(server, /ensureConfigFile\(\)/);
assert.match(server, /httpServer\.listen\(BRIDGE_PORT,\s*"127\.0\.0\.1"/);
assert.doesNotMatch(server, /\{\s*\.\.\.c,\s*status:/);

const installer = read("scripts/install-assets.mjs");
assert.match(installer, /discoverPackageDirs/);
assert.match(installer, /copyDirectoryWithBackup/);
assert.doesNotMatch(installer, /fs\.isDirectorySync/);

for (const packageName of [
  "dsh-api-remotes",
  "dsh-client-connection",
  "dsh-client-runtime",
  "dsh-client-ui-conversation",
  "dsh-host-apiproxy",
  "dsh-llm-deepseek",
  "dsh-token-meter"
]) {
  assert.equal(fs.statSync(path.join(root, "overrides", packageName, "lib")).isDirectory(), true);
}
assert.match(read("overrides/dsh-client-ui-conversation/lib/client.js"), /"context\.balance": "账户余额"/);
assert.match(read("overrides/dsh-client-ui-conversation/lib/client.js"), /"stats\.peak": "峰"/);
assert.match(read("overrides/dsh-host-apiproxy/lib/index.js"), /"host\.balance"/);
for (const removed of [
  "client/connection.compiled.js",
  "client/open-external.compiled.js",
  "client/open-external.js",
  "client/patch-conversation.mjs",
  "client/patch-settings.mjs"
]) assert.equal(fs.existsSync(path.join(root, removed)), false);

console.log("dsh-channel-im compatibility checks passed");
