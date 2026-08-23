import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SUPPORTED_DSH_VERSION = "0.1.1-rc.2";

const uniqueExistingDirectories = (values) => [...new Set(values.map((value) => path.resolve(value)))]
  .filter((value) => fs.existsSync(value) && fs.statSync(value).isDirectory());

const readPackage = (packageDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
};

const matchingPackage = (packageDir, packageName, version) => {
  const manifest = readPackage(packageDir);
  return manifest?.name === `@deepseek-ai/${packageName}` && (version === null || manifest.version === version);
};

export function discoverPnpmStoreVersionDirs({ home = os.homedir(), env = process.env, spawn = spawnSync } = {}) {
  const storeRoots = [];
  const add = (value) => { if (value) storeRoots.push(value); };

  add(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "pnpm", "store"));
  add(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "pnpm-cache", "store"));
  add(env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, "pnpm", "store"));
  add(path.join(home, ".local", "share", "pnpm", "store"));
  add(path.join(home, "Library", "pnpm", "store"));

  try {
    const result = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["store", "path"], { encoding: "utf8" });
    if (result.status === 0) add(String(result.stdout).trim());
  } catch {}

  const versionDirs = [];
  for (const root of uniqueExistingDirectories(storeRoots)) {
    if (/^v\d+$/.test(path.basename(root))) {
      versionDirs.push(root);
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^v\d+$/.test(entry.name)) versionDirs.push(path.join(root, entry.name));
    }
  }
  return uniqueExistingDirectories(versionDirs);
}

export function defaultDeepseekScopeRoots(packageRoot, { home = os.homedir(), env = process.env } = {}) {
  const roots = [
    path.join(packageRoot, "node_modules", "@deepseek-ai"),
    path.resolve(packageRoot, ".."),
    path.join(home, ".dsh", "profiles", "web", "node_modules", "@deepseek-ai"),
    path.join(home, ".dsh", "profiles", "headless", "node_modules", "@deepseek-ai"),
    env.INIT_CWD && path.join(env.INIT_CWD, "node_modules", "@deepseek-ai"),
    env.npm_config_local_prefix && path.join(env.npm_config_local_prefix, "node_modules", "@deepseek-ai")
  ];
  if (env.DSH_CHANNEL_IM_TARGET_ROOTS) roots.push(...env.DSH_CHANNEL_IM_TARGET_ROOTS.split(path.delimiter));
  return uniqueExistingDirectories(roots.filter(Boolean));
}

export function discoverPackageDirs(packageName, {
  packageRoot,
  home = os.homedir(),
  env = process.env,
  spawn = spawnSync,
  version = SUPPORTED_DSH_VERSION,
  scopeRoots
} = {}) {
  if (!packageRoot) throw new Error("packageRoot is required");
  const matches = [];
  const addIfMatch = (candidate) => {
    if (matchingPackage(candidate, packageName, version)) matches.push(candidate);
  };

  for (const scopeRoot of scopeRoots ?? defaultDeepseekScopeRoots(packageRoot, { home, env })) addIfMatch(path.join(scopeRoot, packageName));

  for (const storeVersionDir of discoverPnpmStoreVersionDirs({ home, env, spawn })) {
    const packageVersionsDir = path.join(storeVersionDir, "links", "@deepseek-ai", packageName);
    if (!fs.existsSync(packageVersionsDir)) continue;
    for (const versionEntry of fs.readdirSync(packageVersionsDir, { withFileTypes: true })) {
      if (!versionEntry.isDirectory() || (version !== null && versionEntry.name !== version)) continue;
      const hashesDir = path.join(packageVersionsDir, versionEntry.name);
      for (const hashEntry of fs.readdirSync(hashesDir, { withFileTypes: true })) {
        if (!hashEntry.isDirectory()) continue;
        addIfMatch(path.join(hashesDir, hashEntry.name, "node_modules", "@deepseek-ai", packageName));
      }
    }
  }

  return uniqueExistingDirectories(matches);
}

const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function copyDirectoryWithBackup(sourceDir, destinationDir, backupRoot) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) throw new Error(`override source is not a directory: ${sourceDir}`);
  if (!fs.existsSync(destinationDir) || !fs.statSync(destinationDir).isDirectory()) throw new Error(`target lib is not a directory: ${destinationDir}`);

  let copied = 0;
  const walk = (source, relative = "") => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const relativePath = path.join(relative, entry.name);
      const destinationPath = path.join(destinationDir, relativePath);
      if (entry.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        walk(sourcePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fs.existsSync(destinationPath)) {
        const backupPath = path.join(backupRoot, relativePath);
        if (!fs.existsSync(backupPath)) {
          fs.mkdirSync(path.dirname(backupPath), { recursive: true });
          fs.copyFileSync(destinationPath, backupPath);
        }
      }
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      if (hashFile(sourcePath) !== hashFile(destinationPath)) throw new Error(`override verification failed: ${relativePath}`);
      copied += 1;
    }
  };
  walk(sourceDir);
  return copied;
}

export function verifyDirectory(sourceDir, destinationDir) {
  const mismatches = [];
  const walk = (source, relative = "") => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const relativePath = path.join(relative, entry.name);
      const destinationPath = path.join(destinationDir, relativePath);
      if (entry.isDirectory()) walk(sourcePath, relativePath);
      else if (entry.isFile() && (!fs.existsSync(destinationPath) || hashFile(sourcePath) !== hashFile(destinationPath))) mismatches.push(relativePath);
    }
  };
  walk(sourceDir);
  return mismatches;
}
