# Copilot Instructions

## Project Overview

This is a TypeScript + Playwright scraping solution that monitors **warez.cx** for movies and TV shows, matching uploads against a **NocoDB** watchlist and logging findings. It's designed to run in Docker with cron scheduling.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  warez.cx    │────▶│  Scraper (TS)    │────▶│  NocoDB      │
│  REST API    │     │  - incremental   │     │  - watchlist  │
│              │     │  - search        │     │  - matches    │
└──────────────┘     │  - enrich        │     │  - state      │
                     └──────────────────┘     └──────────────┘
```

### Three Scraping Modes

1. **Incremental** (`/start/release`): Monitors the live feed every 30 min. Returns individual **releases** with download links, quality, season/episode info. The `q` param does NOT work on this endpoint. Writes matches directly as `matched`.

2. **Search** (`/start/search`): Proactively searches for watchlist items daily. Returns **entry-level** results (media titles) — no download links, no episode info. IMDB IDs (e.g. `tt0903747`) work as search queries; TMDB IDs (numeric) do not. Writes matches as `found`.

3. **Enrich** (`/start/d/:uid`): Fetches full detail (all releases) for `found` matches. Applies Quality/Tags/Language filters against individual releases and promotes matching records to `matched` with full release data.

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
- Key, Value (used for `last_incremental_run_at` checkpoint)

### Match Status State Machine

```
found → matched → processed
```

| Status | Meaning |
|---|---|
| `found` | Entry identified by search scraper. No release-level data yet. Awaiting enrichment. |
| `matched` | A specific release matches all filters. Has download links. Ready for downstream. |
| `processed` | Handled by downstream consumer (future). |

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
4. Season filter (regex `S\d{2}` from fulltitle)
5. IMDB/TMDB ID exact match (most reliable)
6. Normalized title match (fallback)

Episode extraction: `extractSeason()`, `extractEpisode()`, `extractSeasonEpisodeKey()` parse patterns like `S02E05`, `S02` from release fulltitles.

## Project Structure

```
src/
├── config.ts              # Zod-validated env config with .env parsing
├── index.ts               # CLI entry: `node dist/index.js <incremental|search|enrich>`
├── matcher.ts             # Title normalization, ID matching, quality/lang/season/episode/tags filters
├── warez/
│   ├── api.ts             # WarezClient: fetchReleases(), streamReleases(), searchEntries(), fetchEntryDetail()
│   └── types.ts           # WarezRelease, WarezSearchEntry, WarezEntryDetail, response types
├── nocodb/
│   ├── client.ts          # NocoDbClient: watchlist CRUD, match upsert/update with dedup, state KV
│   └── types.ts           # WatchlistRow, MatchRow, ScraperStateRow, v3 response types
├── scrapers/
│   ├── incremental.ts     # Feed monitor with checkpoint pagination
│   ├── search.ts          # Search-based scraper with entry-level matching
│   └── enrich.ts          # Detail enrichment scraper (found → matched)
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

# Run scrapers
npx ts-node src/index.ts search             # Search for all watchlist items
npx ts-node src/index.ts incremental        # Check new uploads since last run
npx ts-node src/index.ts enrich             # Enrich found matches with release detail

# Build for production
npm run build
npm run start -- search
npm run start -- incremental
npm run start -- enrich
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
| `MAX_INCREMENTAL_PAGES` | ❌ | Default: 20 |
| `SEARCH_DELAY_MS` | ❌ | Default: 1500 |
| `DEFAULT_QUALITY` | ❌ | Default: (empty = any) |

## Important Technical Notes

- **warez.cx search supports IMDB IDs as queries** — `tt0903747` returns exact match. TMDB IDs (numeric) are unreliable (substring match).
- **`/start/release` `q` param is non-functional** — it always returns the latest feed regardless of query value. Search must use `/start/search`.
- **Search returns entry-level results** (1 per media title) with no download links. Download links come from `/start/d/:uid` (detail API) or `/start/release` (feed).
- **Detail API (`/start/d/:uid`)** returns the full entry with all releases (download links, quality, codec, size, group). No auth required. Used by the enrichment scraper.
- **NocoDB SingleSelect columns** require options to be explicitly configured via the meta API. The `dtxp` parameter during column creation doesn't always apply.
- **Windows development**: `npx` is a `.ps1` script; for MCP configs use `cmd /c npx` wrapper.

## Docker Deployment

```bash
cd docker
docker compose up -d
```

Cron schedule (configured in `docker/crontab`):
- Every 30 min: incremental scraper
- Daily at 03:00: search scraper
- Daily at 03:30: enrichment scraper (after search completes)

## Future Work

- [ ] Ombi webhook integration to auto-populate watchlist
- [ ] Notification system (webhook/email) for new matches
- [ ] Episode-aware notifications (only alert for new episodes)
- [ ] Downstream consumer for `processed` status (download automation)
