#!/usr/bin/env bash
# End-to-end smoke for CI: starts the server (against Postgres + Redis via the
# Ltsc__Postgres / Ltsc__Redis env vars) and an agent over mTLS, then asserts the
# core flow. A successful enroll proves Postgres connectivity; RedisPresence on
# connect proves Redis. Exits non-zero on any failed assertion.
set -uo pipefail
cd "$(dirname "$0")/.."

export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
SLOG=/tmp/ci-server.log
ALOG=/tmp/ci-agent.log
fail=0

assert() { # <file> <pattern> <message>
  if grep -qE "$2" "$1"; then echo "PASS: $3"; else echo "FAIL: $3"; fail=1; fi
}

echo "Starting server..."
dotnet run --project src/Ltsc.Server -c Release --no-build > "$SLOG" 2>&1 &
SV=$!
for i in $(seq 1 60); do grep -q "Application started" "$SLOG" && break; sleep 1; done
grep -q "Application started" "$SLOG" || { echo "FAIL: server did not start"; cat "$SLOG"; exit 1; }

echo "Running agent..."
timeout 20 dotnet run --project src/Ltsc.Agent -c Release --no-build > "$ALOG" 2>&1 &
for i in $(seq 1 40); do grep -q "connected" "$SLOG" && break; sleep 1; done
sleep 6

echo "--- assertions ---"
assert "$SLOG" "Enrolled device"                         "device enrolls (proves Postgres write)"
assert "$SLOG" "GetPolicy .* version="                   "policy served"
assert "$SLOG" "Reconciled 100%"                          "config reconcile completes"
assert "$SLOG" "RESULT status=Succeeded"                  "a command/policy succeeded"

# RBAC + tenant scoping over the API (self-signed cert -> -k).
B=https://localhost:8443
code_admin=$(curl -sk -o /tmp/dev.json -w "%{http_code}" -H "Authorization: Bearer admin-token" $B/api/devices)
code_noauth=$(curl -sk -o /dev/null -w "%{http_code}" $B/api/devices)
[ "$code_admin" = "200" ] && echo "PASS: admin lists devices (200)" || { echo "FAIL: admin devices = $code_admin"; fail=1; }
[ "$code_noauth" = "401" ] && echo "PASS: no-token rejected (401)" || { echo "FAIL: no-token = $code_noauth"; fail=1; }
grep -q "tenant-a" /tmp/dev.json && echo "PASS: device scoped to tenant-a" || { echo "FAIL: tenant missing"; fail=1; }

kill $SV 2>/dev/null
wait $SV 2>/dev/null

if [ "$fail" -ne 0 ]; then
  echo "=== server log tail ==="; tail -40 "$SLOG"
  echo "INTEGRATION FAILED"; exit 1
fi
echo "INTEGRATION PASSED"
