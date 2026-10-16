#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/Ai-apps/linkedin-job-agent" 2>/dev/null && touch data/stopped
pkill -f "termux/supervise.sh"
pkill -f "dist/cli.js serve" && echo "Job agent stopped." || echo "Job agent wasn't running."
termux-notification-remove job-agent-progress 2>/dev/null
termux-wake-unlock 2>/dev/null || true
