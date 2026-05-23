#!/bin/bash
# Nightly sync: telegram_main → telegram_codex_test
#
# Keeps the Codex A/B test group's snapshot context (memory, commitments,
# conversations, etc.) in sync with the main group so the two agents are
# comparing apples to apples. One-way; the Codex group's own state never
# flows back.
#
# Excludes:
#   - CLAUDE.md          → intentional fork (codex group has A/B footer)
#   - logs/              → per-group container logs
#   - attachments/       → binary voice notes; not referenced cross-group
#   - .DS_Store          → macOS detritus
#
# Wired up via ~/Library/LaunchAgents/com.nanoclaw.codex-sync.plist
# (fires daily at 03:00 PT). Logs to data/logs/codex-sync.log.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/groups/telegram_main"
DST="$REPO_ROOT/groups/telegram_codex_test"
LOG="$REPO_ROOT/data/logs/codex-sync.log"

mkdir -p "$(dirname "$LOG")"

{
  echo "----- $(date '+%Y-%m-%d %H:%M:%S %Z') -----"
  if [ ! -d "$SRC" ] || [ ! -d "$DST" ]; then
    echo "ERROR: source or destination missing ($SRC, $DST)"
    exit 1
  fi
  # Additive sync (no --delete): copies new/changed files, leaves dest-only
  # files (CLAUDE.md footer, codex-side logs, etc.) untouched.
  rsync -av \
    --exclude=CLAUDE.md \
    --exclude=logs/ \
    --exclude=attachments/ \
    --exclude=.DS_Store \
    "$SRC/" "$DST/"
  echo "Sync complete."
} >> "$LOG" 2>&1
