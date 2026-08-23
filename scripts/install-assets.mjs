#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirectoryWithBackup, discoverPackageDirs, installRuntimeLaunchers } from "./install-utils.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const HOME = os.homedir();
const DSH = path.join(HOME, ".dsh");
const done = [];
const failures = [];
const log = (message) => console.log(`  ${message}`);
const allowPartial = process.env.DSH_CHANNEL_IM_ALLOW_PARTIAL_INSTALL === "1";

try {
  const runtimeDir = path.join(HOME, ".dsh-channel-im");
  const launchers = installRuntimeLaunchers(PKG, runtimeDir);
  done.push(`稳定启动入口 ${runtimeDir}（${launchers.join("、")}）`);

  for (const [srcName, dstName] of [["im-channel-setup.md", "im-channel-setup.md"], ["harness-docs-update.md", "harness-docs.md"]]) {
    const source = path.join(PKG, "skills", srcName);
    if (!fs.existsSync(source)) throw new Error(`缺少技能文件：${source}`);
    for (const directory of [path.join(DSH, "skills"), path.join(HOME, ".agents", "skills")]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.copyFileSync(source, path.join(directory, dstName));
    }
  }
  done.push("技能×2 → ~/.dsh/skills、~/.agents/skills");

  const presetSource = path.join(PKG, "presets", "robot-assistant");
  const presetDestination = path.join(DSH, ".agent-presets", "robot-assistant");
  fs.mkdirSync(presetDestination, { recursive: true });
  for (const file of ["preset.yml", "agent.cordis.yml"]) {
    const source = path.join(presetSource, file);
    if (!fs.existsSync(source)) throw new Error(`缺少预设文件：${source}`);
    fs.copyFileSync(source, path.join(presetDestination, file));
  }
  done.push("「机器人助手」预设");

  const overrideRoot = path.join(PKG, "overrides");
  if (!fs.existsSync(overrideRoot)) throw new Error(`缺少 overrides 目录：${overrideRoot}`);
  const overrideJobs = [];
  for (const entry of fs.readdirSync(overrideRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceLib = path.join(overrideRoot, entry.name, "lib");
    if (!fs.existsSync(sourceLib) || !fs.statSync(sourceLib).isDirectory()) {
      failures.push(`覆盖源无效：${sourceLib}`);
      continue;
    }
    const targets = discoverPackageDirs(entry.name, { packageRoot: PKG });
    if (targets.length === 0) {
      failures.push(`未找到目标包：@deepseek-ai/${entry.name}`);
      continue;
    }
    for (const target of targets) {
      const destinationLib = path.join(target, "lib");
      try {
        fs.accessSync(destinationLib, fs.constants.R_OK | fs.constants.W_OK);
        overrideJobs.push({ packageName: entry.name, sourceLib, destinationLib });
      } catch {
        failures.push(`目标目录不可写：${destinationLib}`);
      }
    }
  }

  // 默认先完成全部目标预检，再写入任何运行包，避免产生不可见的半覆盖状态。
  if (failures.length === 0 || allowPartial) {
    for (const { packageName, sourceLib, destinationLib } of overrideJobs) {
      const backupRoot = path.join(destinationLib, ".dsh-channel-im-backup");
      try {
        const count = copyDirectoryWithBackup(sourceLib, destinationLib, backupRoot);
        done.push(`功能覆盖 @deepseek-ai/${packageName}（${count} 文件）`);
      } catch (error) {
        failures.push(`覆盖 @deepseek-ai/${packageName} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log("\n✅ dsh-channel-im 插件资产装配结果：");
  for (const item of done) log(`✓ ${item}`);
  if (failures.length > 0) {
    console.error("\n❌ 未完成项目：");
    for (const item of failures) log(`• ${item}`);
    console.error("  可设置 DSH_CHANNEL_IM_TARGET_ROOTS 指向 node_modules/@deepseek-ai；仅需跳过覆盖时设置 DSH_CHANNEL_IM_ALLOW_PARTIAL_INSTALL=1。");
    if (!allowPartial) process.exitCode = 1;
  }
  console.log("\n下一步（凭证自理）：设置→模型填写 DeepSeek API Key；通道凭证按《harness-说明书》配置。\n");
} catch (error) {
  console.error("资产装配失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
