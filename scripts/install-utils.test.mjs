import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyDirectoryWithBackup, discoverPackageDirs, verifyDirectory } from "./install-utils.mjs";

const makePackage = (directory, name, version = "0.1.1-rc.2") => {
  fs.mkdirSync(path.join(directory, "lib"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, version }));
};

test("discovers pnpm v11 link-store packages and filters incompatible versions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-channel-im-locator-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, "pnpm", "store", "v11", "links", "@deepseek-ai", "dsh-host-apiproxy", "0.1.1-rc.2", "hash", "node_modules", "@deepseek-ai", "dsh-host-apiproxy");
  const stale = path.join(root, "pnpm", "store", "v11", "links", "@deepseek-ai", "dsh-host-apiproxy", "0.1.0", "hash", "node_modules", "@deepseek-ai", "dsh-host-apiproxy");
  makePackage(current, "dsh-host-apiproxy");
  makePackage(stale, "dsh-host-apiproxy", "0.1.0");
  const found = discoverPackageDirs("dsh-host-apiproxy", {
    packageRoot: root,
    home: root,
    env: { LOCALAPPDATA: root },
    spawn: () => ({ status: 1, stdout: "" }),
    scopeRoots: []
  });
  assert.deepEqual(found, [current]);
});

test("copies overrides, preserves the first original and verifies output", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-channel-im-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const backup = path.join(destination, ".dsh-channel-im-backup");
  fs.mkdirSync(path.join(source, "types"), { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(source, "index.js"), "new");
  fs.writeFileSync(path.join(source, "types", "index.d.ts"), "types");
  fs.writeFileSync(path.join(destination, "index.js"), "old");

  assert.equal(copyDirectoryWithBackup(source, destination, backup), 2);
  assert.equal(fs.readFileSync(path.join(backup, "index.js"), "utf8"), "old");
  assert.deepEqual(verifyDirectory(source, destination), []);

  fs.writeFileSync(path.join(source, "index.js"), "newer");
  copyDirectoryWithBackup(source, destination, backup);
  assert.equal(fs.readFileSync(path.join(backup, "index.js"), "utf8"), "old");
});
