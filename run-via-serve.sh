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
swamp serve --repo-dir "$REPO_DIR" --port "$PORT" --host 127.0.0.1 --no-schedule \
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

# Export a small Prometheus textfile snippet for the Fun Stuff Grafana
# dashboard. Written atomically (tmp file + mv) since node_exporter may
# be scraping the textfile directory concurrently.
PROM_DIR=/var/lib/prometheus/node-exporter
PROM_TMP="$(mktemp "${PROM_DIR}/.package-archaeology.prom.XXXXXX")"
swamp data get "$INSTANCE" oldestPackages --server "ws://127.0.0.1:${PORT}" --json | python3 -c "
import json, sys
d = json.load(sys.stdin)['content']
oldest = d['packages'][0]
def esc(s):
    return s.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"')
print('# HELP package_archaeology_oldest_age_days Age in days of the oldest-touched installed package (last dpkg touch, not necessarily original install), labeled with the package\\'s name and version.')
print('# TYPE package_archaeology_oldest_age_days gauge')
print(f\"package_archaeology_oldest_age_days{{package=\\\"{esc(oldest['package'])}\\\",version=\\\"{esc(oldest['currentVersion'] or '')}\\\"}} {oldest['ageDays']}\")
print('# HELP package_archaeology_total_scanned Total installed packages scanned for this snapshot.')
print('# TYPE package_archaeology_total_scanned gauge')
print(f\"package_archaeology_total_scanned {d['totalPackagesScanned']}\")
" > "$PROM_TMP"
chmod 644 "$PROM_TMP"
mv "$PROM_TMP" "${PROM_DIR}/package-archaeology.prom"
