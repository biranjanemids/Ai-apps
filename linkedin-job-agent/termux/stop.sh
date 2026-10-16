#!/data/data/com.termux/files/usr/bin/bash
pkill -f "dist/cli.js serve" && echo "Job agent stopped." || echo "Job agent wasn't running."
termux-wake-unlock 2>/dev/null || true
