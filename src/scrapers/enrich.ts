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
 * Applies Quality, Tags, and Language checks.
 */
function releaseMatchesFilters(
  release: WarezDetailRelease,
  watchlistItem: WatchlistRow,
): boolean {
  if (!matchesQuality(release.quality, watchlistItem.Quality)) return false;
  if (!meetsLanguage(release.lang, watchlistItem.LangRequired)) return false;
  if (!matchesTags(release.fulltitle, watchlistItem.Tags)) return false;

  // Season filter
  if (watchlistItem.Type === 'series' && watchlistItem.Season != null) {
    const releaseSeason = extractSeason(release.fulltitle);
    if (releaseSeason !== null && releaseSeason !== watchlistItem.Season) return false;
  }

  return true;
}

/**
 * Enrichment scraper: fetches detail data for "found" matches from the search
 * scraper, applies Quality/Tags/Language filters against individual releases,
 * and promotes matching records to "matched" status with full release data.
 */
export async function runEnrichScraper(
  warez: WarezClient,
  nocodb: NocoDbClient,
  config: Config,
): Promise<void> {
  console.log('▶ Enrichment scraper starting...');

  const foundMatches = await nocodb.getMatchesByStatus('found');
  console.log(`  Found matches to enrich: ${foundMatches.length}`);

  if (foundMatches.length === 0) {
    console.log('  No matches to enrich — nothing to do.');
    return;
  }

  // Group matches by WarezUid to avoid duplicate API calls for the same entry
  const byUid = new Map<string, (MatchRow & { Id: number })[]>();
  for (const match of foundMatches) {
    const uid = match.WarezUid;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid)!.push(match);
  }

  // Pre-load watchlist items for all matches
  const watchlistCache = new Map<number, WatchlistRow & { Id: number }>();
  for (const match of foundMatches) {
    if (match.WatchlistId && !watchlistCache.has(match.WatchlistId)) {
      const item = await nocodb.getWatchlistItemById(match.WatchlistId);
      if (item) watchlistCache.set(match.WatchlistId, item);
    }
  }

  let enriched = 0;
  let skipped = 0;

  for (const [uid, matches] of byUid) {
    console.log(`  📦 Fetching detail for: ${matches[0]!.Title} (${uid})`);

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

    for (const match of matches) {
      if (!match.WatchlistId) {
        console.log(`  ⏩ Skipped match ${match.Id}: no WatchlistId`);
        skipped++;
        continue;
      }

      const watchlistItem = watchlistCache.get(match.WatchlistId);
      if (!watchlistItem) {
        console.log(`  ⏩ Skipped match ${match.Id}: watchlist item ${match.WatchlistId} not found`);
        skipped++;
        continue;
      }

      // Find the first release that matches all filters
      const matchingRelease = releases.find(r => releaseMatchesFilters(r, watchlistItem));

      if (!matchingRelease) {
        const filters = [
          watchlistItem.Quality ? `Q:${watchlistItem.Quality}` : null,
          watchlistItem.Tags ? `Tags:${watchlistItem.Tags}` : null,
          watchlistItem.LangRequired ? `Lang:${watchlistItem.LangRequired}` : null,
        ].filter(Boolean).join(', ');
        console.log(`  ⏳ No matching release for "${match.Title}" (filters: ${filters || 'none'})`);
        skipped++;
        continue;
      }

      const season = extractSeason(matchingRelease.fulltitle);
      let episode = extractEpisode(matchingRelease.fulltitle);
      let seasonEpisodeKey = extractSeasonEpisodeKey(matchingRelease.fulltitle);

      // For season packs, use episode_count_in_season from the detail release
      if (watchlistItem.Type === 'series' && episode == null) {
        const epCount = matchingRelease.options?.episode_count_in_season;
        if (epCount) {
          const count = parseInt(String(epCount), 10);
          if (count > 0) {
            const lastEp = watchlistItem.LastEpisodeFound ?? 0;
            if (count <= lastEp) {
              console.log(`  ⏩ Skipped (no new episodes): "${matchingRelease.fulltitle}" — ${count} ep(s), last found: ${lastEp}`);
              skipped++;
              continue;
            }
            episode = count;
            seasonEpisodeKey = seasonEpisodeKey
              ? `${seasonEpisodeKey}E${String(count).padStart(2, '0')}`
              : `E${String(count).padStart(2, '0')}`;
          }
        }
      }

      // For individual episodes, skip if not higher than LastEpisodeFound
      if (watchlistItem.Type === 'series' && episode != null) {
        const lastEp = watchlistItem.LastEpisodeFound ?? 0;
        if (episode <= lastEp) {
          console.log(`  ⏩ Skipped (old episode): "${matchingRelease.fulltitle}" — E${String(episode).padStart(2, '0')}, last found: E${String(lastEp).padStart(2, '0')}`);
          skipped++;
          continue;
        }
      }

      await nocodb.updateMatchRelease(match.Id, {
        WarezId: matchingRelease.id,
        // Keep WarezUid as the entry UID (not the release UUID) for future detail API calls
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

      // Track highest episode found for series
      if (episode != null && watchlistItem.Type === 'series') {
        const current = watchlistItem.LastEpisodeFound ?? 0;
        if (episode > current) {
          await nocodb.updateWatchlistEpisode(watchlistItem.Id, episode);
        }
      }

      // Auto-deactivate movie watchlist items on match
      if (watchlistItem.Type === 'movie' && watchlistItem.DeactivateOnMatch) {
        await nocodb.deactivateWatchlistItem(watchlistItem.Id);
        console.log(`  🔕 Deactivated: "${watchlistItem.Title}" (DeactivateOnMatch)`);
      }

      enriched++;
      console.log(`  ✅ Enriched: [${watchlistItem.Title}] ← "${matchingRelease.fulltitle}" (${matchingRelease.quality})`);
    }

    await sleep(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Enrichment done. Enriched: ${enriched}, Skipped: ${skipped}`);
}
