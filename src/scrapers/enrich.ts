import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow, WatchlistRow } from '../nocodb/types';
import type { WarezClient } from '../warez/api';
import type { WarezDetailRelease } from '../warez/types';
import type { Config } from '../config';
import {
  matchesQuality,
  meetsLanguage,
  matchesTags,
  extractSeason,
  extractEpisode,
  extractSeasonEpisodeKey,
} from '../matcher';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if a detail release matches a watchlist item's filters.
 * Applies Quality, Tags, Language, and Season checks.
 */
function releaseMatchesFilters(
  release: WarezDetailRelease,
  watchlistItem: WatchlistRow,
): boolean {
  if (!matchesQuality(release.quality, watchlistItem.Quality)) return false;
  if (!meetsLanguage(release.lang, watchlistItem.LangRequired)) return false;
  if (!matchesTags(release.fulltitle, watchlistItem.Tags)) return false;

  if (watchlistItem.Type === 'series' && watchlistItem.Season != null) {
    const releaseSeason = extractSeason(release.fulltitle);
    if (releaseSeason !== null && releaseSeason !== watchlistItem.Season) return false;
  }

  return true;
}

/**
 * Get the episode count from a detail release's options.
 */
function getEpisodeCount(release: WarezDetailRelease): number | null {
  const epCount = release.options?.episode_count_in_season;
  if (!epCount) return null;
  const count = parseInt(String(epCount), 10);
  return count > 0 ? count : null;
}

/**
 * Process a single match against available releases.
 * Returns true if the match was enriched/updated, false if skipped.
 */
async function processMatch(
  match: MatchRow & { Id: number },
  releases: WarezDetailRelease[],
  watchlistItem: WatchlistRow & { Id: number },
  nocodb: NocoDbClient,
  isRecheck: boolean,
): Promise<'enriched' | 'updated' | 'skipped'> {
  const matchingRelease = releases.find(r => releaseMatchesFilters(r, watchlistItem));

  if (!matchingRelease) {
    if (!isRecheck) {
      const filters = [
        watchlistItem.Quality ? `Q:${watchlistItem.Quality}` : null,
        watchlistItem.Tags ? `Tags:${watchlistItem.Tags}` : null,
        watchlistItem.LangRequired ? `Lang:${watchlistItem.LangRequired}` : null,
      ].filter(Boolean).join(', ');
      console.log(`  ⏳ No matching release for "${match.Title}" (filters: ${filters || 'none'})`);
    }
    return 'skipped';
  }

  const season = extractSeason(matchingRelease.fulltitle);
  let episode = extractEpisode(matchingRelease.fulltitle);
  let seasonEpisodeKey = extractSeasonEpisodeKey(matchingRelease.fulltitle);

  // For season packs, use episode_count_in_season
  if (watchlistItem.Type === 'series' && episode == null) {
    const count = getEpisodeCount(matchingRelease);
    if (count != null) {
      // For re-checks, compare against the match's stored episode (detect new eps since last enrichment).
      // For initial enrichment, compare against the watchlist's LastEpisodeFound.
      const lastEp = isRecheck
        ? (match.Episode ?? 0)
        : (watchlistItem.LastEpisodeFound ?? 0);
      if (count <= lastEp) {
        if (!isRecheck) {
          console.log(`  ⏩ No new episodes: "${matchingRelease.fulltitle}" — ${count} ep(s), last found: ${lastEp}`);
        }
        return 'skipped';
      }
      episode = count;
      seasonEpisodeKey = seasonEpisodeKey
        ? `${seasonEpisodeKey}E${String(count).padStart(2, '0')}`
        : `E${String(count).padStart(2, '0')}`;
    }
  }

  // For individual episodes, skip if not higher than LastEpisodeFound
  if (watchlistItem.Type === 'series' && episode != null) {
    const lastEp = isRecheck
      ? (match.Episode ?? 0)
      : (watchlistItem.LastEpisodeFound ?? 0);
    if (episode <= lastEp) {
      if (!isRecheck) {
        console.log(`  ⏩ Old episode: "${matchingRelease.fulltitle}" — E${String(episode).padStart(2, '0')}, last found: E${String(lastEp).padStart(2, '0')}`);
      }
      return 'skipped';
    }
  }

  await nocodb.updateMatchRelease(match.Id, {
    WarezId: matchingRelease.id,
    Fulltitle: matchingRelease.fulltitle,
    Quality: matchingRelease.quality ?? '',
    Lang: JSON.stringify(matchingRelease.lang),
    Links: JSON.stringify(matchingRelease.links),
    CryptedLinks: JSON.stringify(matchingRelease.crypted_links),
    SizeBytes: matchingRelease.size,
    ReleaseGroup: matchingRelease.group,
    Season: season ?? undefined,
    Episode: episode ?? undefined,
    SeasonEpisodeKey: seasonEpisodeKey ?? undefined,
    WarezCreatedAt: matchingRelease.created_at,
    Status: 'matched',
  });

  await nocodb.updateWatchlistLastMatched(watchlistItem.Id, new Date().toISOString());

  if (episode != null && watchlistItem.Type === 'series') {
    const current = watchlistItem.LastEpisodeFound ?? 0;
    if (episode > current) {
      await nocodb.updateWatchlistEpisode(watchlistItem.Id, episode);
    }
  }

  if (watchlistItem.Type === 'movie' && watchlistItem.DeactivateOnMatch) {
    await nocodb.deactivateWatchlistItem(watchlistItem.Id);
    console.log(`  🔕 Deactivated: "${watchlistItem.Title}" (DeactivateOnMatch)`);
  }

  return isRecheck ? 'updated' : 'enriched';
}

