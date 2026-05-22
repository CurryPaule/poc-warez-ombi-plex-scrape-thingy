# WarezPlexThingy

TypeScript scraper that monitors warez.cx for new media releases and syncs findings to NocoDB.

## How it works

Two scraper modes:

| Mode | What it does | Schedule |
|---|---|---|
| `incremental` | Fetches all new releases since the last run, matches against the watchlist | Every 30 min |
| `search` | Queries the warez search API for each watchlist item to find older releases | Daily at 03:00 |

Matches are deduplicated by `warez_id` and written to the NocoDB **matches** table with status `new`. Other processes can read from that table and act on the findings.

## NocoDB Setup

Create three tables in NocoDB manually:

### `watchlist`
| Field | Type | Notes |
|---|---|---|
| `title` | Text | Title to search for |
| `type` | Single Select | `movie` or `series` |
| `imdb_id` | Text | Optional — enables precise matching |
| `tmdb_id` | Number | Optional |
| `quality_min` | Single Select | `720p`, `1080p`, `2160p` (leave blank for any) |
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
| `status` | Single Select: `new`, `notified`, `processed` |

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
| `MAX_INCREMENTAL_PAGES` | Max pages per incremental run (default 20, 0 = unlimited) |
| `SEARCH_DELAY_MS` | Delay between search queries in ms (default 1500) |

### Finding your NocoDB Table IDs

Open a table in NocoDB — the URL will look like:
```
http://localhost:8080/dashboard/#/nc/p_xxx/table/md_yyy
```
The table ID is the `md_yyy` part.

## Running locally

```bash
npm install
cp .env.example .env
# edit .env

npm run scrape:incremental
npm run scrape:search
```

## Docker

```bash
cd docker
docker compose up -d
```

Logs are written to the `scraper-logs` volume. To tail them:

```bash
docker exec warez-plex-scraper tail -f /var/log/cron-incremental.log
```

### Connecting to NocoDB in the same Docker network

If NocoDB runs in Docker too, uncomment the `networks` section in `docker/docker-compose.yml` and set `NOCODB_URL` to the container's internal hostname.

## Matching Logic

1. **IMDB/TMDB ID** — if both the watchlist item and the warez release carry an ID, it's compared exactly. This is the most reliable match.
2. **Normalized title** — lowercased, dots/dashes stripped, then compared. The release's `title` field (provided by warez, clean) and an extracted version of `fulltitle` are both checked.
3. **Quality filter** — tiers: `720p < 1080p < 2160p`. Set `quality_min` to reject lower-quality releases.
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
    incremental.ts      New-uploads scraper
    search.ts           Search-based scraper
docker/
  Dockerfile
  docker-compose.yml
  crontab               Cron schedule
  entrypoint.sh
```
