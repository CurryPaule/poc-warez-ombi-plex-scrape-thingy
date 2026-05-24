#!/bin/sh
set -e

echo "=== WarezPlexThingy starting ==="

# Start cron daemon in background
echo "[startup] Starting cron daemon..."
crond -l 2

# Start the API server (foreground)
echo "[startup] Starting API server..."
exec node /app/dist/index.js
