#!/usr/bin/env bash
# Cron wrapper for the research pipeline.
# Sends Slack notifications on start, end, and daily stats.

set -euo pipefail

# nvm puts node outside cron's default PATH
export PATH="/home/brantley/.nvm/versions/node/v24.13.0/bin:$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$DIR/logs/pipeline.log"
TMPOUT="$(mktemp)"

# Load .env
set -o allexport
# shellcheck source=/dev/null
source "$DIR/.env" || true
set +o allexport

DATE="$(date '+%Y-%m-%d')"
TIME_START="$(date '+%H:%M')"

# ── Slack helper ─────────────────────────────────────────────────────────────
slack() {
  local webhook="$1"
  local payload="$2"
  if [[ -z "${webhook:-}" ]]; then return 0; fi
  curl -s -o /dev/null -X POST -H 'Content-type: application/json' \
    --data "$payload" "$webhook"
}

# ── Start notification ────────────────────────────────────────────────────────
slack "${SLACK_PIPELINE:-}" "{\"text\":\"🚀 *Pipeline started* — ${DATE} at ${TIME_START}\"}"

echo "" >> "$LOG"
echo "=== Run started: ${DATE} ${TIME_START} ===" >> "$LOG"

# ── Run agents ───────────────────────────────────────────────────────────────
cd "$DIR"

# Check for replies (fast, no-op if IMAP not configured)
node scripts/run-reply-monitor.js >> "$LOG" 2>&1 || true

# Follow-ups + timeouts
node scripts/run-follow-up.js >> "$LOG" 2>&1 || true

# Research pipeline
node scripts/run-pipeline.js 2>&1 | tee -a "$TMPOUT" >> "$LOG"
EXIT_CODE=${PIPESTATUS[0]}

# Build 1 preview site for the next unbuilt lead
node scripts/run-site-builder.js >> "$LOG" 2>&1 || true

TIME_END="$(date '+%H:%M')"

# ── Parse pipeline stats ──────────────────────────────────────────────────────
LAST_ROUND="$(grep '^\[Round' "$TMPOUT" | tail -1)"
API_CALLS="$(echo "$LAST_ROUND" | grep -oP '\d+(?=/\d+ API calls today)' || echo '0')"
PROSPECTS="$(echo "$LAST_ROUND" | grep -oP '\d+(?= prospects)' || echo '0')"
ROUNDS="$(echo "$LAST_ROUND" | grep -oP '(?<=\[Round )\d+' || echo '0')"

if grep -q 'Daily API limit reached' "$TMPOUT"; then
  STOP_REASON="Daily limit reached"
elif grep -q 'fully scanned' "$TMPOUT"; then
  STOP_REASON="Area fully scanned"
elif grep -q 'All areas in expansion order' "$TMPOUT"; then
  STOP_REASON="All areas complete"
elif grep -q 'Queue exhausted' "$TMPOUT"; then
  STOP_REASON="Queue exhausted"
elif [[ $EXIT_CODE -ne 0 ]]; then
  STOP_REASON="Crashed (exit $EXIT_CODE)"
  slack "${SLACK_DM:-}" "{\"text\":\"⚠️ Pipeline crashed on ${DATE} at ${TIME_END} (exit code ${EXIT_CODE}). Check logs/pipeline.log\"}"
else
  STOP_REASON="Stopped"
fi

echo "=== Run ended: ${TIME_END} | Rounds: ${ROUNDS} | API calls: ${API_CALLS} | Prospects: ${PROSPECTS} | ${STOP_REASON} ===" >> "$LOG"

# ── Daily stats from DB ───────────────────────────────────────────────────────
DB_STATS="$(node "$DIR/scripts/daily-stats.js" "$DATE" 2>/dev/null || echo '(stats unavailable)')"

# ── End notification ──────────────────────────────────────────────────────────
slack "${SLACK_PIPELINE:-}" "$(cat <<JSON
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "✅ Pipeline complete — ${DATE}" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Run time:*\n${TIME_START}–${TIME_END}" },
        { "type": "mrkdwn", "text": "*Rounds:*\n${ROUNDS}" },
        { "type": "mrkdwn", "text": "*API calls:*\n${API_CALLS}/200" },
        { "type": "mrkdwn", "text": "*Stop reason:*\n${STOP_REASON}" }
      ]
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "📊 *Stats*\n\`\`\`${DB_STATS}\`\`\`" }
    }
  ]
}
JSON
)"

rm -f "$TMPOUT"
