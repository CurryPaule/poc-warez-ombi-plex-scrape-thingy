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
import { findMatches, matchRelease } from '../matcher';

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
