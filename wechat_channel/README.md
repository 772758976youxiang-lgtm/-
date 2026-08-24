# 微信个人号通道

该服务把 Windows 微信 PC 封装成独立 Agent 通道：`wechatauto-replica` 读取本地加密数据库，`aixed/WeChat-Hook` 优先发送，失败后由 `wechatauto-replica` 的 UIA/OCR 公共发送接口兜底。

## 已实现

- 私聊与群聊文本标准化，群聊 `sender_wxid:\n正文` 解析；微信将本账号提及脱敏为 `@***` 时仍能识别“机器人被 @”；
- 首次启动只建立 `sort_seq` 基线，不回复历史消息；
- SQLite 持久化游标、去重键、Agent Session、发送任务、结果和审计日志；
- `sender_id=2` 自发消息过滤；
- `wechat:<account_id>:<conversation_id>` 固定会话键；
- DSH、通用 HTTP、进程和 Echo 四种 AgentAdapter；
- 单一串行发送队列，Hook → UIA/OCR，超时、有限重试和幂等发送；
- 连续读取失败自动重建数据库驱动；
- 回环管理 API、可选 Token、联系人/群白名单、限频和紧急停用；
- SSE `message`、`status`、`send`、`log`、`recent` 事件。

首版仅处理文本；图片、文件、语音和多账号属于后续扩展。

## 环境

```powershell
python -m pip install -r wechat_channel/requirements.txt
python -m wechat_channel diagnose --config wechat_channel/config.example.json
```

固定基线：

- `wechatauto-replica==1.1.7`
- 微信 PC `4.1.10.27`
- Hook 地址 `http://127.0.0.1:30001`
- Python 3.9+

Hook 的公开实现默认监听 `0.0.0.0:30001`。应通过 Windows 防火墙只允许本机访问；本服务拒绝配置非回环 Hook 地址。

## 启动

复制 `config.example.json` 到 `%USERPROFILE%\.dsh-wechat-channel.json`，按需填写群白名单，然后运行：

```powershell
python -m wechat_channel run --config "$env:USERPROFILE\.dsh-wechat-channel.json"
```

安装为 DSH 插件后，也可直接进入「设置 → 连接」打开“微信个人号”开关。插件会先关闭现有 `Weixin.exe/WeChat.exe` 进程树，再启动新的可见登录窗口，等待扫码或手机确认，并在数据库可读后把状态切换为“已连接”。关闭开关只停止自动收发服务，不会退出微信或删除 SQLite 状态。

也可以让插件宿主管理进程。在 `~/.dsh-im-channels.json` 添加：

```json
{
  "channels": [
    {
      "id": "wechat-main",
      "platform": "wechat",
      "name": "微信个人号",
      "mode": "wechat_pc",
      "configFile": "C:/Users/<user>/.dsh-wechat-channel.json",
      "enabled": true
    }
  ]
}
```

Node 桥接会随 DSH 启停 Python 服务。`DSH_WECHAT_PYTHON` 可指定 Python 路径；`DSH_WECHAT_CONFIG` 可指定默认配置文件。

## 管理 API

默认地址为 `http://127.0.0.1:5176`：

```text
GET  /api/status
GET  /api/history
GET  /api/recent
GET  /api/contacts
GET  /api/logs
GET  /api/events
POST /api/send
POST /api/echo
POST /api/recover
```

手动发送：

```powershell
Invoke-RestMethod -Method Post -ContentType application/json `
  -Body '{"target_id":"filehelper","text":"测试"}' `
  http://127.0.0.1:5176/api/send
```

Echo 模式：

```powershell
Invoke-RestMethod -Method Post -ContentType application/json `
  -Body '{"enabled":true}' `
  http://127.0.0.1:5176/api/echo
```

若 `WECHAT_CHANNEL_TOKEN` 有值，请求必须携带 `Authorization: Bearer <token>` 或 `X-WeChat-Channel-Token`。

## AgentAdapter

默认 `agent.adapter=dsh`，直接复用本机 DSH 的工作区与 Session；由桥接器为每个通道自动创建并指定独立预设。预设初始自我设定为空，只挂载机器人专用的自我设定工具；它可在回复后把稳定人设写入当前通道的 `self-profile.md`，但不会保存用户资料、聊天内容、任务或记忆。也可改为：

- `echo`：独立验证微信收发；
- `http`：调用 `/health`、`/sessions`、`/respond`；
- `process`：向本地命令的 stdin 写入 JSON，并读取 JSON 或纯文本 stdout。

无论使用何种 Adapter，微信驱动和发送代码都不需要修改。

## 测试

```powershell
npm test
python -m unittest discover -s tests -p "test_wechat_channel*.py"
```

测试覆盖首次基线、增量消息、自发消息过滤、会话与任务持久化、发送降级、回环地址限制和管理 API。
