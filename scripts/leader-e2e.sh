#!/usr/bin/env bash
# e2e: hardened baselines + incumbent fleet import.
cd /home/user/Ai-apps
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
R=/tmp/leader-result.txt; : > "$R"
rm -rf server-state src/Ltsc.Server/server-state
dotnet run --project src/Ltsc.Server -c Release --no-build > /tmp/leader-server.log 2>&1 &
SV=$!
for i in $(seq 1 60); do grep -q "Application started" /tmp/leader-server.log 2>/dev/null && break; sleep 1; done
B=https://localhost:8443; A='Authorization: Bearer admin-token'

echo "baselines=$(curl -sk -H "$A" $B/api/baselines | python3 -c 'import sys,json;print([b["id"] for b in json.load(sys.stdin)])')" >> "$R"
echo "apply_kiosk=$(curl -sk -X POST -H "$A" $B/api/groups/group-kiosk/baseline/kiosk-hardened)" >> "$R"

# Import a Dell WMS export (dry run, then apply)
cat > /tmp/wms-export.json <<'JSON'
{ "groups": [
  { "name": "Reception", "uwf": true, "shell": "C:\\Kiosk\\reception.exe",
    "registry": [ {"path":"Software\\Contoso","name":"Site","type":"sz","data":"HQ"} ],
    "apps": [ {"appId":"com.contoso.signage","version":"4.1","installCmd":"msiexec /i signage.msi /qn"} ] },
  { "name": "Warehouse", "uwf": true,
    "registry": [ {"path":"Software\\Contoso","name":"Site","type":"sz","data":"WH1"} ] } ] }
JSON
echo "import_dryrun=$(curl -sk -X POST -H "$A" --data-binary @/tmp/wms-export.json $B/api/import/wms)" >> "$R"
echo "import_apply=$(curl -sk -X POST -H "$A" --data-binary @/tmp/wms-export.json "$B/api/import/wms?apply=true")" >> "$R"
echo "imported_policy=$(curl -sk -H "$A" $B/api/groups/Reception/policy | head -c 160)" >> "$R"
echo "imported_apps=$(curl -sk -H "$A" $B/api/apps)" >> "$R"

# IGEL export maps dotted params + reports unmapped ones
cat > /tmp/igel-export.json <<'JSON'
{ "profiles": [ { "name": "Lab-A", "parameters": {
  "uwf.enabled": "true", "desktop.shell": "C:\\Lab\\shell.exe",
  "registry.Software\\Lab!Room": "B12", "audio.volume": "70" } } ] }
JSON
echo "import_igel=$(curl -sk -X POST -H "$A" --data-binary @/tmp/igel-export.json $B/api/import/igel)" >> "$R"

kill "$SV" 2>/dev/null
echo DONE >> "$R"
