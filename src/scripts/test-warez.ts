/**
 * Test script: warez.cx API connectivity
 *
 * Validates that the warez API is reachable and returns parseable data.
 *
 * Usage:
 *   npx ts-node src/scripts/test-warez.ts
 *   npx ts-node src/scripts/test-warez.ts --search "Breaking Bad"
 *   npx ts-node src/scripts/test-warez.ts --search "Breaking Bad" --type series
 */

import { loadConfig } from '../config';
import { WarezClient } from '../warez/api';
import { extractTitleFromFulltitle } from '../matcher';

async function main() {
  const args = process.argv.slice(2);
  const searchIdx = args.indexOf('--search');
  const typeIdx = args.indexOf('--type');
  const searchQuery = searchIdx !== -1 ? args[searchIdx + 1] : null;
  const typeFilter = typeIdx !== -1 ? args[typeIdx + 1] : 'movie,series';

  const config = loadConfig();
  const client = new WarezClient(config);

  if (searchQuery) {
    // ── Search mode (uses /start/search — entry-level results) ───────────────
    console.log(`\n🔍 Searching warez.cx for: "${searchQuery}"\n`);

    const entries = await client.searchEntries(searchQuery);
    console.log(`Found ${entries.length} entry-level result(s):\n`);

    for (const e of entries.slice(0, 20)) {
      const imdb = e.options?.imdb_id ?? '-';
      const tmdb = e.options?.tmdb_id ?? '-';
      console.log(`  [${e.type.padEnd(7)}] ${e.title}`);
      console.log(`           Original: ${e.original_title || '-'}`);
      console.log(`           Lang: ${(e.lang ?? []).join(',') || '-'} | Genre: ${(e.genre ?? []).join(', ') || '-'}`);
      console.log(`           IMDB: ${imdb} | TMDB: ${tmdb}`);
      console.log(`           UID: ${e.uid}`);
      if (e.description) {
        console.log(`           Desc: ${e.description.substring(0, 100)}...`);
      }
      console.log();
    }
    if (entries.length > 20) {
      console.log(`  … and ${entries.length - 20} more`);
    }

    console.log(`\nNote: These are entry-level results (media titles, not individual releases).`);
    console.log(`Download links are available via the /start/release feed or detail pages.`);
  } else {
    // ── Latest releases mode ─────────────────────────────────────────────────
    console.log('\n📋 Fetching latest releases from warez.cx (page 1)…\n');

    const data = await client.fetchReleases({
      page: 1,
      per_page: 20,
      sortBy: 'latest',
      sortOrder: 'desc',
      source: 'releases,next',
    });

    const { current_page, last_page, total, per_page } = data.items;
    console.log(`Pages: ${current_page}/${last_page} | Total releases: ${total} | Per page: ${per_page}\n`);

    let movies = 0, series = 0, other = 0;

    for (const r of data.items.data) {
      if (r.type === 'movie') movies++;
      else if (r.type === 'series') series++;
      else other++;

      const extracted = extractTitleFromFulltitle(r.fulltitle);
      const imdb = r.entry?.options?.imdb_id ?? '-';
      console.log(`  [${String(r.id).padStart(7)}] [${r.type.padEnd(7)}] ${r.title}`);
      console.log(`           Full  : ${r.fulltitle}`);
      console.log(`           Parsed: "${extracted}" | Quality: ${r.quality ?? 'n/a'} | Lang: ${r.lang.join(',')}`);
      console.log(`           IMDB: ${imdb} | Group: ${r.group} | Created: ${r.created_at}`);
      console.log();
    }

    console.log(`Summary (this page): movies=${movies} series=${series} other=${other}`);
    console.log(`\n✅ warez API is reachable and returning valid data.`);
  }
}

main().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
