#!/usr/bin/env bash
# Fresh-install check + 500-device load test.
cd /home/user/Ai-apps
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
export Ltsc__DemoInstall=false          # measure the control plane, not demo installs
R=/tmp/load-result.txt; : > "$R"

rm -rf server-state src/Ltsc.Server/server-state

dotnet run --project src/Ltsc.Server -c Release --no-build > /tmp/load-server.log 2>&1 &
SV=$!
for i in $(seq 1 60); do
  grep -qE "Application started|Unhandled" /tmp/load-server.log 2>/dev/null && break
  sleep 1
done

if grep -q "Application started" /tmp/load-server.log; then
  echo "fresh-install start: OK (no pre-existing state dir)" >> "$R"
else
  echo "fresh-install start: FAILED" >> "$R"; tail -5 /tmp/load-server.log >> "$R"
  echo DONE >> "$R"; exit 1
fi

dotnet run --project tools/Ltsc.LoadTest -c Release --no-build -- \
  --devices 500 --duration 25 --concurrency 64 >> "$R" 2>&1

echo "--- server-side metrics (/metrics) ---" >> "$R"
curl -sk https://localhost:8443/metrics 2>/dev/null \
  | grep -E "^ltsc_(devices_total|devices_online|enrollments_total|heartbeats_total|policy_pulls_total|device_connects_total)" >> "$R"
echo "--- probes ---" >> "$R"
echo "healthz=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:8443/healthz)" >> "$R"
echo "readyz=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:8443/readyz)" >> "$R"
echo "--- server memory ---" >> "$R"
ps -o rss= -p "$SV" 2>/dev/null | awk '{printf "server RSS: %.0f MB\n", $1/1024}' >> "$R"

kill "$SV" 2>/dev/null
echo DONE >> "$R"
