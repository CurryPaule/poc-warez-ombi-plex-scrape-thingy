# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache dcron

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# Install Playwright browsers (chromium only, for potential future use)
RUN npx playwright install chromium --with-deps 2>/dev/null || true

COPY --from=builder /app/dist ./dist

# Copy scrape runner script
COPY docker/run-scrape.sh /app/run-scrape.sh
RUN chmod +x /app/run-scrape.sh

# Copy cron schedule
COPY docker/crontab /etc/crontabs/root

# Entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
