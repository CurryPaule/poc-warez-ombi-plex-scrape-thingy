#!/bin/sh
set -e

echo "=== WarezPlexThingy starting ==="

# Run search + enrich once at startup to catch up
echo "[startup] Running initial scrape..."
/app/run-scrape.sh || echo "[startup] Initial scrape failed (non-fatal)"

# Start cron daemon in foreground
echo "[startup] Starting cron daemon..."
crond -f -l 2
