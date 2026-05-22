/**
 * Test script: NocoDB connectivity
 *
 * Validates that all three tables are reachable and readable.
 * Also does a quick write/read/cleanup cycle on the state table.
 *
 * Usage:
 *   npx ts-node src/scripts/test-nocodb.ts
 */

import { loadConfig } from '../config';
import { NocoDbClient } from '../nocodb/client';

async function main() {
  const config = loadConfig();
  const client = new NocoDbClient(config);

  console.log(`\n🔗 NocoDB: ${config.NOCODB_URL}\n`);

  // ── Watchlist ──────────────────────────────────────────────────────────────
  process.stdout.write('Checking watchlist table… ');
  const watchlist = await client.getActiveWatchlist();
  console.log(`✅  ${watchlist.length} active item(s)`);

  if (watchlist.length > 0) {
    console.log('\n  Active watchlist items:');
    for (const item of watchlist) {
      const qual = item.MinQuality ? ` | min: ${item.MinQuality}` : '';
      const lang = item.LangRequired ? ` | lang: ${item.LangRequired}` : '';
      const season = item.Season != null ? ` S${String(item.Season).padStart(2, '0')}` : '';
      const lastEp = item.LastEpisodeFound != null ? ` (last ep: E${String(item.LastEpisodeFound).padStart(2, '0')})` : '';
      const id = item.ImdbId ? ` (IMDB: ${item.ImdbId})` : item.TmdbId ? ` (TMDB: ${item.TmdbId})` : '';
      console.log(`    [${item.Id}] [${item.Type ?? '-'}] ${item.Title}${season}${lastEp}${id}${qual}${lang}`);
    }
    console.log();
  }

  // ── Matches ────────────────────────────────────────────────────────────────
  process.stdout.write('Checking matches table… ');
  // Use matchExistsByContent with a dummy record to confirm table is reachable
  await client.matchExistsByContent({ WarezId: -1, WarezUid: '', Title: '', Fulltitle: '', Type: '', MatchedAt: '', Status: 'new' });
  console.log('✅  reachable');

  // ── Scraper state ──────────────────────────────────────────────────────────
  process.stdout.write('Checking state table… ');
  const existing = await client.getState('last_incremental_run_at');
  console.log(`✅  last_incremental_run_at = ${existing ?? '(not set)'}`);

  // Write + read test
  process.stdout.write('State write/read test… ');
  const testKey = '__test__';
  const testVal = new Date().toISOString();
  await client.setState(testKey, testVal);
  const readBack = await client.getState(testKey);
  if (readBack !== testVal) {
    throw new Error(`State round-trip failed: wrote "${testVal}", read back "${readBack}"`);
  }
  // Cleanup: overwrite with empty (NocoDB doesn't have a delete-by-key convenience)
  await client.setState(testKey, '');
  console.log('✅');

  console.log('\n✅ All NocoDB checks passed.\n');
}

main().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
