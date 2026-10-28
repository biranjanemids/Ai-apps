#!/data/data/com.termux/files/usr/bin/bash
# Stops Android from killing Termux and the agent ("[Process completed (signal 9)]").
# Android 12+ has a "phantom process killer" that kills apps running background programs.
# This turns it off using Wireless debugging, from the phone itself — no computer needed.
# Run it once. Some phones turn the killer back on after a system update; just run it again.
set -e
echo "==> Installing adb (Android's debugging tool)…"
pkg install -y android-tools > /dev/null

cat <<'STEPS'

Do this on the phone (Wi-Fi must be on):
  1. Settings → About phone → tap "Build number" 7 times (turns on Developer options).
  2. Settings → System → Developer options → "Wireless debugging" → ON → tap the words
     "Wireless debugging" to open it → "Pair device with pairing code".
  3. Keep that code on screen and switch back to Termux. Using split screen or a pop-up
     window helps: the code disappears if you leave that screen for too long.

STEPS
read -rp "Pairing PORT (the number after ':' under 'IP address & Port' in the pairing box): " PAIRPORT
read -rp "Pairing CODE (6 digits): " CODE
adb pair "localhost:$PAIRPORT" "$CODE"

echo
echo "Now close the pairing box. On the Wireless debugging screen, look at 'IP address & Port'"
read -rp "That PORT (different from the pairing port): " PORT
adb connect "localhost:$PORT"
D="localhost:$PORT"

echo "==> Turning off the phantom process killer and battery limits for Termux…"
adb -s "$D" shell "settings put global settings_enable_monitor_phantom_procs false" || true
adb -s "$D" shell "/system/bin/device_config set_sync_disabled_for_tests persistent" || true
adb -s "$D" shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647" || true
for app in com.termux com.termux.api com.termux.boot; do
  adb -s "$D" shell "dumpsys deviceidle whitelist +$app" > /dev/null 2>&1 || true
  adb -s "$D" shell "cmd appops set $app RUN_ANY_IN_BACKGROUND allow" > /dev/null 2>&1 || true
  adb -s "$D" shell "cmd appops set $app RUN_IN_BACKGROUND allow" > /dev/null 2>&1 || true
done

MON=$(adb -s "$D" shell "settings get global settings_enable_monitor_phantom_procs" | tr -d '\r')
MAX=$(adb -s "$D" shell "/system/bin/device_config get activity_manager max_phantom_processes" | tr -d '\r')
adb disconnect "$D" > /dev/null 2>&1 || true
echo
echo "phantom process monitor: $MON (want: false)   max phantom processes: $MAX (want: 2147483647)"
if [ "$MON" = "false" ] || [ "$MAX" = "2147483647" ]; then
  echo "✔ Done. Android won't kill the agent for running Chromium any more."
  echo "  You can turn Wireless debugging off again. Restart the agent: bash ~/Ai-apps/linkedin-job-agent/termux/start.sh"
  echo "phantom-off $(date +%F)" > "$HOME/Ai-apps/linkedin-job-agent/data/android-fixed"
else
  echo "✘ The settings didn't stick. Copy this output and send it for help."
fi
