/** NocoDB v3 API types — field names match actual NocoDB column names (PascalCase) */

// ─── Watchlist ────────────────────────────────────────────────────────────────

export interface WatchlistRow {
  Id: number;
  Title: string;
  Type?: 'movie' | 'series';
  ImdbId?: string;
  TmdbId?: number;
  Active: boolean | number;       // NocoDB checkbox = 0/1
  DeactivateOnMatch: boolean | number;
  Quality?: '720p' | '1080p' | '2160p' | '';
  LangRequired?: string;          // comma-separated, e.g. "GER,ENG"
  Tags?: string;                  // comma-separated, e.g. "HDR,H265,iSSEYMiYAKE" — all must match in fulltitle
  Season?: number;                // null = any season
  LastEpisodeFound?: number;      // highest episode number matched so far
  LastMatchedAt?: string;
  Notes?: string;
  CreatedAt?: string;
  UpdatedAt?: string;
}

// ─── Matches ──────────────────────────────────────────────────────────────────

export interface MatchRow {
  Id?: number;
  WatchlistId?: number;
  WarezId: number;
  WarezUid: string;
  Title: string;
  Fulltitle: string;
  Type: string;
  Season?: number;           // extracted season number
  Episode?: number;          // extracted episode number
  SeasonEpisodeKey?: string; // e.g. "S02E05" or "S02" for dedup
  Quality?: string;
  Lang?: string;             // JSON array serialized as string
  Links?: string;            // JSON object serialized as string
  CryptedLinks?: string;
  SizeBytes?: number;
  ReleaseGroup?: string;
  ImdbId?: string;
  TmdbId?: number;
  WarezCreatedAt?: string;
  MatchedAt: string;
  Status: 'new' | 'notified' | 'processed';
  CreatedAt?: string;
  UpdatedAt?: string;
}

// ─── Scraper State ────────────────────────────────────────────────────────────

export interface ScraperStateRow {
  Id?: number;
  Key: string;
  Value: string;
  CreatedAt?: string;
  UpdatedAt?: string;
}

// ─── NocoDB v3 response shapes ────────────────────────────────────────────────

export interface NocoDbV3Record<T> {
  id: number;
  id_fields: Record<string, unknown>;
  fields: T;
}

export interface NocoDbV3ListResponse<T> {
  records: NocoDbV3Record<T>[];
  next?: string;
  prev?: string;
  nestedNext?: unknown;
}

// Legacy alias kept for reference
export type NocoDbListResponse<T> = NocoDbV3ListResponse<T>;
