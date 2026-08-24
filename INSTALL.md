# dsh-channel-im · 注册与安装方法（含全部坑）

## 一、注册机制（DSH 官方 Bundle 插件）

DSH（deepseek-harness）的插件 = **Bundle**：
- **Profile**：宿主目录（Harness home，如 `~/.dsh/profiles/web/`）下的“命名组合”，列出它叠加的 bundles + 用户自己的 `cordis.patch.yml`；
- **Bundle**：一个 npm 包，`package.json` 里声明 `"dsh": { "bundle": { "patch": "<patch 文件>" } }`；patch 文件是 cordis 行（对已有行按 id 改配置，或插入新行）；
- 本插件声明：`dsh.bundle.patch = bundle/dsh-channel-im.cordis.yml` → **插入服务行 `channel-im-bridge`**（`@deepseek-ai/dsh-channel-im`），随宿主启动/停止托管桥接；同一包的 `dsh.client` 面注册“连接”页，不重复插入第二个服务实例；
- **安装命令**（`dsh plugin`）会把剩余参数转发给 profile 目录内的 pnpm 安装/卸载包，并更新该 profile 的 bundles 列表（读取包 `package.json` 的 `dsh.bundle`）。

## 二、安装方法

### 方式 1：全新机器（推荐）
```bash
# 0) 前置：Node ≥18、dsh CLI（npm i -g @deepseek-ai/dsh）、GitHub SSH key 可访问私人仓库
# 1) 安装（自动初始化 profile web）
dsh plugin --profile web install git+ssh://git@github.com:772758976youxiang-lgtm/-.git
# pnpm 11 若提示 ERR_PNPM_IGNORED_BUILDS：
cd ~/.dsh/profiles/web && pnpm approve-builds
# 选择 @deepseek-ai/dsh-channel-im 后，回到原目录重新执行安装命令
# 2) 启动宿主（插件 postinstall 已自动装配：技能/预设/连接页/外部打开）
npx dsh web          # 或你原有的启动方式
# 3) 自检（见第四节）
```

### 方式 2：本地开发 / 离线
```bash
git clone git@github.com:772758976youxiang-lgtm/-.git dsh-channel-im-plugin
dsh plugin --profile web install /absolute/path/to/dsh-channel-im-plugin
```

### 方式 3：源码构建版（从 deepseek-harness 源码跑）
```bash
# 同方式 1/2 安装；「连接」页由原生 dsh.client 提供。
# 若源码仓库使用自定义依赖布局，显式提供作用域根目录：
DSH_CHANNEL_IM_TARGET_ROOTS=/path/to/deepseek-harness/node_modules/@deepseek-ai dsh plugin --profile web install /path/to/this
```

## 三、常见坑（务必先读）

