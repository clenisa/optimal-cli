#!/usr/bin/env bash
# analyst-daily.sh — Run by cron/systemd at 6am ET daily
# Generates the OpenClaw Intelligence Report from today's research notes
set -euo pipefail

CLI_DIR="$HOME/.openclaw/workspace/optimal-cli"
DATE=$(date +%F)
NOTES="$CLI_DIR/research/notes/$DATE.md"

if [ ! -f "$NOTES" ]; then
  echo "[$DATE] No research notes found — scout may not have run yet"
  exit 0
fi

echo "[$DATE] Generating intelligence report..."
cd "$CLI_DIR"
bun run bin/optimal.ts content report generate --date "$DATE"
echo "[$DATE] Report generation complete"
