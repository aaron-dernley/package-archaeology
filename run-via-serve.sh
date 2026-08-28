#!/bin/bash
# Starts swamp serve just long enough to run one method call through it,
# then tears it down — avoids the ~400MB idle RSS cost of a persistent
# swamp serve daemon while still going through swamp serve as requested.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9092
INSTANCE=my-host
METHOD=findOldest

cd "$REPO_DIR"
swamp serve --repo-dir "$REPO_DIR" --port "$PORT" --host 127.0.0.1 --no-schedule --no-telemetry \
  >/tmp/package-archaeology-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

swamp model method run "$INSTANCE" "$METHOD" --server "ws://127.0.0.1:${PORT}"
