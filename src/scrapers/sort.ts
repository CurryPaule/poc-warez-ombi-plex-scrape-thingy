import type { NocoDbClient } from '../nocodb/client';
import type { MatchRow } from '../nocodb/types';
import type { FileBrowserClient, FileBrowserItem } from '../filebrowser/client';
import type { Config } from '../config';
import { extractTitleFromFulltitle } from '../matcher';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.wmv', '.flv', '.mov', '.ts']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.sub', '.ass', '.ssa', '.vtt', '.idx']);

interface DownloadMetadata {
  imdbId: string;
  type: 'movie' | 'series';
  seasonEpisodeKey?: string; // e.g. "S02E05" or "S02"
}

interface SortResult {
  success: boolean;
  movedFiles: string[];
  destination: string;
  error?: string;
}

/**
 * Parse metadata from a download directory name.
 * Expected format: {imdbId}-{type}[-{seasonEpisodeKey}]
 * Examples:
 *   tt1234567-movie
 *   tt0903747-series-S02E05
 *   tt0903747-series-S02
 */
export function parseDownloadMetadata(dirName: string): DownloadMetadata | null {
  // Match imdb ID, type, and optional season/episode
  const match = /^(tt\d+)-(movie|series)(?:-(.+))?$/.exec(dirName);
  if (!match) return null;

  return {
    imdbId: match[1]!,
    type: match[2]! as 'movie' | 'series',
    seasonEpisodeKey: match[3] || undefined,
  };
}

/**
 * Extract the year from a fulltitle.
 * e.g. "Movie.Title.2024.German.DL.1080p" → 2024
 */
function extractYear(fulltitle: string): number | null {
  const match = /\b((?:19|20)\d{2})\b/.exec(fulltitle);
  return match ? parseInt(match[1]!, 10) : null;
}

/**
 * Build a clean display title from a fulltitle.
 * Extracts the title portion and capitalizes words.
 * e.g. "breaking bad" → "Breaking Bad"
 */
function titleCase(title: string): string {
  return title
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

function isVideoFile(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(filename));
}

function isSubtitleFile(filename: string): boolean {
  return SUBTITLE_EXTENSIONS.has(getExtension(filename));
}

/**
 * Extract season number from a SeasonEpisodeKey.
 * e.g. "S02E05" → "S02", "S02" → "S02"
 */
function extractSeasonDir(key: string): string {
  const match = /^(S\d{2})/i.exec(key);
  return match ? match[1]!.toUpperCase() : key;
}

/**
 * Build the destination path for a movie.
 * Format: {moviesPath}/{Title (year)}/
 */
function buildMovieDestination(
  moviesPath: string,
  matchRecord: MatchRow,
): string {
  const cleanTitle = titleCase(extractTitleFromFulltitle(matchRecord.Fulltitle));
  const year = extractYear(matchRecord.Fulltitle);
  const dirName = year ? `${cleanTitle} (${year})` : cleanTitle;
  return `${moviesPath}/${dirName}`;
}

/**
 * Build the destination path for a TV show episode.
 * Format: {showsPath}/{Title (year)}/{S01}/
 */
function buildShowDestination(
  showsPath: string,
  matchRecord: MatchRow,
  seasonEpisodeKey?: string,
): string {
  const cleanTitle = titleCase(extractTitleFromFulltitle(matchRecord.Fulltitle));
  const year = extractYear(matchRecord.Fulltitle);
  const dirName = year ? `${cleanTitle} (${year})` : cleanTitle;

  const seasonDir = seasonEpisodeKey
    ? extractSeasonDir(seasonEpisodeKey)
    : (matchRecord.Season ? `S${String(matchRecord.Season).padStart(2, '0')}` : 'S01');

  return `${showsPath}/${dirName}/${seasonDir}`;
}

/**
 * Categorize files from a download directory into video files and subtitle files.
 * Subtitles can be next to video files or in a subs/ subdirectory.
 */
