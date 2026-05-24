# warez.cx API Reference

> Reverse-engineered from the Vue.js SPA (`app.4b9668d9.js`). No official docs exist.

## Base URL

```
https://api.warez.cx
```

No authentication is required for read-only endpoints. The site uses Bearer tokens for logged-in features only (favorites, user profile, etc.).

## Common Headers

| Header | Value |
|---|---|
| `Accept` | `application/json` |
| `User-Agent` | Standard browser UA string |
| `Cookie` | Optional — only if session persistence is needed |

---

## Endpoints

### 1. `/start/release` — Release Feed (WarezMode)

Returns **individual releases** (uploads) with download links. This is the backend for the "WarezMode" page and the main feed.

#### Request

```
GET /start/release?page=1&per_page=50&sortBy=latest&sortOrder=desc&source=releases,next&types=movie,series&unique=false
```

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | int | 1 | Page number |
| `per_page` | int | 50 | Results per page (max observed: 50) |
| `sortBy` | string | `latest` | Sort field: `latest`, `popular`, `name` |
| `sortOrder` | string | `desc` | `asc` or `desc` |
| `source` | string | — | Comma-separated: `releases`, `next` |
| `types` | string | — | Comma-separated: `movie`, `series`, `game` |
| `unique` | bool | `false` | If true, groups releases by entry |
| `q` | string | — | ⚠ **Does NOT work** for search. Always returns latest regardless of value. |

#### Response

```jsonc
{
  "items": {
    "current_page": 1,
    "data": [ /* WarezRelease[] */ ],
    "first_page_url": "...",
    "from": 1,
    "last_page": 1234,
    "last_page_url": "...",
    "next_page_url": "...?page=2",
    "path": "/start/release",
    "per_page": 50,
    "prev_page_url": null,
    "to": 50,
    "total": 61700
  },
  "params": { ... }
}
```

#### WarezRelease Object

```typescript
{
  id: number;             // Unique release ID
  user_id: number;
  entry_id: number;       // FK to the parent media entry
  uid: string;            // URL-safe unique identifier
  title: string;          // Short title (e.g. "Breaking Bad")
  fulltitle: string;      // Full release name (e.g. "Breaking.Bad.S01.German.DL.1080p...")
  type: string;           // "movie" | "series" | "game"
  sub_type: string;       // "movie" | "series" | "episode" | "pcgames"
  links: Record<string, string[]>;      // File host → [download URLs]
  crypted_links: Record<string, string>; // File host → container URL
  size: number;           // Size in bytes
  parts: number;          // Number of parts
  group: string;          // Release group name
  quality: string | null; // "720p" | "1080p" | "2160p" | null
  lang: string[];         // ["GER", "ENG"]
  created_at: string;     // ISO datetime
  sort_date: string;
  has_new_episode: boolean;
  entry: {
    id: number;
    title: string;
    genre: string[];
    cover: string;
    uid: string;
    options: {
      imdb_id?: string;   // e.g. "tt0903747"
      tmdb_id?: number;   // e.g. 1396
      type?: string;
      title?: string;
      original_title?: string;
      description?: string;
    }
  }
}
```

**Key observations:**
- Each release has download `links` and `crypted_links`
- Series come as season packs (S01, S02) or individual episodes (S01E01)
- `has_new_episode: true` signals fresh episode drops
- Season/episode info is extracted from `fulltitle` via regex (`S\d{2}E?\d*`)

---

### 2. `/start/search` — Search (Entry-Level)

Returns **media entries** (titles/shows), NOT individual releases. This is the backend for the search page at `https://warez.cx/search`.

#### Request

```
GET /start/search?q=Breaking+Bad&page=1
```

| Param | Type | Default | Description |
|---|---|---|---|
| `q` | string | — | Search query (required) |
| `page` | int | 1 | Page number |

#### Response

Same pagination wrapper as `/start/release`, but `data` contains `WarezSearchEntry[]`:

```jsonc
{
  "items": {
    "current_page": 1,
    "data": [ /* WarezSearchEntry[] */ ],
    "last_page": 1,
    "total": 3,
    ...
  },
  "params": { ... }
}
```

#### WarezSearchEntry Object

