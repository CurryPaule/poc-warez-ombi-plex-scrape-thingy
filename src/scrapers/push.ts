import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow } from '../nocodb/types';
import type { JDownloaderClient } from '../jdownloader/client';
import type { Config } from '../config';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build a metadata-encoded download path for JDownloader.
 * Format: {imdbId}-{type}[-S{season}E{episode}]
 * This path is used as the package subfolder so JDownloader's webhook
 * carries the metadata back when the download completes.
 */
function buildMetadataPath(match: MatchRow): string {
  const parts: string[] = [];

  const imdbId = match.ImdbId || 'unknown';
  parts.push(imdbId);
  parts.push(match.Type || 'movie');

  if (match.SeasonEpisodeKey) {
    parts.push(match.SeasonEpisodeKey);
  }

  return parts.join('-');
}

/**
 * Select a crypted container link from a match record based on hoster priority.
 * CryptedLinks is a JSON-serialized Record<string, string> (hoster → container URL).
 * JDownloader can resolve the actual download links from the container URL.
 */
function selectCryptedLink(
  cryptedLinksJson: string | undefined,
  hosterPriority: string[],
): { url: string; hoster: string } | null {
  if (!cryptedLinksJson) return null;

  let links: Record<string, string>;
  try {
    links = JSON.parse(cryptedLinksJson);
  } catch {
    return null;
  }

  if (!links || typeof links !== 'object') return null;

  // Try hosters in priority order
  for (const hoster of hosterPriority) {
    const normalized = hoster.trim().toLowerCase();
    const matchingKey = Object.keys(links).find(k => k.toLowerCase().includes(normalized));
    if (matchingKey && links[matchingKey]) {
      return { url: links[matchingKey], hoster: matchingKey };
    }
  }

  // Fallback: use first available hoster
  for (const [hoster, url] of Object.entries(links)) {
    if (url) return { url, hoster };
  }

  return null;
}

/**
 * Select direct download links from a match record based on hoster priority.
 * Links is a JSON-serialized Record<string, string[]> (hoster → URL array).
 * Used as fallback when CryptedLinks is empty (e.g., re-checked series with delta links).
 */
function selectDirectLinks(
  linksJson: string | undefined,
  hosterPriority: string[],
): { urls: string[]; hoster: string } | null {
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
    const matchingKey = Object.keys(links).find(k => k.toLowerCase().includes(normalized));
    if (matchingKey && links[matchingKey]?.length > 0) {
      return { urls: links[matchingKey], hoster: matchingKey };
    }
  }

  // Fallback: use first available hoster with links
  for (const [hoster, urls] of Object.entries(links)) {
    if (urls?.length > 0) return { urls, hoster };
  }

  return null;
}

/**
 * Push scraper: sends `matched` records to JDownloader and transitions them to `pushed`.
 *
 * Workflow:
 * 1. Fetch all matches with status "matched"
 * 2. For each match, select a crypted container link by hoster priority
 *    (or fall back to direct links for re-checked series with delta links)
 * 3. Push the link(s) to JDownloader
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
    const selected = selectCryptedLink(match.CryptedLinks, hosterPriority);
    const direct = !selected ? selectDirectLinks(match.Links, hosterPriority) : null;

    if (!selected && !direct) {
      console.log(`  ⚠ No links found for "${match.Fulltitle}" — skipping`);
      skipped++;
      continue;
    }

    const packageName = match.Fulltitle || match.Title;
    const metadataPath = buildMetadataPath(match);

    try {
      if (selected) {
        await jdownloader.pushLinks({
          links: [selected.url],
          packageName,
          autostart: config.JDOWNLOADER_AUTOSTART,
          destinationFolder: metadataPath,
        });
        pushed++;
        console.log(`  ✅ Pushed: "${packageName}" (container via ${selected.hoster})`);
      } else {
        await jdownloader.pushLinks({
          links: direct!.urls,
          packageName,
          autostart: config.JDOWNLOADER_AUTOSTART,
          destinationFolder: metadataPath,
        });
        pushed++;
        console.log(`  ✅ Pushed: "${packageName}" (${direct!.urls.length} direct link(s) via ${direct!.hoster})`);
      }

      await nocodb.updateMatchRelease(match.Id, {
        Status: 'pushed',
      });

    } catch (err) {
      failed++;
      console.warn(`  ⚠ Push failed for "${packageName}":`, err instanceof Error ? err.message : err);
    }

    await sleep(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Push done. Pushed: ${pushed}, Skipped: ${skipped}, Failed: ${failed}`);
}
