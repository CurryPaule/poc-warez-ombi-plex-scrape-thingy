#!/bin/sh
set -e

echo "=== WarezPlexThingy starting ==="

# Run incremental scraper once at startup to catch up
echo "[startup] Running initial incremental scrape..."
node /app/dist/index.js incremental || echo "[startup] Initial scrape failed (non-fatal)"

# Start cron daemon in foreground
echo "[startup] Starting cron daemon..."
crond -f -l 2
