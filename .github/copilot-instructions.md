# Copilot Instructions

## Project Overview

This is a TypeScript scraping solution that monitors **warez.cx** for movies and TV shows, matching uploads against a **NocoDB** watchlist and logging findings. It's designed to run in Docker with cron scheduling.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  warez.cx    │────▶│  Fastify API     │────▶│  NocoDB      │
│  REST API    │     │  - search        │     │  - watchlist  │
│              │     │  - enrich        │     │  - matches    │
└──────────────┘     │  - push          │     │  - state      │
                     │  - sort          │     └──────────────┘
                     └──────┬───────────┘
                            │        │
                     ┌──────▼──┐  ┌──▼───────────┐
                     │JDownload│  │ FileBrowser   │
                     │  er     │  │ (file ops)    │
                     └─────────┘  └───────────────┘
```

### Scraping Modes

1. **Search** (`/start/search`): Proactively searches for watchlist items. Returns **entry-level** results (media titles) — no download links, no episode info. IMDB IDs (e.g. `tt0903747`) work as search queries; TMDB IDs (numeric) do not. Writes matches as `found`.

2. **Enrich** (`/start/d/:uid`): Fetches full detail (all releases) for `found` matches. Applies Quality/Tags/Language filters against individual releases and promotes matching records to `matched` with full release data. Also re-checks `matched` series for new episodes.

3. **Push**: Sends `matched` downloads to JDownloader with metadata-encoded download paths (`{imdbId}-{type}[-{seasonEpisodeKey}]`). Transitions matches to `pushed`.

4. **Sort**: Webhook target for JDownloader. Receives relative download path, looks up match in NocoDB, moves video + subtitle files to Plex/Jellyfin directory structure via FileBrowser API. Transitions matches to `processed`.

### REST API

All modes are exposed via a Fastify REST API server (replaces the old CLI entry point):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/search` | Run search scraper |
| POST | `/api/enrich` | Run enrichment scraper |
| POST | `/api/push` | Push matched downloads to JDownloader |
| POST | `/api/workflow` | Run full pipeline: search → enrich → push |
| POST | `/api/sort` | Sort a completed download (JDownloader webhook target) |
| GET  | `/api/health` | Health check |

The sort endpoint accepts `{ "downloadPath": "tt1234567-movie/Release.Name" }` — a relative path that gets combined with `FILEBROWSER_DOWNLOAD_PATH` to form the full FileBrowser API path.

### FileBrowser Integration

File operations (list, create dirs, move, delete) are performed via FileBrowser's REST API:
- **Auth**: JWT token via `X-Auth` header (not Bearer)
- **Move**: `PATCH /api/resources/{path}?action=rename&destination={newPath}` (query params, not body)
- **Create dir**: `POST /api/resources/{path}/`
- **List**: `GET /api/resources/{path}`

### Media Sorting Rules

**Movies**: `{MEDIA_MOVIES_PATH}/Movie Title (year)/Fulltitle.From.Matches.Table.mkv`
- Video file is renamed to the fulltitle from the matches table
- Year extracted from fulltitle

**TV Shows**: `{MEDIA_SHOWS_PATH}/Show Title (year)/S01/release.mkv`
- Without subtitles: video files directly in season directory
- With subtitles: `S01/S01E02.Episode.Name/release.mkv + subs/subtitle.srt`

**Excluded**: Sample files (name contains "sample" or inside `/sample/` directory)
**Video formats**: mkv, mp4, avi, m4v, wmv, flv, mov, ts
**Subtitle formats**: srt, sub, ass, ssa, vtt, idx

### NocoDB Integration

- **API version: v3** — URL pattern: `/api/v3/data/{baseId}/{tableId}/records`
- **Auth header:** `xc-token` (not `xc-auth`)
- **Response format:** `{ records: [{ id, id_fields, fields: {...} }], next?, prev? }`
- **POST body:** `{ fields: { Key: value } }`
- **PATCH body:** `{ id: recordId, fields: { Key: value } }`
- Field names are **PascalCase** to match NocoDB column names

### Key Tables

**Watchlist** (`mdvv8x7pxr4vv93`):
- Title, Type (movie/series), ImdbId, TmdbId, Active, DeactivateOnMatch
- Quality, LangRequired, Tags, Season, LastEpisodeFound, LastMatchedAt, Notes

