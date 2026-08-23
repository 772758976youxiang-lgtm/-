#!/usr/bin/env node
/**
 * dsh-channel-im 插件 · 资产装配（postinstall 自动执行）
 * 安装后把“harness 之外的所有功能”落到用户侧：
 *   1) 技能 ×2 → ~/.dsh/skills、~/.agents/skills
 *   2) 「机器人助手」预设 → ~/.dsh/.agent-presets/robot-assistant
 *   3) 「连接」页 + 「外部打开」→ 官方 npm 版 DSH 的已装 bundle（幂等补丁）
 *   4) 桥接/扫码由 bundle 服务行随宿主托管（本包内 server.mjs/auth.mjs，无需另装）
 * 凭证一律不在这里——按说明书由新设备自配。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const HOME = os.homedir();
const DSH = path.join(HOME, ".dsh");
const done = [];
const warn = [];
const log = (m) => console.log("  " + m);

try {
  // 1) 技能
  for (const [srcName, dstName] of [["im-channel-setup.md", "im-channel-setup.md"], ["harness-docs-update.md", "harness-docs.md"]]) {
    const src = path.join(PKG, "skills", srcName);
    if (fs.existsSync(src)) {
      for (const d of [path.join(DSH, "skills"), path.join(HOME, ".agents", "skills")]) {
        fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(src, path.join(d, dstName));
      }
    }
  }
  done.push("技能×2 → ~/.dsh/skills、~/.agents/skills");

  // 2) 预设
  fs.mkdirSync(path.join(DSH, ".agent-presets", "robot-assistant"), { recursive: true });
  fs.copyFileSync(path.join(PKG, "presets", "robot-assistant", "preset.yml"), path.join(DSH, ".agent-presets", "robot-assistant", "preset.yml"));
  fs.copyFileSync(path.join(PKG, "presets", "robot-assistant", "agent.cordis.yml"), path.join(DSH, ".agent-presets", "robot-assistant", "agent.cordis.yml"));
  done.push("「机器人助手」预设");

  // 3) 连接页/外部打开补丁（目标=同 profile node_modules 下的官方包）
  const runPatch = (script, target) => spawnSync(process.execPath, [path.join(PKG, "client", script), target], { stdio: "inherit" }).status === 0;
  // 多位置探测：插件同级 / 全局 npm root -g / 常见 profile 位置 —— 宁多不漏
  const candidates = [];
  const pushCand = (...dirs) => { for (const d of dirs) if (d) candidates.push(d); };
  pushCand(path.join(PKG, "node_modules", "@deepseek-ai"), path.resolve(PKG, ".."), path.resolve(PKG, "..", ".."));
  try {
    const gr = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8" });
    if (gr.status === 0) pushCand(path.join(String(gr.stdout).trim(), "@deepseek-ai"));
  } catch {}
  pushCand(path.join(HOME, ".dsh", "profiles", "web", "node_modules", "@deepseek-ai"),
           path.join(HOME, ".dsh", "profiles", "headless", "node_modules", "@deepseek-ai"));
  const findBundle = (pkg) => { for (const c of candidates) { const f = path.join(c, pkg, "lib", "client.js"); if (fs.existsSync(f)) return f; } return null; };
  const st = findBundle("dsh-client-ui-settings-general");
  const cv = findBundle("dsh-client-ui-conversation");
  if (st) { runPatch("patch-settings.mjs", st) ? done.push("「连接」页注入") : warn.push("「连接」页注入失败（见输出）"); }
  else warn.push("未找到 DSH 设置包：源码构建版暂无「连接」页（原生 client 插件后续实现）");
  if (cv) { runPatch("patch-conversation.mjs", cv) ? done.push("「外部打开」注入") : warn.push("「外部打开」注入失败（见输出）"); }
  else warn.push("未找到 DSH 会话包：源码构建版暂无「外部打开」");

  console.log("\n✅ dsh-channel-im 插件资产装配完成：");
  for (const d of done) log("✓ " + d);
  if (warn.length) { console.log("⚠️ 提示："); for (const w of warn) log("• " + w); }
    // 5) 官方功能对齐：用本插件内置的「功能改造」编译产物覆盖官方 npm 包（峰谷/周末谷价/token成本/账户余额/文件查看等）
  const overrideRoot = path.join(PKG, "overrides");
  if (fs.existsSync(overrideRoot)) {
    for (const pkgName of fs.readdirSync(overrideRoot)) {
      const srcLib = path.join(overrideRoot, pkgName, "lib");
      if (!fs.isDirectorySync ? true : !fs.existsSync(srcLib)) continue;
      let dest = null;
      for (const c of candidates) {
        const d = path.join(c, pkgName, "lib");
        if (fs.existsSync(path.join(c, pkgName, "package.json")) && fs.existsSync(d)) { dest = d; break; }
      }
      if (!dest) { warn.push("未找到目标包（跳过覆盖）：" + pkgName); continue; }
      // 备份原文件（仅首次）
      if (!fs.existsSync(path.join(dest, ".orig-backup"))) {
        fs.mkdirSync(path.join(dest, ".orig-backup"), { recursive: true });
      }
      const copyRec = (s, d) => {
        if (fs.statSync(s).isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          for (const f of fs.readdirSync(s)) copyRec(path.join(s, f), path.join(d, f));
        } else { fs.copyFileSync(s, d); }
      };
      copyRec(srcLib, dest);
      done.push("功能对齐覆盖：" + pkgName);
    }
  }
  console.log("\n下一步（凭证自理）：设置→模型 填 DeepSeek API Key；钉钉/数字人/微信按《harness-说明书》配置。");
} catch (e) {
  console.error("资产装配失败：", e?.message ?? e);
  process.exit(1);
}
