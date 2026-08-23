# @deepseek-ai/dsh-channel-im —— DSH 外部功能一站式插件

> 🤖 **给 Agent 的自动安装入口**：只把本仓库地址发给 Codex/Claude 并说“帮我安装插件”即可——它会读取本页、**AGENTS.md** 与 **INSTALL.md** 后自主完成安装与验证。

**harness 本体之外的所有扩展，一个插件全包（v0.2）：**

| 模块 | 说明 |
|---|---|
| 桥接 `server.mjs` | 钉钉机器人(stream)/数字人(dws)/企微预留：随宿主启停、崩溃自重启、管理API 5175、热加载、看门狗、工作区自愈、防互聊/防自环 |
| 扫码 `auth.mjs` | 钉钉数字人设备流登录，成功自动注册通道（120s 超时） |
| 「连接」页 | **原生 client 插件**（同包 dsh.client 面，注册 settings.section；经 5175 读状态，任何构建形态都生效） |
| 「外部打开」 | 会话详情按钮（官方 npm 版经注入生效；原生槽位插件化在后续版本） |
| 技能 ×2 | `im-channel-setup`（通道自助接入）+ `harness-docs`（说明书自动维护） |
| 预设 | 「机器人助手」（无命令/无联网/数字员工人格） |
| Windows 网关 | `examples/windows-gateway/gateway.py` + 接入说明/修复指令（微信通道生产件） |

## 安装（新机器一行）

> 完整说明见 **`INSTALL.md`**：注册机制（profile/bundle/patch）、3 种安装方式、**12 个坑的排查表**、安装后自检清单。

```bash
dsh plugin --profile web install git+ssh://git@github.com:772758976youxiang-lgtm/-.git
```

- postinstall 自动装配：技能/预设/连接页/外部打开；
- bundle 层自动托管：桥接随宿主启停；
- git clone 本地开发：`dsh plugin --profile web install /path/to/this`

## 凭证自理（设计约定）

API Key / 通道 AppKey·Secret / 数字人登录态 **一律不入包**；新设备按《harness-说明书.md》4 项引导自配。

## 说明

- 演示台（开发验证用）已全部移除；本包只含生产件。
- 源码构建版：连接页/外部打开为“官方 npm 版注入”；原生 client 插件化在后续版本。
