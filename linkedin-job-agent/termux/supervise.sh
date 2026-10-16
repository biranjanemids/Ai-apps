#!/data/data/com.termux/files/usr/bin/bash
# Keeps the agent running: if Android kills it, start it again (unless you stopped it).
cd "$HOME/Ai-apps/linkedin-job-agent" || exit 1
while true; do
  node dist/cli.js serve >> data/agent.log 2>&1
  [ -f data/stopped ] && break
  echo "[$(date +%H:%M:%S)] Agent exited — restarting in 5 s" >> data/agent.log
  sleep 5
done
