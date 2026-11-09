#!/data/data/com.termux/files/usr/bin/bash
# Health check: copy everything it prints and send it when asking for help.
cd "$HOME/Ai-apps/linkedin-job-agent" || { echo "❌ Agent not installed — run setup.sh first"; exit 1; }
echo "version: $(git log -1 --format='%h %cd' --date=short 2>/dev/null)"
if ! node --version > /dev/null 2>&1; then
  echo "❌ Node.js is broken (usually after a partial Termux update). Fix: pkg upgrade -y"
  echo "   If it still fails: pkg install -y --reinstall libicu nodejs-lts"
  exit 1
fi
node dist/cli.js doctor
