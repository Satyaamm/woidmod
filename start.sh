#!/usr/bin/env bash
#
# woidmod — one-shot dev launcher.
#
#   ./start.sh                 infra + control-plane API + dashboard + orchestrator
#   ./start.sh --no-orchestrator   skip the Python worker (dashboard-only; no real calls)
#   ./start.sh --down          stop everything (docker containers + volumes stay)
#
# Ctrl+C stops the app processes it started. Docker containers keep running
# (data persists, faster next boot) — use `./start.sh --down` to stop them too.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

WITH_ORCH=1
for arg in "$@"; do
  case "$arg" in
    --no-orchestrator) WITH_ORCH=0 ;;
    --down)
      echo "→ stopping docker services…"
      docker compose down
      echo "✓ stopped. (volumes kept — 'docker compose down -v' to wipe data)"
      exit 0
      ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
info() { printf "\033[36m→ %s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓ %s\033[0m\n" "$1"; }
warn() { printf "\033[33m! %s\033[0m\n" "$1"; }

# ── preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null || { warn "docker not found — install Docker Desktop"; exit 1; }
docker info >/dev/null 2>&1 || { warn "Docker isn't running — start Docker Desktop and retry"; exit 1; }
command -v node >/dev/null   || { warn "node not found — install Node.js"; exit 1; }

# Free a port if something is squatting on it — but never touch Docker's own
# port binding (compose reuses that cleanly; killing it would break docker).
free_port() {
  local port="$1" pids pid cmd owner me
  me=$(id -un)
  pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    owner=$(ps -p "$pid" -o user= 2>/dev/null | tr -d ' ' || true)
    # Safety: only ever kill a process YOU own. System/macOS daemons run as
    # root/_system and are skipped, so we can never touch an internal service.
    if [ "$owner" != "$me" ]; then
      warn "port $port held by '$cmd' (owner $owner, not you) — leaving it alone"
      continue
    fi
    case "$cmd" in
      *docker*|*com.docker*|*vpnkit*)
        info "port $port held by docker — compose will reuse it" ;;
      *)
        warn "port $port busy ($cmd, pid $pid) — freeing it"
        kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
}

# App ports + LiveKit (7880/7881). A stale standalone livekit-server or a crashed
# dev process here is the usual cause of EADDRINUSE / "address already in use".
for port in 3100 3101 7880 7881; do free_port "$port"; done

PIDS=()
cleanup() {
  echo
  info "shutting down app processes…"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Kill whole process groups (npm/tsx/python spawn children).
  for pid in "${PIDS[@]:-}"; do
    pkill -P "$pid" 2>/dev/null || true
  done
  ok "app stopped. docker containers still running — './start.sh --down' to stop them."
  exit 0
}
trap cleanup INT TERM

# Per-service log colors (ANSI): api=cyan, web=magenta, worker=yellow.
C_API=36
C_WEB=35
C_WORKER=33

# Stream a service's output to THIS terminal, tagged like "[api] …", and also
# save it verbatim-with-tag to its log file. Fed via process substitution so the
# PID we track stays the service itself (cleanup can still kill it + its children).
prefix_stream() {
  local tag="$1" color="$2" logfile="$3"
  while IFS= read -r line || [ -n "$line" ]; do
    printf '\033[%sm[%-6s]\033[0m %s\n' "$color" "$tag" "$line"
  done | tee "$logfile"
}

# ── 1) infrastructure ────────────────────────────────────────────────────────
bold "woidmod dev launcher"
info "starting infrastructure (postgres, redis, minio, livekit)…"
docker compose up -d

info "waiting for Postgres to accept connections…"
for i in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U woidmod -d woidmod >/dev/null 2>&1; then
    ok "Postgres ready"
    break
  fi
  [ "$i" -eq 60 ] && { warn "Postgres didn't come up in 60s — check 'docker compose logs postgres'"; exit 1; }
  sleep 1
done

# ── 2) control-plane API ─────────────────────────────────────────────────────
info "control-plane API → http://localhost:3101"
( cd backend/control-plane
  [ -d node_modules ] || { info "installing control-plane deps (first run)…"; npm install; }
  npm run dev
) > >(prefix_stream api "$C_API" "$LOG_DIR/control-plane.log") 2>&1 &
PIDS+=($!)

# ── 3) dashboard ─────────────────────────────────────────────────────────────
info "dashboard → http://localhost:3100"
( cd frontend
  [ -d node_modules ] || { info "installing frontend deps (first run)…"; npm install; }
  npm run dev
) > >(prefix_stream web "$C_WEB" "$LOG_DIR/frontend.log") 2>&1 &
PIDS+=($!)

# ── 4) orchestrator (Python worker; only needed for real calls) ──────────────
if [ "$WITH_ORCH" -eq 1 ]; then
  if command -v python3 >/dev/null; then
    info "orchestrator (Python worker)…"
    ( cd backend/orchestrator
      # Create the venv only if it's missing (never recreated on later runs).
      if [ ! -x .venv/bin/python ]; then
        info "creating venv (first run)…"
        python3 -m venv .venv
        .venv/bin/python -m pip install --quiet --upgrade pip
      fi
      # Install deps only if the venv can't import them (fresh venv, a half-finished
      # earlier build, or a newly-added provider plugin). The openai plugin import is
      # the sentinel — it was added with the BYOK provider dispatch, so an older venv
      # missing it triggers a reinstall that also pulls the other new plugins.
      if ! .venv/bin/python -c "import livekit.agents, livekit.plugins.openai" >/dev/null 2>&1; then
        info "installing orchestrator deps (~1–2 min)…"
        .venv/bin/pip install --quiet -r requirements.txt
      fi
      .venv/bin/python -m src.main dev
    ) > >(prefix_stream worker "$C_WORKER" "$LOG_DIR/orchestrator.log") 2>&1 &
    PIDS+=($!)
  else
    warn "python3 not found — skipping orchestrator (dashboard still works)"
  fi
else
  warn "orchestrator skipped (--no-orchestrator)"
fi

# ── ready ────────────────────────────────────────────────────────────────────
sleep 2
echo
ok "stack up. All logs stream below, tagged [api] [web] [worker] — also saved to ./logs/*.log"
echo
bold "  Dashboard   http://localhost:3100"
bold "  API         http://localhost:3101"
echo
echo "  One service only:  tail -f logs/frontend.log"
echo "  Stop everything:   Ctrl+C  (then ./start.sh --down to stop docker too)"
echo
info "── live logs ──────────────────────────────────────────────────────────────"
wait