function categorizeFiles(items: FileBrowserItem[]): {
  videos: FileBrowserItem[];
  subtitles: FileBrowserItem[];
} {
  const videos: FileBrowserItem[] = [];
  const subtitles: FileBrowserItem[] = [];

  for (const item of items) {
    if (isVideoFile(item.name)) {
      videos.push(item);
    } else if (isSubtitleFile(item.name)) {
      subtitles.push(item);
    }
  }

  return { videos, subtitles };
}

/**
 * Sort a completed download into the correct Plex/Jellyfin directory.
 *
 * For movies:
 *   {moviesPath}/Movie Title (year)/full.release.name.mkv
 *
 * For TV shows without subtitles:
 *   {showsPath}/Show Title (year)/S01/full.release.name.mkv
 *
 * For TV shows with subtitles:
 *   {showsPath}/Show Title (year)/S01/{SeasonEpisodeKey}/full.release.name.mkv
 *   {showsPath}/Show Title (year)/S01/{SeasonEpisodeKey}/subs/subtitle.srt
 */
export async function sortDownload(
  fb: FileBrowserClient,
  nocodb: NocoDbClient,
  config: Config,
  downloadDirName: string,
  scanPath?: string,
): Promise<SortResult> {
  const moviesPath = config.MEDIA_MOVIES_PATH;
  const showsPath = config.MEDIA_SHOWS_PATH;
  if (!moviesPath || !showsPath) {
    return { success: false, movedFiles: [], destination: '', error: 'MEDIA_MOVIES_PATH and MEDIA_SHOWS_PATH must be configured' };
  }

  // Parse metadata from directory name
  const metadata = parseDownloadMetadata(downloadDirName);
  if (!metadata) {
    return {
      success: false,
      movedFiles: [],
      destination: '',
      error: `Cannot parse metadata from directory name: "${downloadDirName}". Expected format: {imdbId}-{type}[-{seasonEpisodeKey}]`,
    };
  }

  // Determine the directory to scan for files
  // scanPath is the full path provided (e.g. "/output/tt36586751-movie/Release.Name")
  // If not provided, fall back to FILEBROWSER_DOWNLOAD_PATH + dirName
  const downloadDir = scanPath || `${config.FILEBROWSER_DOWNLOAD_PATH}/${downloadDirName}`;
  if (!downloadDir) {
    return { success: false, movedFiles: [], destination: '', error: 'No scan path and FILEBROWSER_DOWNLOAD_PATH not configured' };
  }

  console.log(`  📂 Sorting download: ${downloadDir}`);
  console.log(`     IMDB: ${metadata.imdbId}, Type: ${metadata.type}, Key: ${metadata.seasonEpisodeKey || 'n/a'}`);

  // Look up match in NocoDB
  let matchRecord: (MatchRow & { Id: number }) | null;
  if (metadata.seasonEpisodeKey) {
    matchRecord = await nocodb.getMatchByImdbIdAndEpisode(metadata.imdbId, metadata.seasonEpisodeKey);
  }
  // Fallback to just IMDB ID
  matchRecord ??= await nocodb.getMatchByImdbId(metadata.imdbId);

  if (!matchRecord) {
    return {
      success: false,
      movedFiles: [],
      destination: '',
      error: `No match found in NocoDB for IMDB ID: ${metadata.imdbId}`,
    };
  }

  console.log(`     Match found: "${matchRecord.Fulltitle}" (ID: ${matchRecord.Id})`);

  // List all files in the download directory recursively
  const allFiles = await fb.listDirRecursive(downloadDir);
  const { videos, subtitles } = categorizeFiles(allFiles);

  if (videos.length === 0) {
    return {
      success: false,
      movedFiles: [],
      destination: '',
      error: `No video files found in ${downloadDir}`,
    };
  }

  console.log(`     Found ${videos.length} video(s), ${subtitles.length} subtitle(s)`);

  // Determine destination
  const destination = metadata.type === 'movie'
    ? buildMovieDestination(moviesPath, matchRecord)
    : buildShowDestination(showsPath, matchRecord, metadata.seasonEpisodeKey);

  const movedFiles: string[] = [];

  if (metadata.type === 'movie') {
    // Movies: just create the movie dir and move video + subs
    await fb.createDir(destination);

    for (const video of videos) {
      const dest = `${destination}/${video.name}`;
      await fb.move(video.path, dest);
      movedFiles.push(dest);
      console.log(`     ✅ Moved: ${video.name}`);
    }

    for (const sub of subtitles) {
      const dest = `${destination}/${sub.name}`;
      await fb.move(sub.path, dest);
      movedFiles.push(dest);
      console.log(`     ✅ Moved subtitle: ${sub.name}`);
    }
  } else {
    // TV shows
    if (subtitles.length === 0) {
      // No subs — just put video files directly in the season directory
      await fb.createDir(destination);

      for (const video of videos) {
        const dest = `${destination}/${video.name}`;
        await fb.move(video.path, dest);
        movedFiles.push(dest);
        console.log(`     ✅ Moved: ${video.name}`);
      }
    } else {
      // Has subs — create episode subdirectory with subs folder
      const episodeDir = metadata.seasonEpisodeKey || matchRecord.SeasonEpisodeKey || 'unknown';
      // Use the fulltitle or SeasonEpisodeKey for the episode directory name
      const episodeDirName = matchRecord.Fulltitle
        ? cleanEpisodeDirName(matchRecord.Fulltitle, episodeDir)
        : episodeDir;
      const episodePath = `${destination}/${episodeDirName}`;
      const subsPath = `${episodePath}/subs`;

      await fb.createDir(episodePath);
      await fb.createDir(subsPath);

      for (const video of videos) {
        const dest = `${episodePath}/${video.name}`;
        await fb.move(video.path, dest);
        movedFiles.push(dest);
        console.log(`     ✅ Moved: ${video.name}`);
      }

      for (const sub of subtitles) {
        const dest = `${subsPath}/${sub.name}`;
        await fb.move(sub.path, dest);
        movedFiles.push(dest);
        console.log(`     ✅ Moved subtitle: ${sub.name}`);
      }
    }
  }

  // Update match status to processed
  await nocodb.updateMatchRelease(matchRecord.Id, {
    Status: 'processed',
  });
  console.log(`     📋 Updated match status to "processed"`);

  // Try to clean up empty source directories (release dir, then metadata dir)
  try {
    await fb.delete(downloadDir);
    console.log(`     🗑️ Cleaned up source directory: ${downloadDir}`);

    // Also try to clean up the metadata parent dir if it's now empty
    const parentDir = downloadDir.replace(/\/[^/]+\/?$/, '');
    if (parentDir && parentDir !== downloadDir) {
      try {
        const remaining = await fb.listDir(parentDir);
        if (remaining.length === 0) {
          await fb.delete(parentDir);
          console.log(`     🗑️ Cleaned up metadata directory: ${parentDir}`);
        }
      } catch {
        // Parent dir cleanup is best-effort
      }
    }
  } catch {
    console.log(`     ⚠ Could not delete source directory (may not be empty): ${downloadDir}`);
  }

  return { success: true, movedFiles, destination };
}

/**
 * Build a clean episode directory name.
 * Prefers the full release name if it contains the season/episode key,
 * otherwise falls back to just the key.
 * e.g. "Scrubs.2026.S01E02.Whatever" → "Scrubs.2026.S01E02.Whatever"
 *      (or "S01E02" if no fulltitle)
 */
function cleanEpisodeDirName(fulltitle: string, fallbackKey: string): string {
  // Remove file extension if somehow present
  const cleaned = fulltitle.replace(/\.(mkv|mp4|avi|m4v|wmv|flv|mov|ts)$/i, '');
  return cleaned || fallbackKey;
}