| # | 坑 | 现象 | 解法 |
|---|---|---|---|
| 1 | **pnpm 未安装** | `dsh plugin` 安装命令报 pnpm 错误 | `npm i -g pnpm`；或直接手动：`cd ~/.dsh/profiles/web && pnpm add <包>` |
| 2 | **源码构建版/自定义布局** | postinstall 提示找不到 7 个目标包 | 设置 `DSH_CHANNEL_IM_TARGET_ROOTS` 指向该构建的 `node_modules/@deepseek-ai`；安装器仍会强制核对包名与 DSH 版本 |
| 3 | **postinstall 被 pnpm 阻止** | `ERR_PNPM_IGNORED_BUILDS`，技能/预设没装 | `cd ~/.dsh/profiles/web && pnpm approve-builds`，批准本插件后重新安装；仍失败再手动运行 `node node_modules/@deepseek-ai/dsh-channel-im/scripts/install-assets.mjs` |
| 3a | **pnpm link store** | 插件包存在余额/峰谷代码，但 Web 不显示 | v0.2.3 已自动扫描 pnpm `store/v*/links` 并校验 7 个目标包；运行 `npm run verify:install` 复核。自定义布局可设置 `DSH_CHANNEL_IM_TARGET_ROOTS=<node_modules/@deepseek-ai>` |
| 4 | **凭证未配** | 能启动但对话不通（模型 key 未填）/ 连接页空（无通道配置） | 按“凭证自理 4 项”：模型 Key（设置→模型）、钉钉机器人凭证/数字人扫码、微信小号+hook（Windows） |
| 5 | **端口冲突** | 桥接管理API 5175 被占用 | 改 bundle 行 `managementPort`（`~/.dsh/profiles/web/cordis.patch.yml` 可覆盖），或停掉占进程 |
| 6 | **3080 被旧进程占用** | 新宿主起不来/页面是旧版 | 停旧 `dsh web` 进程再启 |
| 7 | **数字人登录态跨机** | 新机数字人不认证 | macOS keychain 模式无法 `dws auth export`；直接**重新扫码**（auth.mjs，符合“真人=必扫码”约定） |
| 8 | **私人仓库访问** | 安装报“could not read from remote” | 确认 SSH key 已加入 GitHub；`ssh -T git@github.com` 验证 |
| 9 | **微信通道位置** | 群聊通道在 Mac/Linux 上不存在 | 微信 Hook/UIA/OCR 只能在 **Windows**（小号+4.1.10.27+version.dll）；正式服务位于 `wechat_channel/`，旧 `examples/windows-gateway/gateway.py` 仅供演示兼容 |
| 9a | **正式微信通道依赖** | `mode=wechat_pc` 启动后立即退出 | Windows 执行 `python -m pip install -r wechat_channel/requirements.txt`；再运行 `python -m wechat_channel diagnose --config wechat_channel/config.example.json` |
| 9b | **微信发送降级** | Hook 可发但 UIA/OCR 不可用 | 打开并登录微信主聊天窗口、保持桌面解锁；普通文本依次走 Hook、UIA/OCR，全部失败才记为失败 |
| 9c | **群聊真实 @** | 日志显示 `SendAtText` 404 | 为 `4.1.10.27` Hook 应用 `wechat_channel/hook/aixed-4.1.10.27-send-at-text.patch` 并重新构建/替换 `version.dll`；群 @ 不允许降级到 UIA/OCR |
| 10 | **凭证安全** | 勿把 `~/.dsh-im-channels.json`、`.credentials.yaml`、`~/.dsh/settings.yaml` 提交/公开 | 仓库/插件零凭证；泄露则尽快去相应平台重置 |
| 11 | **卸载残留** | 移除插件后旧配置仍在 | `dsh plugin --profile web uninstall/remove <pkg>`；再按需删 `~/.dsh-im-channels.json`、技能、预设、`~/.dsh-channel-im` |
| 12 | **中文分支显示** | GitHub 显示默认分支为“掌握” | 那是 master 的中文翻译，别删别重建 |

## 四、安装后自检

```bash
# 桥接（随宿主）：
curl -s http://127.0.0.1:5175/api/channels     # 应返回 JSON（含通道列表/空数组）
# 技能/预设（postinstall 落位）：
ls ~/.dsh/skills/ | grep -E "im-channel-setup|harness-docs"
ls ~/.dsh/.agent-presets/robot-assistant/
# 设置页：预设出现「机器人助手」；「连接」出现（官方 npm 版）
# 余额/峰谷等 7 包覆盖完整性（在插件目录执行）：
npm run verify:install
# 模型自检：
npx dsh --profile headless "你好"
```

## 五、开发构建与发布前检查

```bash
# Node.js >= 18；本仓库不需要 TypeScript 编译，生产产物已放在 overrides/。
npm test
npm pack

# 从生成的 tgz 做真实安装后，再校验运行包：
npm run verify:install
```

- `packageManager` 固定为 pnpm 11.19.0，钉钉 SDK 固定为已验证的 2.0.4；Cordis peer 标记为宿主提供的 optional peer，避免独立打包时产生误导性缺失警告。
- `prepack` 自动运行测试；路径发现和备份覆盖均有 Node 内置测试，不需要额外开发依赖。
- 安装器仅覆盖版本完全匹配的 DSH `0.1.1-rc.2` 包，并把首次原文件保存到各包 `lib/.dsh-channel-im-backup/`。
- 若确实只想安装桥接而跳过官方功能覆盖，可显式设置 `DSH_CHANNEL_IM_ALLOW_PARTIAL_INSTALL=1`；默认缺包即失败，避免半安装。

## 六、文档索引

- 总览/模块清单：`README.md`
- Windows 微信通道：`examples/windows-gateway/gateway-说明.md`、`微信群聊通道接入说明.md`
- 框架说明书（含凭证自理 4 项引导）：`deepseek-harness/harness-说明书.md`（主仓库）
- 技能细则：`skills/*.md`
