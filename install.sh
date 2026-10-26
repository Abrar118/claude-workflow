#!/bin/sh
# Installs this whole setup: my mods and skill, the third-party plugins I use,
# the status line and (if you have none yet) my CLAUDE.md.
# Run from a clone of this repo:  ./install.sh
set -e
cd "$(dirname "$0")"
CLAUDE_DIR="$HOME/.claude"

command -v claude >/dev/null || { echo "Claude Code CLI not found: https://claude.com/claude-code"; exit 1; }

echo "== Marketplaces"
claude plugin marketplace add Abrar118/claude-workflow || true
claude plugin marketplace add anthropics/claude-plugins-official || true
claude plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill || true

echo "== My mods and skill"
for p in agent-panel assumption-log prompt-deck prompt-queue turn-meter limit-guard \
         safety-guard push-preflight format-on-edit venv-auto debug-on-paste verify-outside-feedback; do
  claude plugin install "$p@claude-workflow" -s user || echo "  ! $p failed"
done

echo "== Third-party plugins"
for p in superpowers frontend-design security-guidance claude-md-management \
         claude-code-setup remember github; do
  claude plugin install "$p@claude-plugins-official" -s user || echo "  ! $p failed"
done
claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill -s user || echo "  ! ui-ux-pro-max failed"

echo "== Uncodixfy skill"
if [ ! -d "$CLAUDE_DIR/skills/uncodixfy" ]; then
  mkdir -p "$CLAUDE_DIR/skills"
  git clone --depth 1 https://github.com/cyxzdev/Uncodixfy.git "$CLAUDE_DIR/skills/uncodixfy"
else
  echo "  already there"
fi

echo "== Status line"
if [ -f "$CLAUDE_DIR/statusline-command.sh" ]; then
  cp "$CLAUDE_DIR/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh.bak"
  echo "  backed up your old one to statusline-command.sh.bak"
fi
cp statusline/statusline-command.sh "$CLAUDE_DIR/statusline-command.sh"
echo "  add the statusLine block from settings.example.json to ~/.claude/settings.json (needs jq; gh for the PR badge)"

echo "== CLAUDE.md"
if [ -f "$CLAUDE_DIR/CLAUDE.md" ]; then
  cp CLAUDE.md "$CLAUDE_DIR/CLAUDE.workflow.md"
  echo "  you already have a CLAUDE.md, so mine is at ~/.claude/CLAUDE.workflow.md to merge by hand"
else
  cp CLAUDE.md "$CLAUDE_DIR/CLAUDE.md"
fi

echo "Done. Restart Claude Code."
