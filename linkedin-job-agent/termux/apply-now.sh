#!/data/data/com.termux/files/usr/bin/bash
# Apply to the queued jobs now, with Termux open on the screen.
# Android kills background apps that use a lot of CPU/memory (that's what keeps stopping the
# browser), but it leaves the app you're looking at alone. So this runs the agent in the
# foreground, shows every step, and prints the report at the end.
cd "$HOME/Ai-apps/linkedin-job-agent" || exit 1
termux-wake-lock 2>/dev/null || true
cat <<'TIP'
Keep Termux open on the screen until it says "Finished". Plug in the charger and turn on
Developer options → "Stay awake" so the screen doesn't turn off. Don't switch apps.
TIP
bash termux/stop.sh > /dev/null 2>&1   # only one browser at a time (the dashboard's one closes)
rm -f data/stopped
node dist/cli.js run 2>&1 | tee -a data/agent.log
echo; echo "Finished. Restarting the dashboard in the background…"
bash termux/start.sh --no-open > /dev/null 2>&1
bash termux/report.sh
