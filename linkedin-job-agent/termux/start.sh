#!/data/data/com.termux/files/usr/bin/bash
# Starts the agent in the background and opens the dashboard in your phone's browser.
cd "$HOME/Ai-apps/linkedin-job-agent" || exit 1
mkdir -p data
termux-wake-lock 2>/dev/null || true   # keep running while the screen is off
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
TOKEN=$(grep -E '^DASHBOARD_TOKEN=' .env | cut -d= -f2)
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  nohup node dist/cli.js serve >> data/agent.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  done
fi
URL="http://127.0.0.1:$PORT/#token=$TOKEN"
termux-open-url "$URL" 2>/dev/null || echo "Open in your browser: $URL"
