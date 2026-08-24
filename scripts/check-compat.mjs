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
assert.match(pkg.scripts?.prepack ?? "", /clean-python-cache\.mjs/);
assert.match(pkg.scripts?.["test:wechat"] ?? "", /run-python-tests\.mjs/);
assert.match(pkg.scripts?.["verify:install"] ?? "", /verify-overrides\.mjs/);

const bundle = read("bundle/dsh-channel-im.cordis.yml");
assert.match(bundle, /^- insert:\s*$/m);
assert.match(bundle, /id: channel-im-bridge/);
assert.equal((bundle.match(/@deepseek-ai\/dsh-channel-im/g) ?? []).length, 1);

const serverPlugin = await import(pathToFileURL(path.join(root, "lib/index.js")));
assert.equal(typeof serverPlugin.apply, "function");
assert.equal(serverPlugin.name, "dsh-channel-im");
assert.equal(serverPlugin.configSchema.properties.wechatPython.type, "string");
assert.equal(serverPlugin.configSchema.properties.wechatConfig.type, "string");
assert.equal(serverPlugin.configSchema.properties.wechatExecutable.type, "string");

const client = read("lib/client.js");
assert.match(client, /exports\.inject\s*=\s*\["slots"\]/);
assert.match(client, /name:\s*"settings\.section"/);
assert.match(client, /c\.mode === "wechat_pc"/);
assert.match(client, /role:\s*"switch"/);
assert.match(client, /"aria-checked"/);
assert.match(client, /api\/wechat\/toggle/);

const server = read("server.mjs");
assert.match(server, /ensureConfigFile\(\)/);
assert.match(server, /httpServer\.listen\(BRIDGE_PORT,\s*"127\.0\.0\.1"/);
assert.match(server, /startWechatChannel/);
assert.match(server, /"wechat_pc"/);
assert.match(server, /launchWeChatLoginWindow/);
assert.match(server, /reconcileWechatChannel/);
assert.match(server, /startWechatSupervisor/);
assert.match(server, /ensureWechatPythonDependencies/);
assert.doesNotMatch(server, /taskkill\.exe/);
assert.match(server, /path === "\/api\/wechat\/status"/);
assert.match(server, /path === "\/api\/wechat\/toggle"/);
assert.doesNotMatch(server, /\{\s*\.\.\.c,\s*status:/);

const installer = read("scripts/install-assets.mjs");
assert.match(installer, /discoverPackageDirs/);
assert.match(installer, /copyDirectoryWithBackup/);
assert.match(installer, /installRuntimeLaunchers/);
assert.doesNotMatch(installer, /fs\.isDirectorySync/);

const auth = read("auth.mjs");
assert.match(auth, /dws\.exe/);
assert.match(read("skills/im-channel-setup.md"), /package-root\.txt/);

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
const conversationClient = read("overrides/dsh-client-ui-conversation/lib/client.js");
assert.match(conversationClient, /"context\.balance": "账户余额"/);
assert.match(conversationClient, /"stats\.peak": "峰"/);
assert.match(conversationClient, /t\("stats\.burningTokens"\)/);
assert.doesNotMatch(conversationClient, /你的 Harness 正在疯狂燃烧token/);

const dictionaryKeys = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing dictionary marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing dictionary marker: ${endMarker}`);
  return [...source.slice(start, end).matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]).sort();
};
const zhKeys = dictionaryKeys(conversationClient, "const zh = {", "/** English dictionary");
const enKeys = dictionaryKeys(conversationClient, "const en = {", "//#endregion");
assert.deepEqual(enKeys, zhKeys, "English and Chinese locale dictionaries must have identical keys");

const localeTypes = read("overrides/dsh-client-ui-conversation/lib/types/client/locales.d.ts");
const declarationKeys = (source, startMarker, endMarker = undefined) => {
  const start = source.indexOf(startMarker);
  const end = endMarker === undefined ? source.length : source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing declaration marker: ${startMarker}`);
  if (endMarker !== undefined) assert.notEqual(end, -1, `missing declaration marker: ${endMarker}`);
  return [...source.slice(start, end).matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]).sort();
};
const zhTypeKeys = declarationKeys(localeTypes, "export declare const zh:", "/** The conversation namespace");
const enTypeKeys = declarationKeys(localeTypes, "export declare const en:");
assert.deepEqual(zhTypeKeys, zhKeys, "Chinese locale declaration must match the runtime dictionary");
assert.deepEqual(enTypeKeys, enKeys, "English locale declaration must match the runtime dictionary");
assert.match(read("overrides/dsh-host-apiproxy/lib/index.js"), /"host\.balance"/);
for (const removed of [
  "client/connection.compiled.js",
  "client/open-external.compiled.js",
  "client/open-external.js",
  "client/patch-conversation.mjs",
  "client/patch-settings.mjs"
]) assert.equal(fs.existsSync(path.join(root, removed)), false);

console.log("dsh-channel-im compatibility checks passed");
