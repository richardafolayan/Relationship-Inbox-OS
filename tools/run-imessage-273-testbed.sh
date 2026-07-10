#!/usr/bin/env bash
# Live test-bed for #273 — iMessage opportunistic private-API native send.
#
# Stands up the mock helper + runner + dashboard wired together on isolated
# high ports, against a throwaway DB seeded with ONE synthetic iMessage thread
# (fictional 555-0100 number — no real message can ever go out, even on the
# fallback path). Lets you exercise native threaded replies + tapbacks, and the
# fallback/degrade paths, WITHOUT disabling SIP and without touching real chats.
#
# Usage:   bash tools/run-imessage-273-testbed.sh
# Then open the URL it prints. Ctrl-C stops everything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUNNER_PORT=4273
DASHBOARD_PORT=3273
APP_DB="$ROOT/data/inbox-os.sqlite"
EMPTY_CHATDB="/tmp/imsg-273-empty-chat.db"
SOCK="$HOME/.relationship-inbox/imessage-helper-273.sock"
export DATABASE_URL="file:$APP_DB"

echo "▶ #273 test-bed — runner :$RUNNER_PORT  dashboard :$DASHBOARD_PORT  socket $SOCK"

# 1. Empty chat.db (real schema, zero rows) so the scan ingests nothing real.
if [ ! -f "$EMPTY_CHATDB" ]; then
  echo "  · building empty chat.db from real schema"
  sqlite3 "$HOME/Library/Messages/chat.db" ".schema" 2>/dev/null | sqlite3 "$EMPTY_CHATDB" 2>/dev/null || true
fi

# 2. Schema + client (idempotent), then seed the thread if it's missing.
npm run db:generate >/dev/null 2>&1
npm run db:push >/dev/null 2>&1
THREADS=$(sqlite3 "$APP_DB" "SELECT COUNT(*) FROM threads WHERE platform='IMESSAGE';" 2>/dev/null || echo 0)
if [ "$THREADS" = "0" ]; then
  echo "  · seeding synthetic iMessage test thread"
  node tools/seed-imessage-test-thread.mjs
fi

# 3. Clear ONLY our own ports/socket (never touch sibling worktrees' runners).
#    BSD/macOS xargs has no -r, so guard on a non-empty pid list instead.
mkdir -p "$HOME/.relationship-inbox"; rm -f "$SOCK"
pkill -f "tools/mock-imessage-helper/server.mjs" 2>/dev/null || true
for p in "$RUNNER_PORT" "$DASHBOARD_PORT"; do
  pids=$(lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
done
sleep 1

cleanup() { echo; echo "▶ stopping test-bed"; kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# 4. Mock helper. Knobs: MOCK_FAIL_REPLIES=true (reply fallback),
#    MOCK_UNSUPPORTED_KINDS=question (tapback degrade) — pass them in the env.
IMESSAGE_PRIVATE_API_SOCKET="$SOCK" node tools/mock-imessage-helper/server.mjs &

# 5. Runner (tsx, no watch → immune to sibling predev port-frees; isolated DB,
#    empty chat.db, private-API enabled and pointed at the mock).
RUNNER_PORT="$RUNNER_PORT" \
IMESSAGE_ENABLED=true \
IMESSAGE_DB_PATH="$EMPTY_CHATDB" \
IMESSAGE_PRIVATE_API_ENABLED=true \
IMESSAGE_PRIVATE_API_SOCKET="$SOCK" \
CONTACTS_BIRTHDAY_SYNC=false \
npx tsx apps/runner/src/index.ts &

# 6. Dashboard (rewrites /runner/* to our runner via RUNNER_PORT).
DASHBOARD_PORT="$DASHBOARD_PORT" RUNNER_PORT="$RUNNER_PORT" \
npm run dev --workspace @inbox-os/dashboard &

sleep 6
echo
echo "▶ OPEN:  http://localhost:$DASHBOARD_PORT/thread/$(sqlite3 "$APP_DB" "SELECT id FROM threads WHERE platform='IMESSAGE' LIMIT 1;")"
echo "  (Ctrl-C to stop. Watch native sends with: tail -f /tmp/imsg-273-mock.log is N/A here — the mock logs to this terminal.)"
wait
