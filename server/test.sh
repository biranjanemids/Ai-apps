#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Multi-Model API — Test Suite
#  Usage: bash test.sh [SERVER_URL]
#  Default SERVER_URL: http://localhost:3000
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

BASE="${1:-http://localhost:3000}"
PASS=0
FAIL=0

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { echo -e "${GREEN}  ✔  PASS${RESET}  $1"; ((PASS++)); }
fail() { echo -e "${RED}  ✖  FAIL${RESET}  $1"; echo -e "       ${RED}$2${RESET}"; ((FAIL++)); }
section() { echo -e "\n${CYAN}${BOLD}── $1 ──${RESET}"; }

# ── Wait for server ────────────────────────────────────────────────────────────
echo -e "${BOLD}Waiting for server at ${BASE}...${RESET}"
for i in $(seq 1 30); do
  if curl -sf "${BASE}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}Server is up.${RESET}\n"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}Server did not start within 30 seconds. Aborting.${RESET}"
    exit 1
  fi
  sleep 1
done

# ── Helper ────────────────────────────────────────────────────────────────────
req() {
  # req <method> <path> [body] [expected_status]
  local method="$1" path="$2" body="${3:-}" expected="${4:-200}"
  if [ -n "$body" ]; then
    curl -s -w "\n%{http_code}" -X "$method" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${BASE}${path}" 2>&1 || true
  else
    curl -s -w "\n%{http_code}" -X "$method" "${BASE}${path}" 2>&1 || true
  fi
}

assert_status() {
  local name="$1" response="$2" expected="${3:-200}"
  local status
  status=$(echo "$response" | tail -1)
  if [ "$status" = "$expected" ]; then
    pass "$name (HTTP $status)"
  else
    fail "$name" "Expected HTTP $expected, got $status"
  fi
}

assert_json_field() {
  local name="$1" response="$2" field="$3" expected="$4"
  local body status value
  body=$(echo "$response" | head -n -1)
  value=$(echo "$body" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*: *"\(.*\)"/\1/' || echo "")
  if [ "$value" = "$expected" ]; then
    pass "$name (${field}=\"${value}\")"
  else
    fail "$name" "Expected ${field}=\"${expected}\", got \"${value}\""
  fi
}

assert_contains() {
  local name="$1" response="$2" needle="$3"
  local body
  body=$(echo "$response" | head -n -1)
  if echo "$body" | grep -q "$needle"; then
    pass "$name"
  else
    fail "$name" "Expected response to contain: ${needle}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
section "Health Checks"
# ─────────────────────────────────────────────────────────────────────────────

R=$(req GET /health)
assert_status "GET /health returns 200"      "$R" 200
assert_json_field "GET /health status=ok"    "$R" status ok

R=$(req GET /readyz)
assert_status "GET /readyz returns 200 or 503" "$R" "$(echo "$R" | tail -1)"
assert_contains "GET /readyz returns JSON"   "$R" "providers"
assert_contains "GET /readyz mock=true"      "$R" '"mock"'

# ─────────────────────────────────────────────────────────────────────────────
section "Model Registry"
# ─────────────────────────────────────────────────────────────────────────────

R=$(req GET /v1/models)
assert_status   "GET /v1/models returns 200"        "$R" 200
assert_contains "GET /v1/models has object=list"    "$R" '"object":"list"'
assert_contains "GET /v1/models includes mock/echo" "$R" 'mock/echo'

# ─────────────────────────────────────────────────────────────────────────────
section "Chat Completions — Non-Streaming (mock/echo)"
# ─────────────────────────────────────────────────────────────────────────────

BODY='{"model":"mock/echo","messages":[{"role":"user","content":"hello world"}]}'
R=$(req POST /v1/chat/completions "$BODY")
assert_status   "POST /v1/chat/completions (mock, non-stream) 200"  "$R" 200
assert_contains "Response has object=chat.completion"               "$R" 'chat.completion'
assert_contains "Response has choices array"                        "$R" '"choices"'
assert_contains "Response echoes input"                             "$R" 'hello world'
assert_contains "Response has usage"                                "$R" '"usage"'

# ─────────────────────────────────────────────────────────────────────────────
section "Chat Completions — Streaming (mock/echo)"
# ─────────────────────────────────────────────────────────────────────────────

BODY='{"model":"mock/echo","messages":[{"role":"user","content":"stream test"}],"stream":true}'
STREAM=$(curl -sf -N -X POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${BASE}/v1/chat/completions" 2>&1 || true)

if echo "$STREAM" | grep -q "^data:"; then
  pass "POST /v1/chat/completions (mock, stream) returns SSE chunks"
else
  fail "POST /v1/chat/completions (mock, stream)" "No SSE data: lines found"
fi

if echo "$STREAM" | grep -q "data: \[DONE\]"; then
  pass "Streaming ends with [DONE]"
else
  fail "Streaming ends with [DONE]" "Missing 'data: [DONE]' terminator"
fi

if echo "$STREAM" | grep -q '"delta"'; then
  pass "SSE chunks contain delta objects"
else
  fail "SSE chunks contain delta objects" "No delta found in stream chunks"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Error Handling"
# ─────────────────────────────────────────────────────────────────────────────

# Unknown model → 404
R=$(req POST /v1/chat/completions '{"model":"nonexistent/model","messages":[{"role":"user","content":"hi"}]}')
STATUS=$(echo "$R" | tail -1)
if [ "$STATUS" = "404" ]; then
  pass "Unknown model returns 404"
else
  fail "Unknown model returns 404" "Got HTTP $STATUS"
fi
assert_contains "404 response has error object" "$R" '"error"'

# Missing messages → 400
R=$(req POST /v1/chat/completions '{"model":"mock/echo"}')
STATUS=$(echo "$R" | tail -1)
if [ "$STATUS" = "400" ]; then
  pass "Missing messages field returns 400"
else
  fail "Missing messages field returns 400" "Got HTTP $STATUS"
fi

# Empty messages → 400
R=$(req POST /v1/chat/completions '{"model":"mock/echo","messages":[]}')
STATUS=$(echo "$R" | tail -1)
if [ "$STATUS" = "400" ]; then
  pass "Empty messages array returns 400"
else
  fail "Empty messages array returns 400" "Got HTTP $STATUS"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "CORS Headers"
# ─────────────────────────────────────────────────────────────────────────────

HEADERS=$(curl -sI -X OPTIONS "${BASE}/v1/chat/completions" \
  -H "Origin: http://localhost:4000" \
  -H "Access-Control-Request-Method: POST" 2>&1 || true)

if echo "$HEADERS" | grep -qi "access-control-allow"; then
  pass "CORS preflight returns allow headers"
else
  fail "CORS preflight" "Missing Access-Control-Allow headers"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "Summary"
# ─────────────────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${RESET} / ${RED}${FAIL} failed${RESET} / ${TOTAL} total"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