**Matches** (`mrg4iycb4esq3ma`):
- WatchlistId, WarezId, WarezUid, Title, Fulltitle, Type
- Season, Episode, SeasonEpisodeKey (e.g. "S02E05")
- Quality, Lang, Links, CryptedLinks, SizeBytes, ReleaseGroup
- ImdbId, TmdbId, WarezCreatedAt, MatchedAt, Status (found/matched/processed)

**State** (`mx7g7gdnsjh6keo`):
- Key, Value (general-purpose key-value store)

### Match Status State Machine

```
found → matched → pushed → processed
```

| Status | Meaning |
|---|---|
| `found` | Entry identified by search scraper. No release-level data yet. Awaiting enrichment. |
| `matched` | A specific release matches all filters. Has download links. Ready for push. |
| `pushed` | Links sent to JDownloader. Download path encoded with metadata. Awaiting download completion. |
| `processed` | Download sorted into media library by the sort step. |

## Deduplication

Matches are deduplicated by **content identity**, not just WarezId:

| Scenario | Dedup Key |
|---|---|
| Series with episode (S02E05) | WatchlistId + ImdbId + SeasonEpisodeKey |
| Movie or series without episode | WatchlistId + ImdbId |
| No IMDB ID available | WarezId (exact upload) |

This prevents duplicate match records when multiple uploaders upload the same content.

## Matching Logic

Priority order:
1. Type must match (movie/series)
2. Quality filter (exact match when set)
3. Language filter (all required langs must be present)
4. Tags filter (all tags must appear in fulltitle, AND logic, case-insensitive)
5. Season filter (regex `S\d{2}` from fulltitle)
6. IMDB/TMDB ID exact match (most reliable)
7. Normalized title match (fallback)

Episode extraction: `extractSeason()`, `extractEpisode()`, `extractSeasonEpisodeKey()` parse patterns like `S02E05`, `S02` from release fulltitles.

### Episode Tracking

For series, the enrichment scraper tracks episodes via `episode_count_in_season` from the detail API:
- **Initial enrichment** (`found` → `matched`): compares episode count against `watchlistItem.LastEpisodeFound`
- **Re-checks** (`matched` series): compares against the **match record's** `Episode` field — detects new episodes even when the watchlist was already updated by a prior run
- `LastEpisodeFound` in the watchlist is always updated to the highest episode count seen

## Project Structure

```
src/
├── config.ts              # Zod-validated env config with .env parsing
├── index.ts               # Entry point: starts the Fastify API server
├── server.ts              # Fastify REST API with all endpoints
├── matcher.ts             # Title normalization, ID matching, quality/lang/season/episode/tags filters
├── warez/
│   ├── api.ts             # WarezClient: searchEntries(), fetchEntryDetail(), fetchReleases() (test scripts)
│   └── types.ts           # WarezRelease, WarezSearchEntry, WarezEntryDetail, response types
├── nocodb/
│   ├── client.ts          # NocoDbClient: watchlist CRUD, match upsert/update with dedup, state KV, IMDB lookup
│   └── types.ts           # WatchlistRow, MatchRow, ScraperStateRow, v3 response types
├── scrapers/
│   ├── search.ts          # Search-based scraper with entry-level matching
│   ├── enrich.ts          # Detail enrichment + episode tracking scraper (found → matched)
│   ├── push.ts            # JDownloader push scraper with metadata path encoding
│   └── sort.ts            # Media sorter — moves downloads to Plex/Jellyfin dirs via FileBrowser
├── filebrowser/
│   └── client.ts          # FileBrowser REST API client (X-Auth JWT, list/create/move/delete)
├── jdownloader/
│   └── client.ts          # MyJDownloader API wrapper
└── scripts/
    ├── test-warez.ts      # API connectivity test (--search "query")
    ├── test-nocodb.ts     # NocoDB connection validator
    └── test-match.ts      # Dry-run matcher against live data
```

## Running Locally

