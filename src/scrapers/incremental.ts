import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow, WatchlistRow } from '../nocodb/types';
import type { WarezClient } from '../warez/api';
import type { WarezRelease } from '../warez/types';
import { findMatches, extractSeason, extractEpisode, extractSeasonEpisodeKey } from '../matcher';
import type { Config } from '../config';

const STATE_KEY = 'last_incremental_run_at';

/** Detect and warn about releases whose IMDB/TMDB ID matches a watchlist item with a different type */
function warnTypeMismatches(release: WarezRelease, watchlist: WatchlistRow[], warned: Set<string>): void {
  const opts = release.entry?.options;
  for (const w of watchlist) {
    if (w.Type === release.type) continue;

    let idMatch: string | null = null;
    if (w.ImdbId && opts?.imdb_id && w.ImdbId === opts.imdb_id) {
      idMatch = `IMDB: ${w.ImdbId}`;
    } else if (w.TmdbId && opts?.tmdb_id && w.TmdbId === opts.tmdb_id) {
      idMatch = `TMDB: ${w.TmdbId}`;
    }

    if (idMatch) {
      const key = `${w.Title}:${idMatch}`;
      if (!warned.has(key)) {
        warned.add(key);
        console.log(`  ⚠️  Type mismatch: "${w.Title}" is "${w.Type}" in watchlist but "${release.type}" in feed (${idMatch})`);
        console.log(`      → Update the watchlist Type to "${release.type}" to enable matching`);
      }
    }
  }
}

/**
 * Incremental scraper: fetch all new releases since the last run and match
 * them against the active watchlist.
 */
export async function runIncrementalScraper(
  warez: WarezClient,
  nocodb: NocoDbClient,
  config: Config,
): Promise<void> {
  console.log('▶ Incremental scraper starting...');

  // Load last-run checkpoint
  const lastRunAt = await nocodb.getState(STATE_KEY);
  const lastRunTs = lastRunAt ? new Date(lastRunAt).getTime() : 0;
  console.log(`  Last run: ${lastRunAt ?? 'never (full scan)'}`);

  // Load active watchlist once
  const watchlist = await nocodb.getActiveWatchlist();
  console.log(`  Watchlist: ${watchlist.length} active item(s)`);

  if (watchlist.length === 0) {
    console.log('  No active watchlist items — nothing to do.');
    return;
  }

  let totalChecked = 0;
  let totalMatched = 0;
  const runStartTs = new Date().toISOString();
  const typeMismatchWarned = new Set<string>();

  // The feed is sorted by sort_date (which bumps when episodes are added to
  // season packs), NOT by created_at. Use sort_date for the pagination cutoff
  // so we don't stop early when updated series appear at the top of the feed.
  const stopCondition = (batch: WarezRelease[]): boolean => {
    return batch.every(r => new Date(r.sort_date).getTime() <= lastRunTs);
  };

  const releaseStream = warez.streamReleases(
    {
      sortBy: 'latest',
      sortOrder: 'desc',
      source: 'releases,next',
      per_page: 50,
      unique: false,
    },
    lastRunTs > 0 ? stopCondition : undefined,
    config.MAX_INCREMENTAL_PAGES,
  );

  for await (const batch of releaseStream) {
    for (const release of batch) {
      // Skip non-media
      if (release.type !== 'movie' && release.type !== 'series') continue;

      // Skip releases whose sort_date is before our last run
      if (lastRunTs > 0 && new Date(release.sort_date).getTime() <= lastRunTs) {
        continue;
      }

      totalChecked++;
      warnTypeMismatches(release, watchlist, typeMismatchWarned);
      const matched = findMatches(release, watchlist);

      for (const watchlistItem of matched) {
        const season = extractSeason(release.fulltitle);
        const episode = extractEpisode(release.fulltitle);
        const seasonEpisodeKey = extractSeasonEpisodeKey(release.fulltitle);

        const match: Omit<MatchRow, 'Id'> = {
          WatchlistId: watchlistItem.Id,
          WarezId: release.id,
          WarezUid: release.uid,
          Title: release.title,
          Fulltitle: release.fulltitle,
          Type: release.type,
          Season: season ?? undefined,
          Episode: episode ?? undefined,
          SeasonEpisodeKey: seasonEpisodeKey ?? undefined,
          Quality: release.quality ?? '',
          Lang: JSON.stringify(release.lang),
          Links: JSON.stringify(release.links),
          CryptedLinks: JSON.stringify(release.crypted_links),
          SizeBytes: release.size,
          ReleaseGroup: release.group,
          ImdbId: release.entry?.options?.imdb_id ?? '',
          TmdbId: release.entry?.options?.tmdb_id ?? 0,
          WarezCreatedAt: release.created_at,
          MatchedAt: new Date().toISOString(),
          Status: 'new',
        };

        const isNew = await nocodb.upsertMatch(match);
        if (!isNew) {
          console.log(`  ⏩ Skipped (already exists): "${release.fulltitle}"${seasonEpisodeKey ? ` (${seasonEpisodeKey})` : ''}`);
          continue;
        }

        await nocodb.updateWatchlistLastMatched(watchlistItem.Id, match.MatchedAt);

        // Track highest episode found for series
        if (episode != null && watchlistItem.Type === 'series') {
          const current = watchlistItem.LastEpisodeFound ?? 0;
          if (episode > current) {
            await nocodb.updateWatchlistEpisode(watchlistItem.Id, episode);
          }
        }

        // Auto-deactivate movie watchlist items on first match
        if (watchlistItem.Type === 'movie' && watchlistItem.DeactivateOnMatch) {
          await nocodb.deactivateWatchlistItem(watchlistItem.Id);
          console.log(`  🔕 Deactivated: "${watchlistItem.Title}" (DeactivateOnMatch)`);
        }

        totalMatched++;
        console.log(`  ✅ Match: [${watchlistItem.Title}] ← "${release.fulltitle}"${seasonEpisodeKey ? ` (${seasonEpisodeKey})` : ''}`);
      }
    }
  }

  // Update checkpoint
  await nocodb.setState(STATE_KEY, runStartTs);
  console.log(`✔ Incremental done. Checked: ${totalChecked}, Matched: ${totalMatched}`);
}
