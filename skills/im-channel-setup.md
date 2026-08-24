---
name: im-channel-setup
description: 由 Harness 自动搭建和管理微信、钉钉 IM 通道。用户说“搭建/开启/停止/删除/诊断通道”时，通过 im_channel_manage 完成全部配置与操作。
---

# Harness 通道搭建

本机普通 Harness 会话通过 `im_channel_manage` 管理通道生命周期；外部微信、钉钉通道会话负责日常消息交互，连接设置页负责展示状态。

## 通用规则

- 第一步调用 `im_channel_manage`，`action=status`，识别当前设备、已安装通道和真实运行状态。
- 配置文件、终端步骤和 5175 写接口全部交由 `im_channel_manage` 与 Harness 托管器处理。
- 换设备后重新调用搭建动作；工具会使用当前系统、当前用户目录和本机可执行文件生成配置并补齐依赖。
- 凭证作为工具入参安全传递，回复中展示通道名称和配置结果。

## 微信个人号

用户要求搭建或开启微信通道时，直接调用：

```json
{"action":"setup_wechat"}
```

工具会检查 Windows、Python、依赖、微信安装路径、Hook、配置文件、工作区和通道服务。进入 `waiting_for_login` 后会自动执行最长 3 分钟的后台观察：内部每 5 秒检查一次，只在阶段变化或每分钟汇报。Agent 向用户做一次扫码、点击登录或手机确认的简短说明，随后由 Harness 自行检测登录结果并自动推进。

检测到登录完成后，插件会自动唤醒当前 Agent。Agent 必须直接调用 `status` 做最终收发健康检查，通过后调用：

```json
{"action":"confirm_wechat_ready","channelId":"工具返回的通道 ID"}
```

最终验收通过后宣布完成。3 分钟内未登录会进入 `login_timeout` 并自动取消本次任务；Agent 简短报告超时结果并结束任务，微信进程保持原状。

停止微信通道使用：

```json
{"action":"stop_wechat"}
```

## 钉钉

用户只说“接钉钉”时，询问一次：真人模式还是机器人模式。

- 真人模式：调用 `begin_dingtalk_person_login`，把工具返回的授权地址和验证码交给用户；扫码完成后 Harness 自动注册通道。
- 机器人模式：一次收集机器人名字、Client ID/AppKey、Client Secret/AppSecret，然后调用 `configure_dingtalk_robot`。

## 删除

先用 `status` 找到准确 `channelId`，再调用：

```json
{"action":"remove_channel","channelId":"准确的通道 ID"}
```

进程与工作区收尾统一交给工具和 Harness 托管器完成。