```bash
# Install deps
npm install

# Set up .env (copy from .env.example, fill in NocoDB credentials)
cp .env.example .env

# Test scripts
npm run test:warez                          # Test API connectivity
npm run test:warez -- --search "Breaking Bad"  # Test search
npm run test:nocodb                         # Test NocoDB connection
npm run test:match                          # Dry-run matcher

# Start the API server
npm run dev                                 # Dev mode (ts-node)
npm run build && npm start                  # Production mode

# Trigger scrapers via HTTP (server must be running)
# curl.exe -X POST http://localhost:3000/api/workflow
# curl.exe -X POST http://localhost:3000/api/sort -H "Content-Type: application/json" -d '{"downloadPath":"tt1234567-movie/Release.Name"}'
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NOCODB_URL` | ✅ | NocoDB instance URL (no trailing slash) |
| `NOCODB_API_KEY` | ✅ | NocoDB PAT token (`nc_pat_...`) |
| `NOCODB_BASE_ID` | ✅ | NocoDB base ID (`p...`) |
| `NOCODB_WATCHLIST_TABLE_ID` | ✅ | Watchlist table ID |
| `NOCODB_MATCHES_TABLE_ID` | ✅ | Matches table ID |
| `NOCODB_STATE_TABLE_ID` | ✅ | State table ID |
| `WAREZ_API_BASE` | ❌ | Default: `https://api.warez.cx` |
| `SEARCH_DELAY_MS` | ❌ | Default: 1500 |
| `DEFAULT_QUALITY` | ❌ | Default: (empty = any) |
| `API_PORT` | ❌ | Default: 3000 |
| `JDOWNLOADER_EMAIL` | For push | MyJDownloader email |
| `JDOWNLOADER_PASSWORD` | For push | MyJDownloader password |
| `JDOWNLOADER_DEVICE_NAME` | For push | Device name in MyJDownloader |
| `JDOWNLOADER_AUTOSTART` | ❌ | Default: false |
| `JDOWNLOADER_HOSTER_PRIORITY` | ❌ | Default: `ddownload,rapidgator` |
| `FILEBROWSER_URL` | For sort | FileBrowser instance URL |
| `FILEBROWSER_USERNAME` | For sort | FileBrowser login |
| `FILEBROWSER_PASSWORD` | For sort | FileBrowser password |
| `FILEBROWSER_DOWNLOAD_PATH` | For sort | Download dir path in FileBrowser |
| `MEDIA_MOVIES_PATH` | For sort | Movies dir path in FileBrowser |
| `MEDIA_SHOWS_PATH` | For sort | TV shows dir path in FileBrowser |

## Important Technical Notes

- **warez.cx search supports IMDB IDs as queries** — `tt0903747` returns exact match. TMDB IDs (numeric) are unreliable (substring match).
- **`/start/release` `q` param is non-functional** — it always returns the latest feed regardless of query value. Search must use `/start/search`.
- **Search returns entry-level results** (1 per media title) with no download links. Download links come from `/start/d/:uid` (detail API) or `/start/release` (feed).
- **Detail API (`/start/d/:uid`)** returns the full entry with all releases (download links, quality, codec, size, group, `episode_count_in_season`). No auth required. Used by the enrichment scraper.
- **WarezUid vs Release UUID** — search entries have short UIDs like `bZaytSlvMxuK` (entry UID, used for `/start/d/{uid}`). Detail releases have UUIDs like `5f0a05fc-...` (release UID). The enrich scraper must NOT overwrite `WarezUid` with the release UUID, or re-enrichment breaks.
- **NocoDB Tags field** — multi-select returns an **array**, not a comma-separated string. `matchesTags()` handles both formats.
- **NocoDB SingleSelect columns** require options to be explicitly configured via the meta API. The `dtxp` parameter during column creation doesn't always apply.
- **Windows development**: `npx` is a `.ps1` script; for MCP configs use `cmd /c npx` wrapper.

## Docker Deployment

```bash
cd docker
docker compose up -d
```

The container runs the Fastify API server as the main process with cron in the background.
Cron calls `POST /api/workflow` every 4 hours via curl.
The API server is exposed on port 3000 (configurable via `API_PORT`).

## Future Work

- [ ] Ombi webhook integration to auto-populate watchlist
- [ ] Notification system (webhook/email) for new matches
- [ ] Episode-aware notifications (only alert for new episodes)
