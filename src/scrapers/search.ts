import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow, WatchlistRow } from '../nocodb/types';
import type { WarezClient } from '../warez/api';
import type { WarezSearchEntry } from '../warez/types';
import type { Config } from '../config';
import {
  normalizeTitle,
  matchesQuality,
  meetsLanguage,
  matchesTags,
} from '../matcher';

/**
 * Build the search query for a watchlist item.
 * For series with a specific season, include the season marker.
 */
function buildSearchQuery(item: WatchlistRow): string {
  // Prefer IMDB ID for precise search when available
  if (item.ImdbId) return item.ImdbId;
  if (item.Type === 'series' && item.Season != null) {
    const s = String(item.Season).padStart(2, '0');
    return `${item.Title} S${s}`;
  }
  return item.Title;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if a search entry matches a watchlist item.
 * Reuses shared filter functions from matcher.ts.
 *
 * Note: search entries are entry-level (no quality, no release-specific fulltitle),
 * so items with Quality or Tags set will not match via search — those require
 * the incremental scraper which has release-level detail.
 */
function entryMatchesWatchlistItem(entry: WarezSearchEntry, item: WatchlistRow): boolean {
  // Type must match
  if (item.Type && entry.type !== item.Type) return false;

  // Quality filter — search entries have no quality info, so if a specific
  // quality is required, we can't verify it and must skip
  if (!matchesQuality(null, item.Quality)) return false;

  // Language filter
  if (!meetsLanguage(entry.lang ?? [], item.LangRequired)) return false;

  // Tags filter — search entry fulltitles are just titles (e.g. "Dutton Ranch"),
  // not release names, so tags like HDR/H265/uploader won't match
  if (!matchesTags(entry.fulltitle, item.Tags)) return false;

  // ID-based match (most reliable)
  if (item.ImdbId && entry.options?.imdb_id) {
    return entry.options.imdb_id === item.ImdbId;
  }
  if (item.TmdbId && entry.options?.tmdb_id) {
    return Number(entry.options.tmdb_id) === item.TmdbId;
  }

  // Title-based match
  const watchTitle = normalizeTitle(item.Title);
  const entryTitle = normalizeTitle(entry.title);
  const entryOriginal = normalizeTitle(entry.original_title || '');

  return entryTitle === watchTitle
    || entryOriginal === watchTitle
    || entryTitle.includes(watchTitle)
    || watchTitle.includes(entryTitle);
}

/**
 * Search-based scraper: for each active watchlist item, query the warez
 * search API (/start/search) and write any matches to the matches table.
 *
 * Note: Search results are entry-level (no download links).
 * Download links come from the incremental scraper or future Playwright detail scraping.
 */
export async function runSearchScraper(
  warez: WarezClient,
  nocodb: NocoDbClient,
  config: Config,
): Promise<void> {
  console.log('▶ Search scraper starting...');

  const watchlist = await nocodb.getActiveWatchlist();
  console.log(`  Watchlist: ${watchlist.length} active item(s)`);

  if (watchlist.length === 0) {
    console.log('  No active watchlist items — nothing to do.');
    return;
  }

  let totalMatched = 0;

  for (const item of watchlist) {
    const query = buildSearchQuery(item);
    console.log(`  🔍 Searching: "${query}" (${item.Type ?? 'any'})`);

    let entries: WarezSearchEntry[];
    try {
      entries = await warez.searchEntries(query);
    } catch (err) {
      console.error(`  ⚠ Search failed for "${query}":`, err);
      await sleep(config.SEARCH_DELAY_MS);
      continue;
    }

    console.log(`     → ${entries.length} result(s)`);

    const matched = entries.filter(e => entryMatchesWatchlistItem(e, item));

    for (const entry of matched) {
      const matchRecord: Omit<MatchRow, 'Id'> = {
        WatchlistId: item.Id,
        WarezId: entry.id,
        WarezUid: entry.uid,
        Title: entry.title,
        Fulltitle: entry.fulltitle,
        Type: entry.type,
        Quality: '',
        Lang: JSON.stringify(entry.lang),
        Links: '{}',
        CryptedLinks: '{}',
        SizeBytes: 0,
        ReleaseGroup: '',
        ImdbId: entry.options?.imdb_id ?? '',
        TmdbId: Number(entry.options?.tmdb_id) || 0,
        WarezCreatedAt: '',
        MatchedAt: new Date().toISOString(),
        Status: 'new',
      };

      const isNew = await nocodb.upsertMatch(matchRecord);
      if (!isNew) {
        console.log(`  ⏩ Skipped (already exists): "${entry.title}"`);
        continue;
      }

      await nocodb.updateWatchlistLastMatched(item.Id, matchRecord.MatchedAt);
      totalMatched++;
      console.log(`  ✅ Match: [${item.Title}] ← "${entry.title}" (${entry.type}, IMDB: ${entry.options?.imdb_id ?? 'n/a'})`);
    }

    await sleep(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Search done. Total new matches: ${totalMatched}`);
}
