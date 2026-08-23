# AGENTS.md —— 自动安装执行指令（供 Codex/Claude 等 Agent 读取后自主执行）

本仓库是 **DeepSeek Harness 插件（dsh-channel-im）安装包**。用户只给你本仓库地址和一句“帮我安装插件”。请自主完成以下全部步骤，**先读 `INSTALL.md` 与 `README.md` 了解机制与坑，再执行**；每步汇报结果，不遗漏。

## 目标（完成判定）

安装后：桥接随宿主运行（管理API 5175 可访问）、技能×2 与「机器人助手」预设已落位、设置页出现「连接」（官方 npm 版）、模型可对话。

## 步骤

1. **前置**：`node --version`（≥18）、`npm --version`、`git --version`；`ssh -T git@github.com` 验证 GitHub SSH；缺失项自行安装。
2. **dsh CLI**：`npm i -g @deepseek-ai/dsh`（若 `npx dsh --version` 报错）。
3. **本仓库**：已在本机时直接使用；否则 `git clone git@github.com:772758976youxiang-lgtm/-.git`。
4. **安装插件**（二选一，优先本地路径以利用本仓库源码）：
   - `dsh plugin --profile web install <本仓库绝对路径>`
   - 或 `dsh plugin --profile web install git+ssh://git@github.com:772758976youxiang-lgtm/-.git`
   若 `dsh plugin` 因 pnpm 缺失失败：`npm i -g pnpm` 后重试。
5. **确保用官方 npm 版 DSH 运行**：`npx dsh web`（若发现本机是源码构建版——设置页标题含 Local Build——不要继续打补丁，先统一为官方 npm 版并重启；原因见 INSTALL.md 坑2）。
6. **验证清单**（逐项执行并汇报）：
   - `curl -s http://127.0.0.1:5175/api/channels` → JSON
   - `ls ~/.dsh/skills/` → 含 `im-channel-setup.md`、`harness-docs.md`
   - `ls ~/.dsh/.agent-presets/robot-assistant/` → 两个文件存在
   - 浏览器 127.0.0.1:3080：设置→预设 有「机器人助手」；设置→连接 出现（npm 版）
   - `npx dsh --profile headless "你好"` 正常回答（若未配 API Key：提示用户在 设置→模型 填入 → 这是“凭证自理”，不要替用户生成/猜测密钥）
7. **失败处理**：先查 `INSTALL.md` 第三节“坑排查表”；仍失败则汇报完整报错与我采取的排查动作。

## 红线

- **不生成/不猜测任何凭证**（API Key、通道 Secret、登录态）：一律由用户在设置页/钉钉侧提供（凭证自理约定）。
- **不改 DSH 源码**；不删除/重建 GitHub 默认分支。
- 安装后如需常驻：`pm2`/服务方式启动 `npx dsh web`（可选，不强制）。
