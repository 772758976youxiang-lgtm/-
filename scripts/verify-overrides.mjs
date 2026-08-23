import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPackageDirs, verifyDirectory } from "./install-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overrideRoot = path.join(root, "overrides");
let failures = 0;

for (const entry of fs.readdirSync(overrideRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = path.join(overrideRoot, entry.name, "lib");
  const targets = discoverPackageDirs(entry.name, { packageRoot: root });
  if (targets.length === 0) {
    console.error(`missing target: @deepseek-ai/${entry.name}`);
    failures += 1;
    continue;
  }
  for (const target of targets) {
    const mismatches = verifyDirectory(source, path.join(target, "lib"));
    if (mismatches.length > 0) {
      console.error(`mismatch: @deepseek-ai/${entry.name} (${mismatches.length} files)`);
      failures += 1;
    } else console.log(`verified: @deepseek-ai/${entry.name}`);
  }
}

if (failures > 0) process.exit(1);
console.log("all DSH overrides are installed and verified");
