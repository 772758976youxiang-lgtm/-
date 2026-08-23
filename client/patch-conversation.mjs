#!/usr/bin/env node
/**
 * dsh-channel-im · 「外部打开」按钮注入脚本（幂等）
 * 用法：node client/patch-conversation.mjs <DSH安装>/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js
 * 功能：向已安装的 ui-conversation 包注入
 *   1) locale 键（zh/en: details.openExternal="外部打开"/"Open externally"）
 *   2) 会话详情面板(DetailsPanel)头部“外部打开”按钮（open-external.compiled.js，点击调用 openPath(file.path)）
 * 已打过补丁（存在标记）则跳过相应步骤，可重复执行。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error("用法: node patch-conversation.mjs <.../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js>");
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const snippet = fs.readFileSync(path.join(here, "open-external.compiled.js"), "utf8").trimEnd();
const anchor = snippet.split("\n").slice(0, 3).join("\n"); // title div 块的前 3 行
let s = fs.readFileSync(target, "utf8");
const done = [];
const fail = (msg) => { console.error("❌ " + msg); process.exit(1); };

// 1) locale zh / en
if (!s.includes('"details.openExternal": "外部打开"')) {
  const zhAnchor = '\t\t\t"details.close": "关闭详情",';
  if (!s.includes(zhAnchor)) fail("未找到 zh locale 锚点");
  s = s.replace(zhAnchor, zhAnchor + '\n\t\t\t"details.openExternal": "外部打开",');
  done.push("locale zh");
}
if (!s.includes('"details.openExternal": "Open externally"')) {
  const enAnchor = '\t\t\t"details.close": "Close details",';
  if (!s.includes(enAnchor)) fail("未找到 en locale 锚点");
  s = s.replace(enAnchor, enAnchor + '\n\t\t\t"details.openExternal": "Open externally",');
  done.push("locale en");
}

// 2) 按钮（DetailsPanel 头部，title div 后插入）
if (!s.includes('"aria-label": t("details.openExternal"),')) {
  if (!s.includes(anchor)) fail("未找到按钮锚点（DetailsPanel title div），DSH 版本可能不同");
  s = s.replace(anchor, snippet);
  done.push("外部打开按钮");
}

if (done.length === 0) { console.log("已是最新（无需打补丁）"); process.exit(0); }
fs.writeFileSync(target, s);
console.log(`✅ 「外部打开」补丁完成：${done.join("，")}`);
