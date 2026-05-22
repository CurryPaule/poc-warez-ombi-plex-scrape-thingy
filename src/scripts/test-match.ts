/**
 * Test script: dry-run matcher against live data
 *
 * Loads the active watchlist from NocoDB, fetches the latest releases from
 * warez.cx, and prints what would be matched — without writing anything.
 *
 * Usage:
 *   npx ts-node src/scripts/test-match.ts
 *   npx ts-node src/scripts/test-match.ts --pages 3
 */

import { loadConfig } from '../config';
import { NocoDbClient } from '../nocodb/client';
import { WarezClient } from '../warez/api';
import type { WarezRelease } from '../warez/types';
import type { WatchlistRow } from '../nocodb/types';
import { findMatches, matchRelease } from '../matcher';

interface TypeMismatch {
  releaseFulltitle: string;
  releaseType: string;
  watchlistTitle: string;
  watchlistType: string;
  idType: 'imdb' | 'tmdb';
  idValue: string;
}

/** Detect watchlist items that share an IMDB/TMDB ID with a release but have the wrong type */
function detectTypeMismatches(release: WarezRelease, watchlist: WatchlistRow[]): TypeMismatch[] {
  const mismatches: TypeMismatch[] = [];
  const opts = release.entry?.options;

  for (const w of watchlist) {
    if (w.Type === release.type) continue;

    if (w.ImdbId && opts?.imdb_id && w.ImdbId === opts.imdb_id) {
      mismatches.push({
        releaseFulltitle: release.fulltitle,
        releaseType: release.type,
        watchlistTitle: w.Title,
        watchlistType: w.Type ?? 'unknown',
        idType: 'imdb',
        idValue: w.ImdbId,
      });
    } else if (w.TmdbId && opts?.tmdb_id && w.TmdbId === opts.tmdb_id) {
      mismatches.push({
        releaseFulltitle: release.fulltitle,
        releaseType: release.type,
        watchlistTitle: w.Title,
        watchlistType: w.Type ?? 'unknown',
        idType: 'tmdb',
        idValue: String(w.TmdbId),
      });
    }
  }
  return mismatches;
}

async function main() {
  const args = process.argv.slice(2);
  const pagesIdx = args.indexOf('--pages');
  const maxPages = pagesIdx !== -1 ? parseInt(args[pagesIdx + 1] ?? '1', 10) : 1;

  const config = loadConfig();
  const nocodb = new NocoDbClient(config);
  const warez = new WarezClient(config);

  console.log(`\n🧪 Dry-run match test (pages: ${maxPages})\n`);

  // Load watchlist
  const watchlist = await nocodb.getActiveWatchlist();
  if (watchlist.length === 0) {
    console.log('⚠  No active watchlist items — add some items first.');
    return;
  }
  console.log(`Watchlist: ${watchlist.length} active item(s)`);
  for (const item of watchlist) {
    const id = item.ImdbId ? `IMDB:${item.ImdbId}` : item.TmdbId ? `TMDB:${item.TmdbId}` : 'no ID';
    console.log(`  [${item.Id}] [${item.Type ?? '-'}] ${item.Title} (${id})`);
  }
  console.log();

  // Fetch releases and dry-run match
  let totalChecked = 0;
  const matchSummary: Array<{ release: string; watchlistTitle: string; reason: string }> = [];
  const nearMisses: Array<{ release: string; watchlistTitle: string; reason: string }> = [];
  // Deduplicate type mismatches by watchlist title (only show once per item)
  const typeMismatchMap = new Map<string, TypeMismatch>();

  const stream = warez.streamReleases(
    { sortBy: 'latest', sortOrder: 'desc', source: 'releases,next', per_page: 50 },
    undefined,
    maxPages,
  );

  for await (const batch of stream) {
    for (const release of batch) {
      if (release.type !== 'movie' && release.type !== 'series') continue;
      totalChecked++;

      const matched = findMatches(release, watchlist);
      for (const w of matched) {
        matchSummary.push({ release: release.fulltitle, watchlistTitle: w.Title, reason: '' });
      }

      // Detect type mismatches (IMDB/TMDB ID matches but wrong type)
      for (const tm of detectTypeMismatches(release, watchlist)) {
        const key = `${tm.watchlistTitle}:${tm.idValue}`;
        if (!typeMismatchMap.has(key)) {
          typeMismatchMap.set(key, tm);
        }
      }

      // Show near-misses: same type, no quality/lang block, but title didn't match
      if (matched.length === 0) {
        for (const w of watchlist) {
          if (w.Type !== release.type) continue;
          const result = matchRelease(release, w);
          if (!result.matched && result.reason && !result.reason.includes('type mismatch')) {
            nearMisses.push({
              release: release.fulltitle,
              watchlistTitle: w.Title,
              reason: result.reason,
            });
          }
        }
      }
    }
  }

  console.log(`Checked ${totalChecked} media releases across ${maxPages} page(s).\n`);

  // Type mismatches are shown first — they're the most actionable
  if (typeMismatchMap.size > 0) {
    console.log(`⚠️  Type mismatches (${typeMismatchMap.size}) — ID matches but wrong type in watchlist:`);
    for (const tm of typeMismatchMap.values()) {
      console.log(`  "${tm.watchlistTitle}" is [${tm.watchlistType}] in watchlist but [${tm.releaseType}] in feed (${tm.idType}: ${tm.idValue})`);
      console.log(`    → Change the watchlist Type to "${tm.releaseType}" to enable matching`);
      console.log(`    e.g. ${tm.releaseFulltitle}`);
    }
    console.log();
  }

  if (matchSummary.length === 0) {
    console.log('No matches found in this batch.');
  } else {
    console.log(`✅ Matches (${matchSummary.length}):`);
    for (const m of matchSummary) {
      console.log(`  [${m.watchlistTitle}] ← ${m.release}`);
    }
  }

  if (nearMisses.length > 0) {
    const shown = nearMisses.slice(0, 10);
    console.log(`\n📋 Near-misses (same type, failed for other reason) — first ${shown.length}:`);
    for (const m of shown) {
      console.log(`  [${m.watchlistTitle}] ✗ ${m.release}`);
      console.log(`    reason: ${m.reason}`);
    }
  }

  console.log('\n(Dry run — nothing was written to NocoDB)');
}

main().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
