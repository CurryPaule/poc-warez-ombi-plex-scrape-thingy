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

### 3. Detail Page (Unknown API endpoint)

The SPA detail page at `https://warez.cx/detail/{uid}/{slug}` shows all releases for a specific media entry. This loads releases with download links for a single entry.

**Status: Endpoint not yet discovered.** The detail page is loaded via a lazy-loaded JS chunk, making the API call difficult to trace statically. Playwright browser interception is needed to discover the exact endpoint.

**Tested and failed:**
- `/entry/{uid}` — 404
- `/start/entry/{uid}` — 404
- `/start/detail/{uid}` — 404
- `/release?entry_id={id}` — 404

---

## Rate Limiting

No explicit rate limiting has been observed, but we implement a configurable delay (`SEARCH_DELAY_MS`, default 1500ms) between search queries to be respectful.

---

## CORS

The API does not set CORS headers. Requests must come from a server-side context (Node.js, not browser), which is why our scraper uses `fetch` directly.
