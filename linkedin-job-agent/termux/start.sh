#!/data/data/com.termux/files/usr/bin/bash
# Starts the agent in the background (kept alive by supervise.sh) and opens the dashboard.
# Pass --no-open to start without opening the browser (used at phone boot).
cd "$HOME/Ai-apps/linkedin-job-agent" || exit 1
mkdir -p data
rm -f data/stopped
termux-wake-lock 2>/dev/null || true   # keep the CPU awake while the screen is off
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
TOKEN=$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)
INSTALLED=$(git rev-parse --short HEAD 2>/dev/null)
RUNNING=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/status" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
if [ -n "$RUNNING" ] && [ "$RUNNING" != "$INSTALLED" ]; then
  echo "Restarting the agent to load the new version ($INSTALLED)…"
  pkill -f "dist/cli.js serve"   # the supervisor starts the new version
  sleep 2
fi
if ! pgrep -f "termux/supervise.sh" > /dev/null; then
  pkill -f "dist/cli.js serve" 2>/dev/null   # an old unsupervised copy, if any
  nohup bash termux/supervise.sh > /dev/null 2>&1 &
fi
for _ in $(seq 1 15); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done
URL="http://127.0.0.1:$PORT/#token=$TOKEN"
if [ "$1" != "--no-open" ]; then
  termux-open-url "$URL" 2>/dev/null || echo "Open in your browser: $URL"
fi
echo "Agent is running in the background. You can close the browser."
