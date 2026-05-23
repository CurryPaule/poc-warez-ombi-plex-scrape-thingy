import type { WarezRelease } from './warez/types';
import type { WatchlistRow } from './nocodb/types';

/** Quality tiers in ascending order */
const QUALITY_TIERS: Record<string, number> = {
  '720p': 1,
  '1080p': 2,
  '4k': 3,
  '2160p': 3,
};

/** Normalize a title for comparison: lowercase, replace separators with space, strip trailing year/junk */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[._\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the clean show/movie title from a warez fulltitle.
 * e.g. "Ladies.First.2026.German.DL.2160p.DV..." → "ladies first"
 * e.g. "Mating.Season.S01.GERMAN.DL..." → "mating season"
 */
export function extractTitleFromFulltitle(fulltitle: string): string {
  const normalized = normalizeTitle(fulltitle);

  // Cut off at common release markers
  const cutPatterns = [
    /\b\d{4}\b/,              // year (e.g. 2026)
    /\bs\d{2}\b/,             // season marker (e.g. s01)
    /\b(?:german|english|french|spanish|italian|dutch)\b/i,
    /\b(?:dl|multi)\b/i,
    /\b(?:720p|1080p|2160p|4k|uhd|hd|sd)\b/i,
    /\b(?:web|bluray|blu-ray|dvd|hdtv|webrip|hdcam)\b/i,
    /\b(?:h264|h265|x264|x265|hevc|avc|xvid)\b/i,
  ];

  let cutIdx = normalized.length;
  for (const pattern of cutPatterns) {
    const match = pattern.exec(normalized);
    if (match && match.index < cutIdx) {
      cutIdx = match.index;
    }
  }

  return normalized.slice(0, cutIdx).trim();
}

/** Check if a release matches the required quality exactly */
export function matchesQuality(releaseQuality: string | null, requiredQuality: string | undefined | null): boolean {
  if (!requiredQuality) return true;
  if (!releaseQuality) return false;

  const relTier = QUALITY_TIERS[releaseQuality.toLowerCase()] ?? 0;
  const reqTier = QUALITY_TIERS[requiredQuality.toLowerCase()] ?? 0;
  return relTier === reqTier;
}

/**
 * Known language tokens in warez fulltitles → normalized language codes.
 * "DL" (Dual Language) in German scene releases conventionally means GER + ENG.
 */
const FULLTITLE_LANG_MAP: Record<string, string[]> = {
  german: ['GER'],
  deutsch: ['GER'],
  english: ['ENG'],
  french: ['FRE'],
  spanish: ['SPA'],
  italian: ['ITA'],
  dutch: ['DUT'],
  japanese: ['JPN'],
  korean: ['KOR'],
  chinese: ['CHI'],
  russian: ['RUS'],
  portuguese: ['POR'],
  turkish: ['TUR'],
  arabic: ['ARA'],
  hindi: ['HIN'],
  dl: ['GER', 'ENG'],
  multi: ['GER', 'ENG'],
};

/**
 * Extract language codes from a release fulltitle.
 * Fallback when the API's `lang` array is null or empty.
 */
export function extractLangsFromFulltitle(fulltitle: string): string[] {
  const normalized = fulltitle.toLowerCase().replace(/[._\-]/g, ' ');
  const langs = new Set<string>();
  for (const [token, codes] of Object.entries(FULLTITLE_LANG_MAP)) {
    const pattern = new RegExp(`\\b${token}\\b`, 'i');
    if (pattern.test(normalized)) {
      for (const code of codes) langs.add(code);
    }
  }
  return [...langs];
}

/**
 * Check if a release includes all required languages.
 * Falls back to parsing languages from fulltitle when the API lang array is null/empty.
 */
export function meetsLanguage(
  releaseLangs: string[] | null | undefined,
  langRequired: string | undefined | null,
  fulltitle?: string,
): boolean {
  if (!langRequired) return true;
  const required = langRequired.split(',').map(l => l.trim().toUpperCase()).filter(Boolean);
  if (required.length === 0) return true;

  let available = (releaseLangs ?? []).map(l => l.toUpperCase());

  // Fallback: parse language from fulltitle when API lang is missing
  if (available.length === 0 && fulltitle) {
    available = extractLangsFromFulltitle(fulltitle).map(l => l.toUpperCase());
  }

  return required.every(req => available.includes(req));
}

/** Check if a release fulltitle contains all required tags (case-insensitive, AND logic) */
export function matchesTags(fulltitle: string, tags: string | string[] | undefined | null): boolean {
  if (!tags) return true;
  // NocoDB may return tags as a comma-separated string or as an array
  const required = (Array.isArray(tags) ? tags : tags.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  if (required.length === 0) return true;
  const ft = fulltitle.toLowerCase();
  return required.every(tag => ft.includes(tag));
}

/** Extract season number from fulltitle, e.g. "S02" → 2, null if not found */
export function extractSeason(fulltitle: string): number | null {
  const match = /\bS(\d{2})\b/i.exec(fulltitle);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

/** Extract episode number from fulltitle, e.g. "S02E05" → 5, null if not found or season pack */
export function extractEpisode(fulltitle: string): number | null {
  const match = /\bS\d{2}E(\d{2,3})\b/i.exec(fulltitle);
  if (!match) return null;
  return parseInt(match[1]!, 10);
}

/** Extract season + episode as a dedup key, e.g. "S02E05" → "S02E05", "S02" → "S02", null if none */
export function extractSeasonEpisodeKey(fulltitle: string): string | null {
  // Try S01E05 first
  const full = /\b(S\d{2}E\d{2,3})\b/i.exec(fulltitle);
  if (full) return full[1]!.toUpperCase();
  // Try season-only (season pack)
  const season = /\b(S\d{2})\b/i.exec(fulltitle);
  if (season) return season[1]!.toUpperCase();
  return null;
}

export interface MatchResult {
  matched: boolean;
  watchlistItem: WatchlistRow;
  reason?: string;
}

/**
 * Check if a warez release matches a watchlist item.
 * Priority: IMDB/TMDB ID exact match → normalized title match.
 */
export function matchRelease(release: WarezRelease, watchlistItem: WatchlistRow): MatchResult {
  const opts = release.entry?.options;

  // ── Type check ──────────────────────────────────────────────────────────────
  if (release.type !== watchlistItem.Type) {
    return { matched: false, watchlistItem, reason: 'type mismatch' };
  }

  // ── Quality filter ──────────────────────────────────────────────────────────
  if (!matchesQuality(release.quality, watchlistItem.Quality)) {
    return { matched: false, watchlistItem, reason: `quality ${release.quality} ≠ wanted ${watchlistItem.Quality}` };
  }

  // ── Language filter ─────────────────────────────────────────────────────────
  if (!meetsLanguage(release.lang, watchlistItem.LangRequired, release.fulltitle)) {
    return { matched: false, watchlistItem, reason: `missing required langs ${watchlistItem.LangRequired}` };
  }

  // ── Tags filter (all tags must appear in fulltitle) ─────────────────────────
  if (!matchesTags(release.fulltitle, watchlistItem.Tags)) {
    return { matched: false, watchlistItem, reason: `missing required tags ${watchlistItem.Tags}` };
  }

  // ── Season filter (series only) ─────────────────────────────────────────────
  if (watchlistItem.Type === 'series' && watchlistItem.Season != null) {
    const releaseSeason = extractSeason(release.fulltitle);
    if (releaseSeason !== null && releaseSeason !== watchlistItem.Season) {
      return { matched: false, watchlistItem, reason: `season ${releaseSeason} ≠ wanted ${watchlistItem.Season}` };
    }
  }

  // ── ID-based match (most reliable) ──────────────────────────────────────────
  if (watchlistItem.ImdbId && opts?.imdb_id) {
    if (opts.imdb_id === watchlistItem.ImdbId) {
      return { matched: true, watchlistItem, reason: 'imdb_id match' };
    }
    return { matched: false, watchlistItem, reason: 'imdb_id mismatch' };
  }

  if (watchlistItem.TmdbId && opts?.tmdb_id) {
    if (opts.tmdb_id === watchlistItem.TmdbId) {
      return { matched: true, watchlistItem, reason: 'tmdb_id match' };
    }
    return { matched: false, watchlistItem, reason: 'tmdb_id mismatch' };
  }

  // ── Title-based match (fallback) ─────────────────────────────────────────────
  const watchTitle = normalizeTitle(watchlistItem.Title);
  const releaseTitle = normalizeTitle(release.title);
  const extractedTitle = extractTitleFromFulltitle(release.fulltitle);

  if (releaseTitle === watchTitle || extractedTitle === watchTitle) {
    return { matched: true, watchlistItem, reason: 'title match' };
  }

  // Substring match: watchlist title contained in release title (handles subtitle/year variations)
  if (releaseTitle.includes(watchTitle) || watchTitle.includes(releaseTitle)) {
    return { matched: true, watchlistItem, reason: 'title substring match' };
  }

  return { matched: false, watchlistItem, reason: 'no title match' };
}

/** Find all watchlist items that match a given release */
export function findMatches(release: WarezRelease, watchlist: WatchlistRow[]): WatchlistRow[] {
  return watchlist
    .filter(item => matchRelease(release, item).matched);
}
