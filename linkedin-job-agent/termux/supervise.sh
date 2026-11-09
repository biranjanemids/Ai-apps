#!/data/data/com.termux/files/usr/bin/bash
# Keeps the agent running: if Android kills it, start it again (unless you stopped it).
# If it keeps failing straight away (e.g. Node.js broken by a partial update), wait longer.
cd "$HOME/Ai-apps/linkedin-job-agent" || exit 1
fails=0
while true; do
  started=$(date +%s)
  node dist/cli.js serve >> data/agent.log 2>&1
  [ -f data/stopped ] && break
  if [ $(( $(date +%s) - started )) -lt 20 ]; then fails=$((fails + 1)); else fails=0; fi
  wait=5
  [ $fails -ge 3 ] && wait=300
  if [ $fails -eq 3 ]; then
    echo "[$(date +%H:%M:%S)] Agent keeps failing at start — retrying every 5 min. Run: bash termux/check.sh" >> data/agent.log
  elif [ $fails -lt 3 ]; then
    echo "[$(date +%H:%M:%S)] Agent exited — restarting in ${wait} s" >> data/agent.log
  fi
  sleep $wait
done
