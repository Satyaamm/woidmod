#!/usr/bin/env bash
# Stores your provider keys and opens a real browser call to a fresh agent.
#
# Prereqs (all started by scripts/dev.sh):
#   - livekit-server --dev        on :7880
#   - control-plane               on :3101
#   - orchestrator worker         registered with LiveKit
#   - dashboard                   on :3100
#
# Usage:
#   DEEPGRAM_API_KEY=... ANTHROPIC_API_KEY=... CARTESIA_API_KEY=... scripts/first-call.sh
set -euo pipefail

API=${CONTROL_PLANE_URL:-http://localhost:3101}
: "${DEEPGRAM_API_KEY:?set DEEPGRAM_API_KEY}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
: "${CARTESIA_API_KEY:?set CARTESIA_API_KEY}"

email="firstcall+$(date +%s)@example.com"
echo "→ creating an account ($email)"
resp=$(curl -s -X POST "$API/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"correct-horse-battery-staple\",\"country\":\"US\"}")
tok=$(echo "$resp" | node -pe 'JSON.parse(require("fs").readFileSync(0)).session.token')
ws=$(echo "$resp"  | node -pe 'JSON.parse(require("fs").readFileSync(0)).workspace.id')
org=$(echo "$resp" | node -pe 'JSON.parse(require("fs").readFileSync(0)).organization.slug')
agent=$(echo "$resp"| node -pe 'JSON.parse(require("fs").readFileSync(0)).agent.id')
wsslug=$(echo "$resp"| node -pe 'JSON.parse(require("fs").readFileSync(0)).workspace.slug')
H=(-H "authorization: Bearer $tok" -H "x-workspace-id: $ws" -H 'content-type: application/json')

echo "→ storing your provider keys (encrypted per tenant)"
curl -s -X POST "$API/v1/provider-credentials" "${H[@]}" \
  -d "{\"kind\":\"stt\",\"providerKey\":\"deepgram-stt\",\"name\":\"Deepgram\",\"secrets\":{\"apiKey\":\"$DEEPGRAM_API_KEY\"}}" >/dev/null
curl -s -X POST "$API/v1/provider-credentials" "${H[@]}" \
  -d "{\"kind\":\"llm\",\"providerKey\":\"anthropic-llm\",\"name\":\"Anthropic\",\"secrets\":{\"apiKey\":\"$ANTHROPIC_API_KEY\"}}" >/dev/null
curl -s -X POST "$API/v1/provider-credentials" "${H[@]}" \
  -d "{\"kind\":\"tts\",\"providerKey\":\"cartesia-tts\",\"name\":\"Cartesia\",\"secrets\":{\"apiKey\":\"$CARTESIA_API_KEY\"}}" >/dev/null

echo "→ checking the worker can resolve everything it needs"
miss=$(curl -s "$API/v1/runtime/agents/$agent/credentials" "${H[@]}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).missing?.length ?? "err"')
if [ "$miss" != "0" ]; then echo "   ✗ credentials still missing — check the keys"; exit 1; fi
echo "   ✓ deepgram + anthropic + cartesia resolved"

url="http://localhost:3100/orgs/$org/$wsslug/agents/$agent/test"
echo ""
echo "Ready. Open this and press Talk:"
echo "   $url"
echo ""
echo "Your login:  $email  /  correct-horse-battery-staple"
command -v open >/dev/null && open "$url" || true
