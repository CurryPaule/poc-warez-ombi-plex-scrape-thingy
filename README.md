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
| `title` | Text | Title to search for |
| `type` | Single Select | `movie` or `series` |
| `imdb_id` | Text | Optional — enables precise matching |
| `tmdb_id` | Number | Optional |
| `quality` | Single Select | `720p`, `1080p`, `2160p` (leave blank for any) |
| `lang_required` | Text | Comma-separated e.g. `GER,ENG` |
| `season` | Number | Series season number (blank = any) |
| `is_active` | Checkbox | Uncheck to pause monitoring |
| `last_matched_at` | DateTime | Auto-updated by scraper |
| `notes` | Long Text | Free notes |

### `matches`
| Field | Type |
|---|---|
| `watchlist_id` | Number |
| `warez_id` | Number |
| `warez_uid` | Text |
| `title` | Text |
| `fulltitle` | Text |
| `type` | Text |
| `quality` | Text |
| `lang` | Long Text (JSON) |
| `links` | Long Text (JSON) |
| `crypted_links` | Long Text (JSON) |
| `size_bytes` | Number |
| `release_group` | Text |
| `imdb_id` | Text |
| `tmdb_id` | Number |
| `warez_created_at` | DateTime |
| `matched_at` | DateTime |
| `status` | Single Select: `found`, `matched`, `processed` |

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

```bash
cd docker
docker compose up -d
```

Logs are written to the `scraper-logs` volume. To tail them:

```bash
docker exec warez-plex-scraper tail -f /var/log/cron-search.log
```

### Connecting to NocoDB in the same Docker network

If NocoDB runs in Docker too, uncomment the `networks` section in `docker/docker-compose.yml` and set `NOCODB_URL` to the container's internal hostname.

## Matching Logic

1. **IMDB/TMDB ID** — if both the watchlist item and the warez release carry an ID, it's compared exactly. This is the most reliable match.
2. **Normalized title** — lowercased, dots/dashes stripped, then compared. The release's `title` field (provided by warez, clean) and an extracted version of `fulltitle` are both checked.
3. **Quality filter** — tiers: `720p`, `1080p`, `2160p`. Set `quality` to match only that exact quality tier.
4. **Language filter** — `lang_required = GER,ENG` means the release must include both German and English audio.
5. **Season filter** — for series, set `season = 2` to only match season 2 releases.

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
  entrypoint.sh
```
