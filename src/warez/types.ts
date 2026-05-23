/** Raw API response shape from warez.cx /start/release (individual uploads with download links) */

export interface WarezRelease {
  id: number;
  user_id: number;
  entry_id: number;
  uid: string;
  title: string;
  fulltitle: string;
  type: 'movie' | 'series' | 'game' | string;
  sub_type: 'movie' | 'series' | 'episode' | 'pcgames' | string;
  links: Record<string, string[]>;
  crypted_links: Record<string, string>;
  size: number;
  parts: number;
  group: string;
  options: unknown[];
  downloads: number;
  source: string;
  quality: string | null;
  video_stream: string | null;
  video_codec: string | null;
  audio_stream: string | null;
  bitrate: string | null;
  lang: string[] | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  episode_updated_at: string | null;
  sort_date: string;
  rn: number;
  has_new_episode: boolean;
  entry: WarezEntry;
}

export interface WarezEntry {
  id: number;
  title: string;
  genre: string[];
  cover: string;
  uid: string;
  options: WarezEntryOptions;
}

export interface WarezEntryOptions {
  imdb_id?: string;
  tmdb_id?: number;
  igdb_id?: number;
  type?: string;
  title?: string;
  original_title?: string;
  description?: string;
  cover?: string;
  released_at?: string;
  runtime?: number | null;
  source?: string;
  [key: string]: unknown;
}

export interface WarezApiResponse {
  items: {
    current_page: number;
    data: WarezRelease[];
    first_page_url: string;
    from: number;
    last_page: number;
    last_page_url: string;
    next_page_url: string | null;
    path: string;
    per_page: number;
    prev_page_url: string | null;
    to: number;
    total: number;
  };
  params: unknown;
}

export interface WarezFetchParams {
  q?: string;
  page?: number;
  per_page?: number;
  sortBy?: 'latest' | 'popular' | 'name';
  sortOrder?: 'asc' | 'desc';
  types?: string;
  source?: string;
  unique?: boolean;
}

// ─── Search API (/start/search) — entry-level results, no download links ─────

/** Entry-level search result from /start/search (media title, not an individual upload) */
export interface WarezSearchEntry {
  id: number;
  user_id: number;
  uid: string;
  type: 'movie' | 'series' | 'game' | string;
  sub_type: string;
  lang: string[] | null;
  tags: string | null;
  genre: string[];
  active: number;
  downloads: number;
  views: number;
  title: string;
  original_title: string;
  subtitle: string | null;
  fulltitle: string;
  description: string;
  time: string | null;
  cover: string;
  fsk: string | null;
  rating: string;
  source_type: string | null;
  source_id: string | null;
  options: WarezEntryOptions;
}

export interface WarezSearchResponse {
  items: {
    current_page: number;
    data: WarezSearchEntry[];
    first_page_url: string;
    from: number;
    last_page: number;
    last_page_url: string;
    next_page_url: string | null;
    path: string;
    per_page: number;
    prev_page_url: string | null;
    to: number;
    total: number;
  };
  params: unknown;
}

// ─── Detail API (/start/d/:uid) — full entry with all releases ───────────────

/** Individual release within a detail response (has download links, quality, etc.) */
export interface WarezDetailRelease {
  id: number;
  uid: string;
  user_id: number;
  entry_id: number;
  title: string;
  fulltitle: string;
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
  bitrate: string | null;
  lang: string[] | null;
  downloads: number;
  source: string;
  options: {
    check?: Record<string, string>;
    season?: string | null;
    episode?: string | null;
    episode_count_in_season?: string | null;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  episode_updated_at: string | null;
  has_new_episode: boolean;
  display_priority: number;
}

/** Full entry detail from /start/d/:uid */
export interface WarezEntryDetail {
  id: number;
  uid: string;
  type: string;
  sub_type: string;
  title: string;
  original_title: string;
  fulltitle: string;
  lang: string[] | null;
  genre: string[];
  options: WarezEntryOptions;
  releases: WarezDetailRelease[];
}

/** Response from /start/d/:uid */
export interface WarezDetailResponse {
  __e: unknown;
  __s: unknown;
  cdn: boolean;
  se: boolean;
  item: WarezEntryDetail;
}
