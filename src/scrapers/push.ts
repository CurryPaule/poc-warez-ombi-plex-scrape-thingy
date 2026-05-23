import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow } from '../nocodb/types';
import type { JDownloaderClient } from '../jdownloader/client';
import type { Config } from '../config';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Select download links from a match record based on hoster priority.
 * Links field is a JSON-serialized Record<string, string[]>.
 * Returns the URLs from the highest-priority available hoster.
 */
function selectLinks(linksJson: string | undefined, hosterPriority: string[]): string[] | null {
  if (!linksJson) return null;

  let links: Record<string, string[]>;
  try {
    links = JSON.parse(linksJson);
  } catch {
    return null;
  }

  if (!links || typeof links !== 'object') return null;

  // Try hosters in priority order
  for (const hoster of hosterPriority) {
    const normalized = hoster.trim().toLowerCase();
    // Match hoster key that contains the priority string (e.g. "ddownload" matches "ddownload.com")
    const matchingKey = Object.keys(links).find(k => k.toLowerCase().includes(normalized));
    if (matchingKey && links[matchingKey] && links[matchingKey].length > 0) {
      return links[matchingKey];
    }
  }

  // Fallback: use first available hoster with links
  for (const urls of Object.values(links)) {
    if (urls && urls.length > 0) return urls;
  }

  return null;
}

/**
 * Push scraper: sends `matched` records to JDownloader and transitions them to `pushed`.
 *
 * Workflow:
 * 1. Fetch all matches with status "matched"
 * 2. For each match, extract links using hoster priority
 * 3. Push links to JDownloader via linkgrabber
 * 4. On success: update status to "pushed"
 * 5. On failure: log warning, skip (stays "matched" for retry next run)
 */
export async function runPushScraper(
  jdownloader: JDownloaderClient,
  nocodb: NocoDbClient,
  config: Config,
): Promise<void> {
  console.log('▶ Push scraper starting...');

  const matched = await nocodb.getMatchesByStatus('matched');
  console.log(`  Found ${matched.length} matched record(s) to push`);

  if (matched.length === 0) {
    console.log('  Nothing to push.');
    return;
  }

  const hosterPriority = config.JDOWNLOADER_HOSTER_PRIORITY.split(',').map(h => h.trim());

  let pushed = 0;
  let skipped = 0;
  let failed = 0;

  for (const match of matched) {
    const links = selectLinks(match.Links, hosterPriority);

    if (!links || links.length === 0) {
      console.log(`  ⚠ No links found for "${match.Fulltitle}" — skipping`);
      skipped++;
      continue;
    }

    const selectedHoster = findMatchingHoster(match.Links, hosterPriority);
    const packageName = match.Fulltitle || match.Title;

    try {
      await jdownloader.pushLinks({
        links,
        packageName,
        autostart: config.JDOWNLOADER_AUTOSTART,
      });

      await nocodb.updateMatchRelease(match.Id, {
        Status: 'pushed',
      });

      pushed++;
      console.log(`  ✅ Pushed: "${packageName}" (${links.length} link(s) via ${selectedHoster})`);
    } catch (err) {
      failed++;
      console.warn(`  ⚠ Push failed for "${packageName}":`, err instanceof Error ? err.message : err);
      // Status stays "matched" — will be retried next run
    }

    await sleep(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Push done. Pushed: ${pushed}, Skipped: ${skipped}, Failed: ${failed}`);
}

/**
 * Find which hoster was selected for logging purposes.
 */
function findMatchingHoster(linksJson: string | undefined, hosterPriority: string[]): string {
  if (!linksJson) return 'unknown';
  try {
    const links: Record<string, string[]> = JSON.parse(linksJson);
    for (const hoster of hosterPriority) {
      const normalized = hoster.trim().toLowerCase();
      const matchingKey = Object.keys(links).find(k => k.toLowerCase().includes(normalized));
      if (matchingKey && links[matchingKey] && links[matchingKey].length > 0) {
        return matchingKey;
      }
    }
    // Fallback
    const firstKey = Object.keys(links).find(k => links[k] && links[k].length > 0);
    return firstKey ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