/**
 * Enrichment scraper:
 * 1. Processes "found" matches — applies Quality/Tags/Language filters, promotes to "matched"
 * 2. Re-checks "matched" series — detects new episodes via episode_count_in_season
 */
export async function runEnrichScraper(
  warez: WarezClient,
  nocodb: NocoDbClient,
  config: Config,
): Promise<void> {
  console.log('▶ Enrichment scraper starting...');

  // Phase 1: Enrich "found" matches
  const foundMatches = await nocodb.getMatchesByStatus('found');

  // Phase 2: Re-check "matched" series for new episodes
  const matchedAll = await nocodb.getMatchesByStatus('matched');
  const matchedSeries = matchedAll.filter(m => m.Type === 'series');

  const allMatches = [
    ...foundMatches.map(m => ({ match: m, isRecheck: false })),
    ...matchedSeries.map(m => ({ match: m, isRecheck: true })),
  ];

  console.log(`  Found: ${foundMatches.length} to enrich, ${matchedSeries.length} series to re-check`);

  if (allMatches.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  // Group by WarezUid to avoid duplicate API calls
  const byUid = new Map<string, { match: MatchRow & { Id: number }; isRecheck: boolean }[]>();
  for (const entry of allMatches) {
    const uid = entry.match.WarezUid;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(entry);
  }

  // Pre-load watchlist items
  const watchlistCache = new Map<number, WatchlistRow & { Id: number }>();
  for (const entry of allMatches) {
    const wid = entry.match.WatchlistId;
    if (wid && !watchlistCache.has(wid)) {
      const item = await nocodb.getWatchlistItemById(wid);
      if (item) watchlistCache.set(wid, item);
    }
  }

  let enriched = 0;
  let updated = 0;
  let skipped = 0;

  for (const [uid, entries] of byUid) {
    const label = entries[0]!.isRecheck ? '🔄' : '📦';
    console.log(`  ${label} Fetching detail for: ${entries[0]!.match.Title} (${uid})`);

    let releases: WarezDetailRelease[];
    try {
      const detail = await warez.fetchEntryDetail(uid);
      releases = detail.releases ?? [];
      console.log(`     → ${releases.length} release(s) available`);
    } catch (err) {
      console.error(`  ⚠ Detail fetch failed for "${uid}":`, err);
      await sleep(config.SEARCH_DELAY_MS);
      continue;
    }

    for (const { match, isRecheck } of entries) {
      if (!match.WatchlistId) {
        skipped++;
        continue;
      }

      const watchlistItem = watchlistCache.get(match.WatchlistId);
      if (!watchlistItem) {
        skipped++;
        continue;
      }

      const result = await processMatch(match, releases, watchlistItem, nocodb, isRecheck);
      if (result === 'enriched') {
        enriched++;
        console.log(`  ✅ Enriched: [${watchlistItem.Title}] ← "${match.Title}" (${releases.find(r => releaseMatchesFilters(r, watchlistItem))?.quality})`);
      } else if (result === 'updated') {
        updated++;
        console.log(`  🆕 New episodes: [${watchlistItem.Title}] — updated with latest release data`);
      } else {
        skipped++;
      }
    }

    await sleep(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Enrichment done. Enriched: ${enriched}, Updated: ${updated}, Skipped: ${skipped}`);
}
