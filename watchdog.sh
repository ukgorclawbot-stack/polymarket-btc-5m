#!/bin/bash
# Watchdog for scalping strategy - checks every 5 min via cron
# Restarts if PID is dead

export PATH="/opt/homebrew/bin:$PATH"

PROJECT_DIR="/Users/ukgorclawbot/Desktop/polymarket-btc-5m"
LOG_FILE="$PROJECT_DIR/watchdog.log"
PID_FILE="$PROJECT_DIR/.scalp_pid"

cd "$PROJECT_DIR" || exit 1

# Check if a scalp process is running
RUNNING_PID=$(pgrep -f "index.mjs scalp" | head -1)

if [ -n "$RUNNING_PID" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ✅ Scalp running (PID $RUNNING_PID)" >> "$LOG_FILE"
  echo "$RUNNING_PID" > "$PID_FILE"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠️ Scalp not found, restarting..." >> "$LOG_FILE"
  nohup node index.mjs scalp 1 >> "$PROJECT_DIR/scalp.log" 2>&1 &
  NEW_PID=$!
  echo "$NEW_PID" > "$PID_FILE"
  echo "$(date '+%Y-%m-%d %H:%M:%S') 🔄 Restarted with PID $NEW_PID" >> "$LOG_FILE"
fi
