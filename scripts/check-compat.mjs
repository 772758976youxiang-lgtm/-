import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const pkg = JSON.parse(read("package.json"));

assert.equal(pkg.dsh?.bundle?.patch, "bundle/dsh-channel-im.cordis.yml");
assert.equal(pkg.exports?.["./package.json"], "./package.json");

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

console.log("dsh-channel-im compatibility checks passed");
