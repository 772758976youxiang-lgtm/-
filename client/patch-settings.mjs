#!/usr/bin/env node
/**
 * dsh-channel-im · 连接页注入脚本（幂等）
 * 用法：node client/patch-settings.mjs <DSH安装>/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js
 * 功能：向已安装的 ui-settings-general 包注入
 *   1) locale 键（zh/en: external.nav/title/intro）
 *   2) ExternalSection 组件（connection.compiled.js）
 *   3) settings.section 注册（id=external-connections，order 20，readStatus 读取桥接状态文件）
 * 已打过补丁（存在标记）则跳过相应步骤，可重复执行。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error("用法: node patch-settings.mjs <.../node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js>");
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const STATUS_PATH = path.join(os.homedir(), ".dsh-im-channels-status.json");
const component = fs.readFileSync(path.join(here, "connection.compiled.js"), "utf8");
let s = fs.readFileSync(target, "utf8");
const done = [];
const fail = (msg) => { console.error("❌ " + msg); process.exit(1); };

// 1) locale（zh/en）
if (!s.includes('"external.nav"')) {
  const zhAnchor = '\t\t\t"general.nav": "通用",';
  if (!s.includes(zhAnchor)) fail("未找到 zh locale 锚点（DSH 版本可能不同）");
  s = s.replace(zhAnchor, zhAnchor +
    '\n\t\t\t"external.nav": "连接",\n\t\t\t"external.title": "连接",\n\t\t\t"external.intro": "IM 通道由 Harness 统一管理，以下为当前已接入的通道及其连接状态。"');
  const enAnchor = '\t\t\t"general.nav": "General",';
  if (!s.includes(enAnchor)) fail("未找到 en locale 锚点");
  s = s.replace(enAnchor, enAnchor +
    '\n\t\t\t"external.nav": "Connections",\n\t\t\t"external.title": "Connections",\n\t\t\t"external.intro": "IM channels are managed by Harness. Below are the currently connected channels and their status."');
  done.push("locale 键 zh/en");
}

// 2) 组件（插入在 const zh = { 之前；函数声明提升，位置无碍）
if (!s.includes("function ExternalSection")) {
  const anchor = "\t\tconst zh = {";
  if (!s.includes(anchor)) fail("未找到组件插入锚点");
  s = s.replace(anchor, component + "\n" + anchor);
  done.push("ExternalSection 组件");
}

// 3) 注册
if (!s.includes("external-connections")) {
  const anchor = "\t\t\t}, GeneralSection));";
  if (!s.includes(anchor)) fail("未找到注册锚点");
  const reg = `\n\t\t\tctx.slots.inject("settings.section", () => ctx.slots.register({
\t\t\t\tname: "settings.section",
\t\t\t\tid: "external-connections",
\t\t\t\torder: 20,
\t\t\t\tlabel: () => t("external.nav"),
\t\t\t\tlocale: NS,
\t\t\t\tinject: () => ({ t, readStatus: async () => { const res = await connection.api.host.readFile({ path: "${STATUS_PATH}" }); if (!res?.result?.ok) return []; try { return JSON.parse(res.result.value.content)?.channels ?? []; } catch { return []; } } })
\t\t\t}, ExternalSection));`;
  s = s.replace(anchor, anchor + reg);
  done.push("external-connections 注册");
}

if (done.length === 0) { console.log("已是最新（无需打补丁）"); process.exit(0); }
fs.writeFileSync(target, s);
console.log(`✅ 连接页补丁完成：${done.join("，")}（状态文件: ${STATUS_PATH}）`);
