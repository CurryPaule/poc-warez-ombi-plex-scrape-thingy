import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow } from '../nocodb/types';
import type { JDownloaderClient } from '../jdownloader/client';
import type { Config } from '../config';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Delay in ms between polls for JDownloader to resolve container links */
const LINKGRABBER_RESOLVE_DELAY_MS = 1000;
/** Max attempts to poll linkgrabber for resolved links */
const LINKGRABBER_POLL_MAX_ATTEMPTS = 15;

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

  if (!links || typeof links !== 'object' || Object.keys(links).length === 0) return null;

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
 * Build a regex pattern that matches filenames for a specific episode.
 * E.g., for episode 5 in season 4: matches "S04E05" in the filename.
 */
function buildEpisodePattern(season: number | undefined, episode: number): RegExp {
  const seasonStr = season != null ? `S${String(season).padStart(2, '0')}` : 'S\\d{2}';
  const episodeStr = `E${String(episode).padStart(2, '0')}`;
  return new RegExp(`${seasonStr}${episodeStr}`, 'i');
}

/**
 * Determine if a match is a series re-check that needs episode filtering.
 * A re-check is a series that was previously pushed/processed and now has a new episode.
 */
function isSeriesRecheck(match: MatchRow): boolean {
  return match.Type === 'series' && match.Episode != null && match.Episode > 0;
}

/**
 * Push scraper: sends `matched` records to JDownloader and transitions them to `pushed`.
 *
 * For series with episode tracking, it:
 * 1. Pushes the crypted container (all episodes) to the linkgrabber WITHOUT autostart
 * 2. Waits for JDownloader to resolve the container into individual links
 * 3. Removes links that don't match the target episode pattern
 * 4. Moves only the target episode's links to the download list
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

    if (!selected) {
      console.log(`  ⚠ No crypted links found for "${match.Fulltitle}" — skipping`);
      skipped++;
      continue;
    }

    const packageName = match.Fulltitle || match.Title;
    const metadataPath = buildMetadataPath(match);
    const needsFiltering = isSeriesRecheck(match);

    try {
      if (needsFiltering) {
        // Series with episode info: push without autostart, then filter to target episode
        await jdownloader.pushLinks({
          links: [selected.url],
          packageName,
          autostart: false,
          destinationFolder: metadataPath,
        });

        console.log(`  📦 Container sent, waiting for link resolution...`);
        await sleep(LINKGRABBER_RESOLVE_DELAY_MS);

        // Poll linkgrabber for resolved links matching this package
        const episodePattern = buildEpisodePattern(match.Season, match.Episode!);
        // Build a prefix to identify links from this release (e.g., "From.S04" from "From.S04.GERMAN.DL...")
        const releasePrefix = packageName.split('.').slice(0, 2).join('.').toLowerCase();
        let resolved = false;

        for (let attempt = 0; attempt < LINKGRABBER_POLL_MAX_ATTEMPTS; attempt++) {
          const links = await jdownloader.queryLinks();
          // Find links belonging to this release by filename prefix
          const packageLinks = links.filter(l =>
            l.name.toLowerCase().startsWith(releasePrefix)
          );

          if (packageLinks.length === 0) {
            console.log(`  ⏳ No links resolved yet (attempt ${attempt + 1}/${LINKGRABBER_POLL_MAX_ATTEMPTS})`);
            await sleep(LINKGRABBER_RESOLVE_DELAY_MS);
            continue;
          }

          // Filter: keep only links matching the target episode
          const keepLinks = packageLinks.filter(l => episodePattern.test(l.name));
          const removeLinksIds = packageLinks
            .filter(l => !episodePattern.test(l.name))
            .map(l => l.uuid);

          if (keepLinks.length === 0) {
            console.log(`  ⚠ No links match episode pattern ${episodePattern} — keeping all`);
            // Move all to download list if we can't filter
            if (config.JDOWNLOADER_AUTOSTART) {
              await jdownloader.moveToDownloadList(packageLinks.map(l => l.uuid));
            }
          } else {
            // Remove old episode links, keep only the target episode
            if (removeLinksIds.length > 0) {
              await jdownloader.removeLinks(removeLinksIds);
              console.log(`  🗑️ Removed ${removeLinksIds.length} links (old episodes)`);
            }
            // Move target episode links to download list
            if (config.JDOWNLOADER_AUTOSTART) {
              await jdownloader.moveToDownloadList(keepLinks.map(l => l.uuid));
            }
            console.log(`  ✅ Pushed: "${packageName}" E${String(match.Episode).padStart(2, '0')} (${keepLinks.length} file(s), filtered from ${packageLinks.length})`);
          }

          resolved = true;
          break;
        }

        if (!resolved) {
          console.log(`  ⚠ Link resolution timed out for "${packageName}" — container left in linkgrabber`);
          // Still mark as pushed — the container is in the linkgrabber for manual handling
        }
      } else {
        // Movies or first-time series: push with autostart as before
        await jdownloader.pushLinks({
          links: [selected.url],
          packageName,
          autostart: config.JDOWNLOADER_AUTOSTART,
          destinationFolder: metadataPath,
        });
        console.log(`  ✅ Pushed: "${packageName}" (via ${selected.hoster})`);
      }

      await nocodb.updateMatchRelease(match.Id, {
        Status: 'pushed',
      });
      pushed++;

    } catch (err) {
      failed++;
      console.warn(`  ⚠ Push failed for "${packageName}":`, err instanceof Error ? err.message : err);
    }

    await sleep(config.SEARCH_DELAY_MS);
  }

  console.log(`✔ Push done. Pushed: ${pushed}, Skipped: ${skipped}, Failed: ${failed}`);
}
