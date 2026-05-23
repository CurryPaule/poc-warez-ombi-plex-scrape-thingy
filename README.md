# WarezPlexThingy

TypeScript scraper that monitors warez.cx for new media releases and syncs findings to NocoDB.

## How it works

Two scraper modes:

| Mode | What it does | Schedule |
|---|---|---|
| `search` | Queries the warez search API for each watchlist item to find media entries | Every 4 hours |
| `enrich` | Fetches full release detail, applies quality/tags filters, tracks new episodes | Every 4 hours (after search) |

### Match Status Flow

```
found → matched → processed
```

- **`found`** — entry identified by search scraper (no release data yet)
- **`matched`** — release matches all filters, has download links, ready for downstream
- **`processed`** — handled by downstream consumer (future)

The **search** scraper writes matches as `found`. The **enrich** scraper promotes them to `matched` after finding a release that passes all filters. It also re-checks `matched` series for new episodes.

## NocoDB Setup

Create three tables in NocoDB manually:

### `watchlist`
| Field | Type | Notes |
|---|---|---|
| `Title` | Text | Title to search for |
| `Type` | Single Select | `movie` or `series` |
| `ImdbId` | Text | Optional — enables precise matching |
| `TmdbId` | Number | Optional |
| `Quality` | Single Select | `720p`, `1080p`, `2160p` (leave blank for any) |
| `LangRequired` | Text | Comma-separated e.g. `GER,ENG` |
| `Tags` | Multi Select | AND filter against fulltitle (e.g. `HDR`, `WEB`, `H265`, uploader name) |
| `Season` | Number | Series season number (blank = any) |
| `LastEpisodeFound` | Number | Auto-updated — highest episode count matched so far |
| `Active` | Checkbox | Uncheck to pause monitoring |
| `DeactivateOnMatch` | Checkbox | Auto-deactivate movie items after first match |
| `LastMatchedAt` | DateTime | Auto-updated by scraper |
| `Notes` | Long Text | Free notes |

### `matches`
| Field | Type |
|---|---|
| `WatchlistId` | Number |
| `WarezId` | Number |
| `WarezUid` | Text |
| `Title` | Text |
| `Fulltitle` | Text |
| `Type` | Text |
| `Season` | Number |
| `Episode` | Number |
| `SeasonEpisodeKey` | Text (e.g. `S02E05`) |
| `Quality` | Text |
| `Lang` | Long Text (JSON) |
| `Links` | Long Text (JSON) |
| `CryptedLinks` | Long Text (JSON) |
| `SizeBytes` | Number |
| `ReleaseGroup` | Text |
| `ImdbId` | Text |
| `TmdbId` | Number |
| `WarezCreatedAt` | DateTime |
| `MatchedAt` | DateTime |
| `Status` | Single Select: `found`, `matched`, `processed` |

### `scraper_state`
| Field | Type |
|---|---|
| `key` | Text |
| `value` | Text |

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key variables:

| Variable | Description |
|---|---|
| `NOCODB_URL` | NocoDB base URL, e.g. `http://localhost:8080` |
| `NOCODB_API_KEY` | NocoDB API token (from Team & Auth settings) |
| `NOCODB_WATCHLIST_TABLE_ID` | Table ID from NocoDB URL when viewing the table |
| `NOCODB_MATCHES_TABLE_ID` | Same for matches table |
| `NOCODB_STATE_TABLE_ID` | Same for state table |
| `SEARCH_DELAY_MS` | Delay between API queries in ms (default 1500) |

### Finding your NocoDB Table IDs

Open a table in NocoDB — the URL will look like:
```
http://localhost:8080/dashboard/#/nc/p_xxx/table/md_yyy
```
The table ID is the `md_yyy` part.

## Running locally

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# edit .env with your NocoDB credentials

# Run in dev mode (no build step needed)
npx ts-node src/index.ts search        # search for watchlist items
npx ts-node src/index.ts enrich        # enrich found matches & check for new episodes

# Or build first, then run
npm run build
npm run start -- search
npm run start -- enrich
```

### Test scripts

```bash
npm run test:warez                            # Test warez.cx API connectivity
npm run test:warez -- --search "Breaking Bad" # Test search with a query
npm run test:nocodb                           # Test NocoDB connection
npm run test:match                            # Dry-run matcher against live data
```

## Docker

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- A `.env` file in the project root with your NocoDB credentials (see [Configuration](#configuration))

### Build and run

```bash
# From the project root (not the docker/ folder)
docker compose -f docker/docker-compose.yml build

# Start the container (runs search + enrich immediately, then every 4 hours via cron)
docker compose -f docker/docker-compose.yml up -d
```

### What happens on startup

1. The container runs **search** then **enrich** sequentially on first boot
2. A cron job repeats that cycle every 4 hours
3. The container stays running between cron runs

### Useful commands

```bash
# Check if the container is running
docker ps --filter name=warez-plex-scraper

# Follow the live logs (startup + cron output)
docker logs -f warez-plex-scraper

# View the cron scrape log inside the container
docker exec warez-plex-scraper cat /var/log/cron-scrape.log

# Manually trigger a scrape run without waiting for cron
docker exec warez-plex-scraper /app/run-scrape.sh

# Stop the container
docker compose -f docker/docker-compose.yml down

# Rebuild after code changes
docker compose -f docker/docker-compose.yml up -d --build
```

### Connecting to NocoDB in the same Docker network

If NocoDB runs in Docker too, uncomment the `networks` section in `docker/docker-compose.yml` and set `NOCODB_URL` to the container's internal hostname (e.g. `http://nocodb:8080`).

## Matching Logic

1. **IMDB/TMDB ID** — if both the watchlist item and the warez release carry an ID, it's compared exactly. This is the most reliable match.
2. **Normalized title** — lowercased, dots/dashes stripped, then compared. The release's `title` field (provided by warez, clean) and an extracted version of `fulltitle` are both checked.
3. **Quality filter** — tiers: `720p`, `1080p`, `2160p`. Set `Quality` to match only that exact quality tier.
4. **Language filter** — `LangRequired = GER,ENG` means the release must include both German and English audio.
5. **Tags filter** — all tags must appear in the release fulltitle (AND logic, case-insensitive). Use for format filters (`HDR`, `WEB`, `H265`) or to pin a specific uploader for consistent quality.
6. **Season filter** — for series, set `Season = 2` to only match season 2 releases.

### Episode Tracking

For series, the enrichment scraper tracks episodes via `episode_count_in_season` from the detail API:
- **Initial enrichment** (`found` → `matched`): compares against `LastEpisodeFound` in the watchlist
- **Re-checks** (`matched` series): compares against the match record's `Episode` field — if the detail API now reports more episodes, the match is updated
- `LastEpisodeFound` in the watchlist is always updated to the highest episode count seen

## Project Structure

```
src/
  index.ts              CLI entry point
  config.ts             Env loading + validation
  matcher.ts            Title/quality/lang matching logic
  nocodb/
    client.ts           NocoDB REST API wrapper
    types.ts            Table row types
  warez/
    api.ts              warez.cx API client
    types.ts            API response types
  scrapers/
    search.ts           Search-based scraper
    enrich.ts           Detail enrichment + episode tracking scraper
docker/
  Dockerfile
  docker-compose.yml
  crontab               Cron schedule
  entrypoint.sh         Container entrypoint (startup + cron daemon)
  run-scrape.sh         Runs search → enrich sequentially
```
