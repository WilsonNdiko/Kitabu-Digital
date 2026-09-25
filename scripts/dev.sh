#!/usr/bin/env bash
# Kitabu dev — local API + web shell in one command.
#   API   http://127.0.0.1:8787  (the core, file-backed at apps/local-api/data/kitabu.db)
#   Web   http://localhost:5173  (Vite dev server; proxies /api to the local API)
set -euo pipefail
cd "$(dirname "$0")/.."

node --disable-warning=ExperimentalWarning apps/local-api/src/main.ts &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT

cd apps/web
exec npx vite --host 0.0.0.0 --port 5173
