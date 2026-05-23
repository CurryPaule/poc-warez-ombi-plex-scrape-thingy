#!/bin/sh
set -e

echo "============================================"
echo "[$(date -Iseconds)] Scrape run starting"
echo "============================================"

echo "[$(date -Iseconds)] Running search scraper..."
node /app/dist/index.js search || echo "[$(date -Iseconds)] Search scraper failed (non-fatal)"

echo "[$(date -Iseconds)] Running enrich scraper..."
node /app/dist/index.js enrich || echo "[$(date -Iseconds)] Enrich scraper failed (non-fatal)"

echo "[$(date -Iseconds)] Scrape run complete"
