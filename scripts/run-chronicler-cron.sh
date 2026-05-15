#!/bin/bash
# Cron wrapper for daily chronicler — runs at 10:30pm each night.
# Crontab entry: 30 22 * * * bash /home/brantley/alreadydone/scripts/run-chronicler-cron.sh
# Logs to /srv/media2/logs/alreadydone/chronicler.log

export PATH="/home/brantley/.nvm/versions/node/v24.13.0/bin:$PATH"

LOG="/srv/media2/logs/alreadydone/chronicler.log"
echo "" >> "$LOG"
echo "═══════════════════════════════════" >> "$LOG"
echo "Chronicler started: $(date)" >> "$LOG"

cd /home/brantley/alreadydone && node scripts/run-chronicler.js >> "$LOG" 2>&1

echo "Chronicler ended: $(date)" >> "$LOG"