```typescript
{
  id: number;
  uid: string;
  type: string;            // "movie" | "series" | "game"
  sub_type: string;
  title: string;           // Display title
  original_title: string;  // Original language title
  fulltitle: string;
  description: string;
  lang: string[];          // Can be null for some entries
  genre: string[];         // Can be null
  cover: string;           // Cover image URL
  rating: string;
  downloads: number;
  views: number;
  options: {
    imdb_id?: string;
    tmdb_id?: number;
    type?: string;
    description?: string;
    released_at?: string;
    runtime?: number;
  }
}
```

**Key differences from `/start/release`:**
- ❌ No `links` or `crypted_links` (no download URLs)
- ❌ No `quality`, `size`, `group` fields
- ✅ Has `description`, `original_title`, `rating`
- ✅ Has rich metadata via `options` (IMDB, TMDB, description)
- Returns media titles, not individual uploads (1 entry per movie/show)

---

### 3. `/start/d/:uid` — Entry Detail (All Releases)

Returns the **full entry** with all releases including download links, quality, codec, and episode info. This is the backend for the detail page at `https://warez.cx/detail/{uid}/{slug}`.

#### Request

```
GET /start/d/{uid}
```

No authentication required. `uid` is the entry-level UID from search results (e.g. `2okbWEppZrfL`), NOT a release UUID.

#### Response

```jsonc
{
  "__e": null,
  "__s": null,
  "cdn": true,
  "se": true,
  "item": {
    "id": 36402,
    "uid": "2okbWEppZrfL",
    "type": "movie",
    "sub_type": "movie",
    "title": "Extrawurst",
    "original_title": "Extrawurst",
    "lang": ["GER"],
    "genre": ["Komödie", "Drama"],
    "options": { /* WarezEntryOptions — imdb_id, tmdb_id, etc. */ },
    "releases": [ /* WarezDetailRelease[] */ ],
    "badges": [ /* quality/format badges */ ],
    // ... additional metadata (actors, backdrops, etc.)
  }
}
```

#### WarezDetailRelease Object

```typescript
{
  id: number;
  uid: string;               // Release UUID (NOT the entry UID)
  user_id: number;
  entry_id: number;
  title: string;
  fulltitle: string;         // "Movie.2026.German.1080p.WEB.H264-GROUP"
  type: string;
  sub_type: string;
  links: Record<string, string[]>;
  crypted_links: Record<string, string>;
  size: number;
  parts: number;
  group: string;
  quality: string | null;
  video_stream: string | null;
  video_codec: string | null;
  audio_stream: string | null;
  lang: string[] | null;
  downloads: number;
  source: string;
  options: {
    check?: Record<string, string>;  // Hoster online-check URLs (see below)
    season?: string | null;
    episode?: string | null;
    episode_count_in_season?: string | null;
  };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  display_priority: number;
  has_new_episode: boolean;
}
```

**Key observations:**
- Multiple releases per entry — different qualities, codecs, groups
- Multiple uploads of the same release by different users are "mirrors" (same fulltitle, different `user_id`)
- `episode_count_in_season` tracks total episodes for season packs
- ⚠ The release `uid` is a UUID (e.g. `371b57ed-...`), NOT the entry UID — do NOT use it for `/start/d/` lookups

---

### 4. Online/Offline Check — `hide.cx/state/:uuid`

Each release has per-hoster online status check URLs in `options.check`. The frontend loads these to display green/red status icons.

#### Request

```
GET https://hide.cx/state/{container-uuid}
```

#### Response

Returns an **SVG image** (not JSON):
- **Online**: SVG with `stroke="green"` (checkmark icon)
- **Offline**: SVG with `stroke="red"` (X icon)

#### Example

```json
"options": {
  "check": {
    "rapidgator.net": "https://hide.cx/state/2cdc450a-ca27-418d-a1b8-77e596d24a96",
    "ddownload.com": "https://hide.cx/state/2bf66411-3c3b-4018-a486-19204103c9ae"
  }
}
```

**Usage in enrichment scraper:**
- A release is considered "online" if **at least one** hoster returns `stroke="green"`
- Requests use a 5-second timeout; any timeout or unparsable response is treated as offline
- Only online hosters' links are stored in the match record

---

## Rate Limiting

No explicit rate limiting has been observed, but we implement a configurable delay (`SEARCH_DELAY_MS`, default 1500ms) between search queries to be respectful.

---

## CORS

The API does not set CORS headers. Requests must come from a server-side context (Node.js, not browser), which is why our scraper uses `fetch` directly.
