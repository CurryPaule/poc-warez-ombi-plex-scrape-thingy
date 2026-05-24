#!/bin/sh
set -e

API_PORT="${API_PORT:-3000}"
API_URL="http://localhost:${API_PORT}"

echo "============================================"
echo "[$(date -Iseconds)] Scrape run starting (via API)"
echo "============================================"

echo "[$(date -Iseconds)] Running workflow (search → enrich → push)..."
curl -s -X POST "${API_URL}/api/workflow" | head -c 500
echo ""

echo "[$(date -Iseconds)] Scrape run complete"
