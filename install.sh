#!/bin/bash
# dsh-channel-im 安装脚本：把本功能接入当前的 DeepSeek Harness 部署
# 用法：bash install.sh [--home <DSH用户主目录>]
set -e
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HOME_DIR:-$HOME}"

echo "==> dsh-channel-im 安装到 $HOME_DIR"
DEST="$HOME_DIR/.dsh-channel-im"
mkdir -p "$DEST" "$HOME_DIR/.dsh/skills"

# 1) 拷贝桥接与登录助手
cp "$SRC_DIR/server.mjs" "$SRC_DIR/auth.mjs" "$DEST/"
# 2) 安装依赖（stream SDK；dws 为外部 CLI，需自行安装）
( cd "$DEST" && [ -f package.json ] || cp "$SRC_DIR/package.json" . ; npm install --no-audit --no-fund >/dev/null 2>&1 || true )
# 3) 安装技能（项目技能目录 + 用户技能目录，双保险）
cp "$SRC_DIR/skills/harness-docs-update.md" "$HOME_DIR/.dsh/skills/harness-docs.md" 2>/dev/null || true
mkdir -p "$HOME_DIR/.dsh/.agent-presets/robot-assistant"
cp "$SRC_DIR/presets/robot-assistant/preset.yml" "$SRC_DIR/presets/robot-assistant/agent.cordis.yml" "$HOME_DIR/.dsh/.agent-presets/robot-assistant/" 2>/dev/null && echo "   预设: robot-assistant 已安装" || true
cp "$SRC_DIR/skills/im-channel-setup.md" "$HOME_DIR/.dsh/skills/im-channel-setup.md" || true
# 3.5) 「连接」设置页注入（找到 DSH 安装的 ui-settings-general bundle 则打补丁）
# 提示：源码构建版（pnpm workspace）下 node_modules 是软链，打补丁会污染源码——请用官方 npm 安装版或跳过补丁
SETTINGS_BUNDLE="${DSH_SETTINGS_BUNDLE:-}"
if [ -z "$SETTINGS_BUNDLE" ]; then
  for cand in "$(pwd)/../node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js" "$HOME/DeepSeek/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js" "$(pwd)/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js"; do
    [ -f "$cand" ] && SETTINGS_BUNDLE="$cand" && break
  done
fi
if [ -n "$SETTINGS_BUNDLE" ] && [ -f "$SETTINGS_BUNDLE" ]; then
  node "$SRC_DIR/client/patch-settings.mjs" "$SETTINGS_BUNDLE" || echo "（连接页补丁失败，详见 README）"
else
  echo "（未找到 DSH 的 ui-settings-general bundle，跳过「连接」页补丁；可设 DSH_SETTINGS_BUNDLE 指定）"
fi
CONV_BUNDLE="${DSH_CONVERSATION_BUNDLE:-}"
if [ -z "$CONV_BUNDLE" ]; then
  for cand in "$(dirname "$SETTINGS_BUNDLE" 2>/dev/null)/../dsh-client-ui-conversation/lib/client.js" "$HOME/DeepSeek/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"; do
    [ -f "$cand" ] && CONV_BUNDLE="$cand" && break
  done
fi
if [ -n "$CONV_BUNDLE" ] && [ -f "$CONV_BUNDLE" ]; then
  node "$SRC_DIR/client/patch-conversation.mjs" "$CONV_BUNDLE" || echo "（外部打开补丁失败，详见 README）"
else
  echo "（未找到 DSH 的 ui-conversation bundle，跳过「外部打开」补丁）"
fi

cat <<'EOF'

✅ dsh-channel-im 已安装。
下一步：
  1) 安装 dws CLI（真人模式需要）—— 从 Releases 选**你平台**的资产：
       https://gitee.com/dingtalk-real-ai/dingtalk-workspace-cli/releases （如 dws-darwin-arm64 / dws-linux-amd64）
     curl -fsSL -o /tmp/dws.tar.gz "<对应资产URL>" && tar xzf /tmp/dws.tar.gz -C "$HOME/.local/bin" ./dws && chmod +x "$HOME/.local/bin/dws"
  2) 在 open-dev.dingtalk.com 开启「CLI 管理 → 允许成员通过 CLI 访问个人数据」，并把账号加入「CLI 授权人员名单」（一次性）
  3) 启动桥接：
       cd ~/.dsh-channel-im && node server.mjs        # 管理API http://127.0.0.1:5175
  4) 接入机器人（机器人模式给 AppKey/Secret；真人模式跑 node auth.mjs login 给用户扫码）
EOF
