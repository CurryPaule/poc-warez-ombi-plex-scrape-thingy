# Search Architecture

## Two-Tier Approach

The warez.cx API has two fundamentally different endpoints, each serving a different purpose:

```
┌─────────────────────────────────────────────────────────────────┐
│                     warez.cx API                                │
├──────────────────────┬──────────────────────────────────────────┤
│  /start/release      │  /start/search                          │
│  (Feed / WarezMode)  │  (Search Page)                          │
├──────────────────────┼──────────────────────────────────────────┤
│  ✅ Download links   │  ❌ No download links                   │
│  ✅ Quality, size    │  ❌ No quality/size info                 │
│  ✅ Release groups   │  ❌ No release group info                │
│  ❌ No text search   │  ✅ Full-text search works               │
│  ✅ Season/episode   │  ❌ Entry-level only (no episodes)       │
│  Individual releases │  Media entries (1 per title)             │
└──────────────────────┴──────────────────────────────────────────┘
```

## How the Scrapers Use Each Endpoint

### Incremental Scraper (`/start/release`)

- **Purpose:** Monitor new uploads since the last run
- **Schedule:** Every 30 minutes via cron
- **Process:**
  1. Fetch latest releases sorted by date
  2. Paginate backwards until we reach the last checkpoint
  3. Match each release against the active watchlist
  4. Extract season/episode from fulltitle (e.g. `S02E05`)
  5. Dedup by WatchlistId + ImdbId + SeasonEpisodeKey
  6. Write matches with full download links to NocoDB
  7. Track highest episode found per watchlist item (`LastEpisodeFound`)
  8. Auto-deactivate movie items if `DeactivateOnMatch` is set

This is the primary source of actionable data because it includes download links.

### Search Scraper (`/start/search`)

- **Purpose:** Find older content that was uploaded before monitoring started
- **Schedule:** Daily via cron
- **Process:**
  1. Load active watchlist items
  2. For each item, query `/start/search` with IMDB ID (preferred) or title
  3. Match results by IMDB/TMDB ID or normalized title
  4. Dedup by WatchlistId + ImdbId (entry-level, no episode info)
  5. Write matches to NocoDB (without download links)

Search results are **entry-level** — they confirm a title exists on the site with metadata (IMDB ID, cover, description) but don't include individual releases or download links.

## Deduplication Strategy

### Problem
Without dedup, the same content creates duplicate match records:
- Multiple uploaders upload the same episode → multiple WarezIds
- Search scraper re-finds the same series every run
- Same release appears in both incremental and search results

### Solution: Content-Based Dedup

The `upsertMatch` method checks for existing records before inserting:

```
For series with episode info (S02E05):
  → Dedup key: WatchlistId + ImdbId + SeasonEpisodeKey

For movies or series without episode info:
  → Dedup key: WatchlistId + ImdbId

Fallback (no IMDB ID available):
  → Dedup key: WarezId (exact same upload)
```

The `upsertMatch` returns `true` if a new record was created, `false` if skipped. Scrapers log `⏩ Skipped` for duplicates.

### Episode Tracking

For series, the scraper extracts episode info from the release fulltitle:

| Fulltitle Pattern | Season | Episode | Key |
|---|---|---|---|
| `Breaking.Bad.S02E05.German...` | 2 | 5 | `S02E05` |
| `Breaking.Bad.S02.Complete...` | 2 | null | `S02` |
| `Breaking.Bad.German.DL...` | null | null | null |

The watchlist `LastEpisodeFound` field tracks the highest episode matched so far, enabling future features like "notify only for new episodes."

## The Missing Piece: Entry Detail API

To get download links for a search result, we need to navigate to the detail page for that entry. The SPA loads release data when visiting:

```
https://warez.cx/detail/{uid}/{slug}
```

The exact API endpoint for this is **not yet discovered**. Options to resolve this:

1. **Playwright interception** — Use Playwright to visit the detail page and intercept the XHR request to capture the API endpoint
2. **Lazy-loaded JS analysis** — The detail page view is in a separate JS chunk; deobfuscating it may reveal the endpoint
3. **Accept entry-level only** — For now, search matches are flagged without download links; the incremental scraper will eventually pick up releases for the same entries and update the match records

## Match Record Schema

| Field | From Incremental | From Search |
|---|---|---|
| `Title` | ✅ | ✅ |
| `Fulltitle` | ✅ (release name) | ✅ (entry name) |
| `Type` | ✅ | ✅ |
| `ImdbId` | ✅ | ✅ |
| `TmdbId` | ✅ | ✅ |
| `Season` | ✅ (extracted) | ❌ (null) |
| `Episode` | ✅ (extracted) | ❌ (null) |
| `SeasonEpisodeKey` | ✅ (e.g. S02E05) | ❌ (null) |
| `Quality` | ✅ | ❌ (empty) |
| `Links` | ✅ (JSON) | ❌ (`{}`) |
| `CryptedLinks` | ✅ (JSON) | ❌ (`{}`) |
| `SizeBytes` | ✅ | ❌ (0) |
| `ReleaseGroup` | ✅ | ❌ (empty) |

## Matching Logic

### For `/start/release` (incremental)

1. Type must match (movie/series)
2. Apply quality filter (720p < 1080p < 2160p tier)
3. Apply language filter (all required langs must be present)
4. Apply season filter for series (regex on `fulltitle`)
5. Check IMDB/TMDB ID exact match (most reliable)
6. Fall back to normalized title comparison

### For `/start/search` (search)

1. Type must match (movie/series)
2. Language filter (if entry has lang info)
3. IMDB/TMDB ID exact match (preferred — also used as search query)
4. Normalized title match (fallback: exact, contains, or reverse contains)
5. No quality/season filtering (not available at entry level)

### Search Query Strategy

When searching for a watchlist item, the query is built in priority order:
1. **IMDB ID** (e.g. `tt10548174`) — most reliable, returns exact match
2. **Title + Season** (e.g. `House of the Dragon S03`) — for series with specific season
3. **Title only** (e.g. `28 Years Later`) — fallback

IMDB IDs are preferred because the search API treats them as unique strings, while TMDB IDs are numeric and match as substrings (unreliable).

## Future Improvements

- [ ] Discover the entry detail API endpoint for download links
- [ ] Merge search-found entries with incremental-found releases (by `entry_id` or IMDB/TMDB ID)
- [ ] Implement Playwright fallback for detail page scraping
- [ ] Add notification system (webhook, email) when new matches are found
- [ ] Episode-aware notifications ("only alert for episodes > LastEpisodeFound")
