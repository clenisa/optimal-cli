#!/bin/bash
# Install systemd timers for persistent cron triggers.
# Replaces OpenClaw session-based crons that expire after 7 days.
#
# Usage: sudo bash infra/setup-timers.sh [--uninstall]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

UNITS=(
  optimal-backup
  optimal-update
  optimal-iteration
  optimal-auto-claim
  optimal-coordinator
)

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Stopping and disabling timers..."
  for unit in "${UNITS[@]}"; do
    systemctl stop "${unit}.timer" 2>/dev/null || true
    systemctl disable "${unit}.timer" 2>/dev/null || true
    rm -f "${SYSTEMD_DIR}/${unit}.service" "${SYSTEMD_DIR}/${unit}.timer"
    echo "  removed ${unit}"
  done
  systemctl daemon-reload
  echo "All optimal timers removed."
  exit 0
fi

echo "Installing systemd timers from ${SCRIPT_DIR}..."

for unit in "${UNITS[@]}"; do
  cp "${SCRIPT_DIR}/${unit}.service" "${SYSTEMD_DIR}/"
  cp "${SCRIPT_DIR}/${unit}.timer"   "${SYSTEMD_DIR}/"
  echo "  installed ${unit}.{service,timer}"
done

systemctl daemon-reload

for unit in "${UNITS[@]}"; do
  systemctl enable "${unit}.timer"
  systemctl start "${unit}.timer"
  echo "  enabled ${unit}.timer"
done

echo ""
echo "All timers installed and active:"
systemctl list-timers --no-pager | grep optimal || true
