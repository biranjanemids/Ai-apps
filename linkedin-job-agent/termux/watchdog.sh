#!/data/data/com.termux/files/usr/bin/bash
# Run by Android's job scheduler every 15 minutes (set up by start.sh, needs the Termux:API app).
# If Android closed Termux and the agent with it, start it again — unless you stopped it.
cd "$HOME/Ai-apps/linkedin-job-agent" || exit 0
[ -f data/stopped ] && exit 0
pgrep -f "termux/supervise.sh" > /dev/null && exit 0
echo "[$(date +%H:%M:%S)] Watchdog: Android had closed the agent — starting it again" >> data/agent.log
bash termux/start.sh --no-open > /dev/null 2>&1
