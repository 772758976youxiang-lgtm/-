---
name: im-send
description: 主动发 IM 消息（钉钉）— 用户要求“给某人发消息/发通知/汇报到钉钉”时使用；调用桥接管理 API POST /api/send（机器人或数字人身份），返回即投递成功。
---

# 主动发送消息（im-send）

桥接管理 API 提供主动发送：`POST http://127.0.0.1:5175/api/send`

```bash
# 机器人身份（如 harness-测试机器人）→ 指定钉钉 userId：
curl -s -X POST http://127.0.0.1:5175/api/send -H "Content-Type: application/json" \
  -d '{"channelId":"<通道id>","userId":"<钉钉用户唯一号>","text":"<内容>"}'

# 数字人身份（以账号本人发送，如 江俊）：
curl -s -X POST http://127.0.0.1:5175/api/send -H "Content-Type: application/json" \
  -d '{"channelId":"<dws通道id>","openDingtalkId":"<对方open id>","text":"<内容>"}'
```

## 规则
- 通道 id 先查询：`curl -s http://127.0.0.1:5175/api/channels`（按 name 找 id）；
- 机器人通道用 `userId`（如江俊 `040640486858880459`）；数字人通道用 `openDingtalkId`；
- 返回 `{"ok":true}` 即成功；失败看 `stdout/stderr`；
- 该通道无需“在线”也能发（发送走钉钉官方接口）。
