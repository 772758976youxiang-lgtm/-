---
name: im-channel-setup
description: 接入钉钉通道 — 用户说“接钉钉机器人/接入机器人”时：第一步总是提供选项【真人模式（扫码）/ 机器人模式（凭证）】；选真人→直接给扫码链接，扫码成功自动配置；选机器人→问一次凭证（AppKey/Secret/名字）。不要再问其它任何问题。
---

# 钉钉接入流程（固定三步，绝不加戏）

## 关键位置（确切路径，直接用，禁止搜索）

- **桥接服务**：`~/.dsh-channel-im/server.mjs`（规范安装位；启动：`cd ~/.dsh-channel-im && node server.mjs`）
- **扫码登录**：`~/.dsh-channel-im/auth.mjs`（`node ~/.dsh-channel-im/auth.mjs login`；`/Users/Admin/DeepSeek/dsh-channel-im/` 是源码目录，勿当运行位）
- **通道配置文件**：`~/.dsh-im-channels.json`（唯一事实源；创建/删除/查询优先走下面 API）
- **管理 API**：`http://127.0.0.1:5175`（`GET /api/channels` 查全部通道+id；`POST` 增；`DELETE /api/channels/<id>` 删）
- **桥接状态**：`~/.dsh-im-channels-status.json`（只读，不要手工改）
- **注销登录**：`dws auth logout`

⚠️ **铁律：本段路径是唯一的**——查/增/删一律走 API；**禁止**用 `glob`/`ls`/`grep`/`find`/全文搜索去找 auth.mjs、server.mjs 或通道文件（慢、易因 Library 权限报错、纯属浪费时间）。找不到=先跑 `install.sh` 安装后再用本文路径。

用户说“接钉钉机器人/接入机器人/接真人助手”等时：

## 第 1 步：总是提供选项（用一次 ask_user_question，两个选项）

> **请问接哪种？**
> - **真人模式**：扫码即可，以账号本人身份收发（无需任何凭证）
> - **机器人模式**：需要 Client ID/Secret（钉钉机器人）

## 第 2a 步（真人模式）：总是扫码（不复用），支持多真人账号

- **用户选真人 = 必须扫码**（不做“复用已登录”），给链接 → 扫码 → 自动完成。
- **多真人 = 多账号多通道**：每个账号一个独立通道（id=`dingtalk-person-<账号尾号>`、name=`钉钉-<userName>-数字人`、profile=`corp:user`），多账号可同时在线。
- ⚠️ 前提：每个账号须在组织“CLI 授权人员名单”内（公司策略决定可开几个）。
- 流程：
  1. `node ~/.dsh-channel-im/auth.mjs login` → 拿 **授权URL+授权码** → 直接发用户（手机钉钉打开并登录该账号）；
  2. 日志出现 `✅ 扫码登录成功：… (corp:user)` → **auth.mjs 已自动注册通道**（无需再问）；
  3. 回复“已接入 ✅”。
- **等待扫码期间：若用户不扫/取消/超时未完成 —— 立即终止登录进程**：
  `pkill -f "auth.mjs login"`（或 kill 后台任务 `job-bash-xx`）。
  **然后：停止，把选择权交回用户** —— 回复“授权已过期/已停止，需要时请让我重新生成”，
  **绝对不要自动重新生成链接/自动重试**（那会无限轮询+烧 token）！只有用户明确说“重新扫码/再来一次”，才重新跑。
- 若自动注册失败（API 不可达等），再手动：`curl -s -X POST http://127.0.0.1:5175/api/channels -H "Content-Type: application/json" -d '{"id":"dingtalk-person-<尾号>","platform":"dingtalk","name":"钉钉-<userName>(真人)","mode":"dws","profile":"<corp:user>","ignoreSenders":["harness"],"enabled":true}'`。

## 第 2b 步（机器人模式）：问一次凭证（一个 ask_user_question，三项并列）

> 请提供：① **Client ID（AppKey）** ② **Client Secret（AppSecret）** ③ **机器人名字**

- 已知：**机器人通道名 = `钉钉-<机器人名字>-机器人`**（真人=`钉钉-<账号名>-数字人`）。校验 accessToken（curl oauth2/accessToken）后：`POST /api/channels`（mode:"stream"）→ 自动连接+建工作区 → 告知完成。
- 无效/失败才排查（未启用/未发布/Stream/凭证）。
- **不要**问“是否启用/是否发布/权限开了吗”等前置问题。

## 铁律

- 模式必答选项（第 1 步固定问，不根据措辞跳过，不再问第三类问题）；
- 真人/机器人分支内**没有其它问题**；
- 敏感凭证（Secret/token）勿在会话总结外明文保留。

## 删除通道（只做一件事）

```bash
# 1) 用户说“删掉 xxx/真人机器人/某机器人” -> 先 GET 查到它的 id：
curl -s http://127.0.0.1:5175/api/channels
# 2) 直接用 id 删除（一步到位）：
curl -s -X DELETE http://127.0.0.1:5175/api/channels/<id>
```

**铁律**：
- 删除 = **先 `curl -s http://127.0.0.1:5175/api/channels`** 秒查通道与 id（不要 ls/grep/翻文件系统！）→ `DELETE /api/channels/<id>`。
- **若删除的是真人通道，必须再执行**：`dws auth logout --profile <corp:user>`（或 `dws auth logout`，注销该账号登录态）——**下次接入该真人账号必须重新扫码**。
- 除此之外**不要**再做：手动杀进程、删工作区目录/文件、列出“可选进一步清理”。
- 桥接会在内部自动：停监听/断开连接 + 更新状态 + 让「连接」页消失。
- **回复只一句话**：“已删除 <通道名>。” 不要长篇清单、不要解释每步。
- 用户说“删掉 xxx”而你找不到对应通道时，才用一条 GET 列出当前通道请用户确认。
