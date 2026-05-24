# WarezPlexThingy

TypeScript scraper that monitors warez.cx for new media releases, syncs findings to NocoDB, pushes downloads to JDownloader, and sorts completed downloads into Plex/Jellyfin media directories.

## How it works

A Fastify REST API server exposes all scraper modes as HTTP endpoints:

| Endpoint | What it does |
|---|---|
| `POST /api/search` | Queries the warez search API for each watchlist item to find media entries |
| `POST /api/enrich` | Fetches full release detail, applies quality/tags filters, tracks new episodes |
| `POST /api/push` | Sends matched downloads to JDownloader via MyJDownloader API |
| `POST /api/sort` | Sorts completed downloads into Plex/Jellyfin directory structure via FileBrowser |
| `POST /api/workflow` | Runs the full pipeline: search → enrich → push |
| `GET /api/health` | Health check |

### Match Status Flow

```
found → matched → pushed → processed
```

- **`found`** — entry identified by search scraper (no release data yet)
- **`matched`** — release matches all filters, has download links, ready for push
- **`pushed`** — links sent to JDownloader successfully
- **`processed`** — download sorted into media library by the sort step

The **search** scraper writes matches as `found`. The **enrich** scraper promotes them to `matched` after finding a release that passes all filters. It also re-checks `matched` series for new episodes. The **push** scraper sends `matched` downloads to JDownloader (with metadata-encoded paths) and transitions them to `pushed`. The **sort** step moves completed downloads into the correct Plex/Jellyfin directory and transitions them to `processed`.

### Media Sorting

When JDownloader completes a download, its EventScripter calls the sort endpoint. The download path contains encoded metadata (`{imdbId}-{type}[-{seasonEpisodeKey}]`) that the sort step uses to:

1. Look up the match in NocoDB by IMDB ID
2. Determine the correct destination (movies or shows directory)
3. Move video files (mkv, mp4, avi, etc.) and subtitles (srt, sub, ass, etc.) via FileBrowser's API
4. Skip sample files automatically
5. Rename movie files to the fulltitle from the matches table

**Directory structure:**

```
movies/
  Movie Title (2024)/
    Movie.Title.2024.German.DL.1080p.BluRay.x264-GROUP.mkv

shows/
  Show Title (2024)/
    S01/
      Show.Title.S01E02.Episode.Name.mkv           ← no subs
      Show.Title.S01E03.Episode.Name/               ← with subs
        Show.Title.S01E03.Episode.Name.mkv
        subs/
          subtitle.srt
```

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
| `Status` | Single Select: `found`, `matched`, `pushed`, `processed` |

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
| `JDOWNLOADER_EMAIL` | MyJDownloader account email (required for `push` mode) |
| `JDOWNLOADER_PASSWORD` | MyJDownloader account password (required for `push` mode) |
| `JDOWNLOADER_DEVICE_NAME` | JDownloader device name (required for `push` mode) |
| `JDOWNLOADER_AUTOSTART` | Auto-start downloads in JDownloader (default: `false`) |
| `JDOWNLOADER_HOSTER_PRIORITY` | Comma-separated hoster preference (default: `ddownload,rapidgator`) |
| `API_PORT` | REST API server port (default: `3000`) |
| `FILEBROWSER_URL` | FileBrowser instance URL (required for `sort` mode) |
| `FILEBROWSER_USERNAME` | FileBrowser login username (required for `sort` mode) |
| `FILEBROWSER_PASSWORD` | FileBrowser login password (required for `sort` mode) |
| `FILEBROWSER_DOWNLOAD_PATH` | Download directory path in FileBrowser (required for `sort` mode) |
| `MEDIA_MOVIES_PATH` | Movies directory path in FileBrowser (required for `sort` mode) |
| `MEDIA_SHOWS_PATH` | TV shows directory path in FileBrowser (required for `sort` mode) |

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

# Run the API server in dev mode
npm run dev

# The server starts on http://localhost:3000 (or API_PORT)
# Trigger scrapers via HTTP:
#   PowerShell: Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/workflow
#   curl:       curl.exe -X POST http://localhost:3000/api/workflow

# Or build first, then run
npm run build
npm start
```

### API Endpoints

```bash
# Full pipeline (search → enrich → push)
curl.exe -X POST http://localhost:3000/api/workflow

# Individual steps
curl.exe -X POST http://localhost:3000/api/search
curl.exe -X POST http://localhost:3000/api/enrich
curl.exe -X POST http://localhost:3000/api/push

# Sort a completed download
curl.exe -X POST http://localhost:3000/api/sort -H "Content-Type: application/json" -d "{\"downloadPath\": \"tt1234567-movie/Release.Name\"}"

# Health check
curl.exe http://localhost:3000/api/health
```

### Test scripts

```bash
npm run test:warez                            # Test warez.cx API connectivity
npm run test:warez -- --search "Breaking Bad" # Test search with a query
npm run test:nocodb                           # Test NocoDB connection
npm run test:match                            # Dry-run matcher against live data
npm run test:jdownloader                      # Test MyJDownloader connectivity
```

## Docker

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- A `.env` file in the project root with your NocoDB credentials (see [Configuration](#configuration))

### Build and run

```bash
# From the project root (not the docker/ folder)
docker compose -f docker/docker-compose.yml build

# Start the container (API server + cron for scheduled workflow runs)
docker compose -f docker/docker-compose.yml up -d
```

### What happens on startup

1. The cron daemon starts in the background (runs workflow every 4 hours)
2. The Fastify API server starts on port 3000 (foreground process)
3. JDownloader webhooks and manual API calls can trigger scraping/sorting anytime

### Useful commands

```bash
# Check if the container is running
docker ps --filter name=warez-plex-scraper

# Follow the live logs (API server + scraper output)
docker logs -f warez-plex-scraper

# Manually trigger a full workflow via the API
curl -X POST http://localhost:3000/api/workflow

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
  index.ts              Entry point — starts the Fastify API server
  server.ts             Fastify REST API with all endpoints
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
    push.ts             JDownloader push scraper (with metadata path encoding)
    sort.ts             Media sorter — moves downloads to Plex/Jellyfin dirs via FileBrowser
  filebrowser/
    client.ts           FileBrowser REST API wrapper (X-Auth JWT)
  jdownloader/
    client.ts           MyJDownloader API wrapper
docker/
  Dockerfile
  docker-compose.yml
  crontab               Cron schedule (calls API endpoints via curl)
  entrypoint.sh         Container entrypoint (cron daemon + API server)
  run-scrape.sh         Runs workflow via API call
```
