#!/usr/bin/env bash
# Brings up the full local stack for a real conversation.
#
#   docker: postgres · redis · minio · livekit
#   source: control-plane (:3101) · orchestrator worker · dashboard (:3100)
#
# Provider keys are BYOK — add them once in the dashboard under Settings ->
# Providers, or run scripts/first-call.sh with them in the environment.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ infrastructure (postgres, redis, minio, livekit)"
docker compose up -d
echo "  waiting for health…"
docker compose ps --format '  {{.Service}}: {{.Status}}'

echo "→ control plane   (:3101)"
( cd backend/control-plane && npm run dev ) &
echo "→ dashboard        (:3100)"
( cd frontend && npm run dev ) &
echo "→ orchestrator worker"
( cd backend/orchestrator && .venv/bin/python -m src.main dev ) &

echo ""
echo "Stack up. Dashboard: http://localhost:3100"
echo "Stop with: docker compose down && pkill -f 'tsx src/main' && pkill -f 'next dev' && pkill -f 'src.main dev'"
wait
