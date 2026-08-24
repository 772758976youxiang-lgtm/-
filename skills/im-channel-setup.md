---
name: im-channel-setup
description: 由 Harness 自动搭建和管理微信、钉钉 IM 通道。用户说“搭建/开启/停止/删除/诊断通道”时，必须使用 im_channel_manage；不要让用户自己改配置、运行命令或点击开关。
---

# Harness 通道搭建

通道生命周期只能由本机普通 Harness 会话调用 `im_channel_manage` 管理。外部微信、钉钉通道会话无权调用；连接设置页只展示状态。

## 通用规则

- 第一步调用 `im_channel_manage`，`action=status`，识别当前设备、已安装通道和真实运行状态。
- 不手工编辑 `~/.dsh-im-channels.json`，不让用户执行终端命令，不调用 5175 写接口。
- 换设备后重新调用搭建动作；工具会使用当前系统、当前用户目录和本机可执行文件生成配置并补齐依赖。
- 凭证只作为工具入参传递，不在回复中复述 AppSecret。

## 微信个人号

用户要求搭建或开启微信通道时，直接调用：

```json
{"action":"setup_wechat"}
```

工具会检查 Windows、Python、依赖、微信安装路径、残留进程、Hook、配置文件、工作区和通道服务。返回 `waiting_for_scan` 时，只提示用户在 Harness 拉起的微信窗口扫码或手机确认；返回 `connected` 才能宣布完成。

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

不要自行杀进程或删除工作区目录；工具和 Harness 托管器会完成收尾。
