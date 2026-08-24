# 微信通道底层链路测试报告

测试日期：2026-08-24  
系统：Windows  
微信：4.1.10.27  
Python：3.14.3  
`wechatauto-replica`：1.1.7

## 真实环境结果

| 项目 | 结果 |
|---|---|
| 微信数据库密钥读取 | 通过，18 个库中 16 个可解密；缺失项为非聊天核心库 |
| 账号和最近会话读取 | 通过 |
| `sort_seq` 基线与增量接口 | 通过，基线后增量为 0，没有回放历史消息 |
| Hook HTTP 服务 | 通过，30001 正在监听 |
| Hook 文本发送 | 通过，发送到 `filehelper` 返回 `ret=0` |
| Hook 发送数据库读回 | 通过，识别为 `sender_id=2` |
| UIA 热激活 | 通过 |
| UIA/OCR 公共发送接口 | 通过，发送到文件传输助手并由数据库确认 |
| DSH AgentAdapter | 通过，创建 Session、生成回复并复用同一会话映射；工作区删除后自动重建 |
| 动画表情接收 | 通过，真实微信记录可下载为 PNG/GIF 并转换为 Harness 图片附件 |
| 普通图片降级 | 通过，缺少本地 AES 密钥/缓存时快速记录媒体事件，不阻塞轮询、不静默丢弃 |
| 管理 API 八个端点 | 通过 |
| SSE 事件 | 通过，收到 `status` 事件 |

Hook 的 `/QueryDB/status` 在本机返回 `IsLogin=0`，但 Hook 实发和数据库读回均成功。因此健康检查以 HTTP 可达和真实发送结果为准，不把该字段单独作为发送失败判据。

## 自动化结果

- Node 兼容性与安装器测试：通过；
- Python 微信通道测试：19 项通过；
- Python 全模块编译：通过；
- SSE 客户端主动断开：按正常连接清理处理，不输出异常栈。

## 连接页开关回归

- 隔离配置下调用 `POST /api/wechat/toggle {"enabled":true}`，自动定位 `C:\Program Files\Tencent\Weixin\Weixin.exe`；
- 登录状态可从 `waiting_for_scan` 自动进入 `connected`，数据库健康检查识别到当前账号；
- 旧进程重启顺序验证：动作前 PID `20736`，动作后 PID `17748`，旧 PID 残留数为 `0`；
- 关闭开关后 `phase=disabled`、通道服务停止，微信客户端继续保留；
- 浏览器 `设置 → 连接` 出现唯一可用的 `role=switch` 控件，初始 `aria-checked=false`，并展示“先关闭旧微信进程，再启动新的扫码窗口”的说明；
- 健康状态探测采用 12 秒上限、3 秒缓存和并发单飞；Python 管理 API 忽略客户端提前断开，避免轮询产生异常堆栈。
- 真实故障回归：`wechatauto-replica` 返回 `type="文本"` 时会归一化为 `text` 并进入 AgentAdapter，不再记为 `unsupported_message`。
- 安装回归：postinstall 会创建 `~/.dsh-channel-im/auth.mjs`、`server.mjs` 与 `package-root.txt`，Windows 真人扫码入口可直接定位 `~/.local/bin/dws.exe`。
- 身份上下文回归：默认策略允许群聊；会话与发送者的昵称、备注、微信号（alias，可用时）会注入 DSH Agent 消息上下文，群聊使用群名称作为会话标题。
- 规则面板回归：管理 API 可保存群聊/联系人黑白名单；每个群聊可独立设置“仅 @AI 回复”。未获回复的群消息仍写入 `/api/recent`，SQLite 固定保留最近 200 条上下文，设置面板不展示消息正文。
- 通道自我设定回归：专属预设能真实挂载 `channel_self_profile_update`，只写入该预设目录的 `self-profile.md`，动态人设会在下一模型步骤重新读取；不接入数据库或记忆库。
- 群聊提及回归：微信 4.x 将本账号名称脱敏成 `@***` 或全角 `@＊＊＊` 时，规则层识别为已提及，并向 Agent 上下文明示“机器人被 @：是”。
- 工作区自愈回归：服务启动后主动校验微信工作区；缓存 ID 对应的工作区被删除时重新创建，失效 Session 在下一条消息时自动换新。
- 媒体接收回归：图片、动画表情、语音、视频和文件事件进入 Agent/上下文；真实动画表情成功物化为 PNG/GIF；持久化上下文不记录本机媒体绝对路径。
