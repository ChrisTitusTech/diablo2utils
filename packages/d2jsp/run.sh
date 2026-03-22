#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../.."

# Kill any existing server on port 8900
PID=$(lsof -ti tcp:8900 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "Killing existing server (PID $PID) on port 8900..."
  kill $PID 2>/dev/null || true
  sleep 1
fi

npx tsc -b packages/d2jsp

exec node --experimental-sqlite packages/d2jsp/build/cli.js serve --db tmp/d2jsp.sqlite "$@"
