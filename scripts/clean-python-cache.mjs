import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const relative of ["tests/__pycache__", "wechat_channel/__pycache__"]) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep) || path.basename(target) !== "__pycache__") {
    throw new Error("refusing to clean unexpected Python cache path: " + target);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

