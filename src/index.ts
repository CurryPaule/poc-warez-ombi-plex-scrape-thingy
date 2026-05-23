import { loadConfig } from './config';
import { NocoDbClient } from './nocodb/client';
import { WarezClient } from './warez/api';
import { runSearchScraper } from './scrapers/search';
import { runEnrichScraper } from './scrapers/enrich';

const MODES = ['search', 'enrich'] as const;
type Mode = typeof MODES[number];

function printUsage(): void {
  console.log('Usage: node dist/index.js <mode>');
  console.log('Modes:');
  console.log('  search       — search for each watchlist item');
  console.log('  enrich       — enrich "found" matches and check series for new episodes');
}

async function main(): Promise<void> {
  const mode = process.argv[2] as Mode | undefined;

  if (!mode || !MODES.includes(mode)) {
    printUsage();
    process.exit(1);
  }

  const config = loadConfig();
  const nocodb = new NocoDbClient(config);
  const warez = new WarezClient(config);

  try {
    if (mode === 'search') {
      await runSearchScraper(warez, nocodb, config);
    } else if (mode === 'enrich') {
      await runEnrichScraper(warez, nocodb, config);
    }
  } catch (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  }
}

main();
