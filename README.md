# @deepseek-ai/dsh-channel-im —— DSH 外部功能一站式插件

> 🤖 **给 Agent 的自动安装入口**：只把本仓库地址发给 Codex/Claude 并说“帮我安装插件”即可——它会读取本页、**AGENTS.md** 与 **INSTALL.md** 后自主完成安装与验证。

**harness 本体之外的所有扩展，一个插件全包（v0.2.2）：**

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

若 pnpm 11 首次安装提示 `ERR_PNPM_IGNORED_BUILDS`，进入 `~/.dsh/profiles/web` 运行 `pnpm approve-builds`，批准 `@deepseek-ai/dsh-channel-im` 后重试上述命令。

- postinstall 自动装配：技能/预设/连接页/外部打开；
- bundle 层自动托管：桥接随宿主启停；
- git clone 本地开发：`dsh plugin --profile web install /path/to/this`

v0.2.2 已对齐 DSH `0.1.1-rc.2` 与 pnpm 11：安装器能定位 pnpm link store 中的真实运行包，逐文件备份、覆盖并校验；任一必要覆盖缺失时安装会明确失败，不再静默显示成功。

## 官方功能对齐（overrides）

本插件内置 7 个包的**编译产物覆盖**（来自私人仓库 `3ef702b` 提交，共 43 文件的功能改造）：
**峰谷计价 / 周末全天谷价 / token 成本估算 / 账户余额 / “燃烧 token”提示 / 文件查看 / 相关中文文案**。
安装时 postinstall 自动覆盖到官方 npm 包上 → **官方 harness + 本插件 = 完整（含这些功能改造）**，无需从源码构建。覆盖仅应用于 DSH `0.1.1-rc.2`，避免误改不兼容版本。

安装后可执行 `npm run verify:install`，对 7 个运行包逐文件进行 SHA-256 校验。源码检查与打包分别使用 `npm test`、`npm pack`；`prepack` 会自动先执行完整测试。安装器会先预检全部目标的版本和写权限，再开始覆盖，避免缺包时留下半安装状态。

## 凭证自理（设计约定）

API Key / 通道 AppKey·Secret / 数字人登录态 **一律不入包**；新设备按《harness-说明书.md》4 项引导自配。

## 说明

- 演示台和旧版字符串注入脚本已移除；“连接”由原生 client 插件提供，“外部打开”随版本化 overrides 安装。
- 源码构建版或自定义依赖布局可用 `DSH_CHANNEL_IM_TARGET_ROOTS` 指定 `node_modules/@deepseek-ai`。
