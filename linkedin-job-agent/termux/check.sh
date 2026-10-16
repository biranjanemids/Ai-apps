#!/data/data/com.termux/files/usr/bin/bash
# Health check: copy everything it prints and send it when asking for help.
cd "$HOME/Ai-apps/linkedin-job-agent" || { echo "❌ Agent not installed — run setup.sh first"; exit 1; }
echo "version: $(git log -1 --format='%h %cd' --date=short 2>/dev/null)"
node dist/cli.js doctor
