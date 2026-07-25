#!/bin/bash
# rlm-launch.sh — wrapper for rlm-bun, safe to call from Logitech MX / Spotlight / etc.
# Opens a new Terminal window and runs rlm interactively.

# ── Load user environment ──────────────────────────────────────────────────────
# Source shell profile so PATH, API keys, etc. are available
if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc" 2>/dev/null
elif [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc" 2>/dev/null
fi

# ── Locate bun ────────────────────────────────────────────────────────────────
# Add common bun install locations to PATH
export PATH="$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# ── Project root ──────────────────────────────────────────────────────────────
# Resolve symlinks so this works whether called directly or via ~/.local/bin
REAL_SCRIPT="$(readlink -f "$0" 2>/dev/null || python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$0")"
RLM_DIR="$(cd "$(dirname "$REAL_SCRIPT")/.." && pwd)"

# ── Launch in a new Terminal window ───────────────────────────────────────────
# Opens interactive rlm prompt mode (-p -i) so you can type queries in the window
osascript <<EOF
tell application "Terminal"
  activate
  do script "cd '$RLM_DIR' && bun bin/rlm.ts -p -i"
end tell
EOF
