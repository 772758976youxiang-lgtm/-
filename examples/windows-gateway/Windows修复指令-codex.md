# Windows 环境修复指令（交给 Codex 的清单）

> 背景：本机是 Windows，安装了 DSH（DeepSeek Harness）。当前问题：① 设置页没有「连接」模块；② 模型设置里 API Key 配置不上（“failed to fetch”）。
> 用户补充：② 的 failed to fetch **已确认是 DSH 服务临时关闭**导致（服务重启即可），重点任务是 **① 环境对齐**：让本机 DSH 与 Mac 同构（建议官方 npm 安装版），并安装自研扩展（dsh-channel-im / install.sh）以同步“本机改动”。
> 目标：让本机 DSH 能正常使用（模型可用），并为“微信通道接入”准备好 Windows 侧环境。**不要改 Mac/云端，只处理本机。**

## 0. 诊断（先做，把结果贴给用户）

```powershell
cd C:\Users\<你>\...\deepseek-harness   # 或你安装 DSH 的目录
npx dsh --version          # 或 dsh --version
# 判断安装方式：
#  A) 若目录里有 packages/ + pnpm-workspace.yaml  → 源码构建（Local Build）
#  B) 若只有 node_modules/@deepseek-ai/dsh 且由 npm 安装 → 官方包
where node; node --version
python --version
```

## 1. 模型 API Key 配置（当前失败重点）

1. 先测网络：浏览器打开 `https://api.deepseek.com`（不通=代理/网络问题，先处理网络）；
2. GUI：设置 → 模型 → 选/加 **DeepSeek** provider（或「+ 添加自定义 API 地址」）：
   - API 密钥：填入用户的 DeepSeek API Key（不要写入任何提交的代码/配置文件仓库）；
   - API 地址：`https://api.deepseek.com`；
   - **模型名手动填写**（如 `deepseek-chat` / `deepseek-v4-flash`），**不要依赖“自动拉取模型目录”**（“failed to fetch”来自目录加载接口）；
   - 点「保存」（不是只填框）；
3. 命令行验证（能出结果=模型 OK）：
   ```powershell
   npx dsh --profile headless "你好"
   ```
4. 若仍 failed to fetch：看 3080 终端日志/`dsh web` 输出的报错贴出来；检查是否设了 `HTTPS_PROXY/HTTP_PROXY`（如有且指向不可达代理，取下重试）。

## 2. 「连接」模块

- 官方安装版默认**没有**「连接」页——它是本机自研扩展（`dsh-channel-im`）注入的，需要：
  ```
  git clone <用户的 dsh-channel-im 私人仓库> dsh-channel-im
  bash dsh-channel-im/install.sh
  ```
  （install.sh 会自动：装技能/预设/桥接副本 + 给设置包注入「连接」页 + 给会话包注入「外部打开」）
- **若本机是源码构建版**（设置布局为“通用设置/模型/Agent 预设”）或补丁报“未找到锚点”→ **不要强行打补丁**；改用**官方 npm 安装版**与本机功能对齐：
  ```powershell
  npm install -g @deepseek-ai/dsh
  npx dsh web
  ```
  （或确认“连接”功能非必需时跳过——功能状态可通过 `curl http://127.0.0.1:5175/api/channels` 查询，5175 端口是桥接管理 API，部署在 Mac/云上则用其 IP 访问）
- **不要修改 DSH 源码仓库里 packages/ 源码来“添加连接页”**（那要改官方包，违背上游结构；我们已有注入脚本方案）。

## 3. 微信通道环境准备（Windows 侧，为联调打底）

- 安装 **Python 3.9+**（`where python` 确认）；
- 确认微信 PC 客户端版本：**必须是 4.1.10.27**（当前 4.1.12.26 不行）——见《微信群聊通道接入说明.md》第三节（降级+version.dll+白名单+小号登录+验证 http://127.0.0.1:30001/QueryDB/GetAllDBName）；
- 网关代码：`dsh-channel-im/examples/windows-gateway/gateway.py`（纯标准库，无需 pip 依赖；config.json 需填 `mac_url`→ Mac/云的 8789）。

## 4. 验收标准

- [ ] `npx dsh --profile headless "你好"` 有正常回复（模型 OK）
- [ ] 浏览器 127.0.0.1:3080 设置页可正常保存模型配置、无 failed to fetch
- [ ] （可选，若跑 install.sh 成功）设置页出现「连接」
- [ ] `python --version` ≥3.9；微信版本号已确认（4.1.10.27 或已降级）

## 5. 注意事项

- 任何凭证（API Key/Secret）**不得写进提交的代码或文档**；用环境变量/本地配置。
- 不要格式化/大改 deepseek-harness 源码；只按上述目标改动；改前 `git status` 确认基线。
