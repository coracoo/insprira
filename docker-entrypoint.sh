#!/bin/sh
# 容器 entrypoint：把容器内 HOME 重定向到 /data/agent-home，
# 让 CLI 的 session 跟 data 卷走（迁移即带走）；
# 凭证和配置从宿主 /seed/（readonly）同步过来。
set -e

AGENT_HOME=/data/agent-home
mkdir -p "$AGENT_HOME"

# —— Claude Code ——
mkdir -p "$AGENT_HOME/.claude"
[ -f /seed/claude.json ] && cp /seed/claude.json "$AGENT_HOME/.claude.json"
[ -f /seed/claude-settings.json ] && cp /seed/claude-settings.json "$AGENT_HOME/.claude/settings.json"
# sessions/projects/cache 等容器内自己写，不同步

# —— Codex ——
mkdir -p "$AGENT_HOME/.codex"
[ -f /seed/codex-auth.json ] && cp /seed/codex-auth.json "$AGENT_HOME/.codex/auth.json"
[ -f /seed/codex-config.toml ] && cp /seed/codex-config.toml "$AGENT_HOME/.codex/config.toml"

# —— Kimi ——
mkdir -p "$AGENT_HOME/.kimi-code/credentials" "$AGENT_HOME/.kimi-code/oauth"
if [ -d /seed/kimi-credentials ]; then
  cp -r /seed/kimi-credentials/. "$AGENT_HOME/.kimi-code/credentials/" 2>/dev/null || true
fi
[ -f /seed/kimi-config.toml ] && cp /seed/kimi-config.toml "$AGENT_HOME/.kimi-code/config.toml"

export HOME="$AGENT_HOME"
echo "[entrypoint] HOME=$HOME, agent 凭证已同步"

exec "$@"
