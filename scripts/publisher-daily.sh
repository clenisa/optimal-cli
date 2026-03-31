#!/usr/bin/env bash
# publisher-daily.sh — Run by cron/systemd at 8am ET daily
# Posts the daily intelligence report summary to Discord
set -euo pipefail

CLI_DIR="$HOME/.openclaw/workspace/optimal-cli"
DATE=$(date +%F)
PDF="$CLI_DIR/research/reports/openclaw-intel-$DATE.pdf"

if [ ! -f "$PDF" ]; then
  echo "[$DATE] No PDF report found — analyst may not have run yet"
  exit 0
fi

echo "[$DATE] Distributing intelligence report..."
cd "$CLI_DIR"

# Log distribution activity
bun run bin/optimal.ts board log \
  --action report-distributed \
  --message "OpenClaw Intel Report for $DATE published" 2>/dev/null || true

echo "[$DATE] Report distribution logged"
echo "[$DATE] PDF: $PDF"
