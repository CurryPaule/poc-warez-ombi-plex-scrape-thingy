import type { Config } from '../config';
import type {
  MatchRow,
  NocoDbV3ListResponse,
  NocoDbV3Record,
  ScraperStateRow,
  WatchlistRow,
} from './types';

/**
 * NocoDB v3 API client.
 * URL pattern: /api/v3/data/{baseId}/{tableId}/records
 * Auth: xc-token header with PAT token
 * Response: { records: [{ id, id_fields, fields }], next?, prev? }
 */
export class NocoDbClient {
  private baseUrl: string;
  private baseId: string;
  private headers: Record<string, string>;
  private watchlistTableId: string;
  private matchesTableId: string;
  private stateTableId: string;

  constructor(config: Config) {
    this.baseUrl = config.NOCODB_URL;
    this.baseId = config.NOCODB_BASE_ID;
    this.watchlistTableId = config.NOCODB_WATCHLIST_TABLE_ID;
    this.matchesTableId = config.NOCODB_MATCHES_TABLE_ID;
    this.stateTableId = config.NOCODB_STATE_TABLE_ID;
    this.headers = {
      'xc-token': config.NOCODB_API_KEY,
      'Content-Type': 'application/json',
    };
  }

  private tablePath(tableId: string): string {
    return `${this.baseUrl}/api/v3/data/${this.baseId}/${tableId}`;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`NocoDB ${method} ${url} → ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }

  /** Flatten a v3 record: merge { id, fields } → fields with Id added */
  private flatten<T>(record: NocoDbV3Record<T>): T & { Id: number } {
    return { Id: record.id, ...record.fields };
  }

  // ─── Watchlist ───────────────────────────────────────────────────────────────

  async getActiveWatchlist(): Promise<(WatchlistRow & { Id: number })[]> {
    const results: (WatchlistRow & { Id: number })[] = [];
    let url: string | null = `${this.tablePath(this.watchlistTableId)}/records?where=(Active,eq,1)&limit=100`;

    while (url) {
      const data: NocoDbV3ListResponse<WatchlistRow> = await this.request('GET', url);
      results.push(...data.records.map((r: NocoDbV3Record<WatchlistRow>) => this.flatten(r)));
      url = data.next ?? null;
    }

    return results;
  }

  async getWatchlistItemById(id: number): Promise<(WatchlistRow & { Id: number }) | null> {
    const url = `${this.tablePath(this.watchlistTableId)}/records/${id}`;
    try {
      const record = await this.request<NocoDbV3Record<WatchlistRow>>('GET', url);
      return this.flatten(record);
    } catch {
      return null;
    }
  }

  // ─── Matches ─────────────────────────────────────────────────────────────────

  /**
   * Get all matches with a given status.
   */
  async getMatchesByStatus(status: MatchRow['Status']): Promise<(MatchRow & { Id: number })[]> {
    const results: (MatchRow & { Id: number })[] = [];
    let url: string | null = `${this.tablePath(this.matchesTableId)}/records?where=(Status,eq,${status})&limit=100`;

    while (url) {
      const data: NocoDbV3ListResponse<MatchRow> = await this.request('GET', url);
      results.push(...data.records.map((r: NocoDbV3Record<MatchRow>) => this.flatten(r)));
      url = data.next ?? null;
    }

    return results;
  }

  /**
   * Get all series matches eligible for episode re-checking.
   * Includes matched, pushed, and processed statuses — new episodes can appear at any stage.
   */
  async getSeriesMatchesForRecheck(): Promise<(MatchRow & { Id: number })[]> {
    const results: (MatchRow & { Id: number })[] = [];
    const where = '(Type,eq,series)~and((Status,eq,matched)~or(Status,eq,pushed)~or(Status,eq,processed))';
    let url: string | null = `${this.tablePath(this.matchesTableId)}/records?where=${where}&limit=100`;

    while (url) {
      const data: NocoDbV3ListResponse<MatchRow> = await this.request('GET', url);
      results.push(...data.records.map((r: NocoDbV3Record<MatchRow>) => this.flatten(r)));
      url = data.next ?? null;
    }

    return results;
  }

  /**
   * Get the set of WatchlistIds that already have an active match (found or matched).
   * Used by the search scraper to skip items that don't need re-searching.
   */
  async getWatchlistIdsWithActiveMatches(): Promise<Set<number>> {
    const ids = new Set<number>();
    const where = '(Status,eq,found)~or(Status,eq,matched)';
    let url: string | null = `${this.tablePath(this.matchesTableId)}/records?where=${where}&limit=100`;

    while (url) {
      const data: NocoDbV3ListResponse<MatchRow> = await this.request('GET', url);
      for (const record of data.records) {
        const wid = record.fields.WatchlistId;
        if (wid) ids.add(wid);
      }
      url = data.next ?? null;
    }

    return ids;
  }

  /**
   * Update a match record with release-level data from the detail API.
   */
  async updateMatchRelease(id: number, fields: Partial<MatchRow>): Promise<void> {
    const url = `${this.tablePath(this.matchesTableId)}/records`;
    await this.request('PATCH', url, { id, fields });
  }

  /**
   * Check if a match already exists. Uses content-based dedup:
   * - For releases with season/episode: dedup by WatchlistId + ImdbId + SeasonEpisodeKey
   * - For movies or releases without episode info: dedup by WatchlistId + ImdbId (or WarezId fallback)
   * This prevents multiple uploads of the same episode from creating duplicate matches.
   */
  async matchExistsByContent(match: Omit<MatchRow, 'Id'>): Promise<boolean> {
    const conditions: string[] = [];

    if (match.WatchlistId) {
      conditions.push(`(WatchlistId,eq,${match.WatchlistId})`);
    }

    // For series with episode key, dedup by content identity
    if (match.SeasonEpisodeKey && match.ImdbId) {
      conditions.push(`(ImdbId,eq,${match.ImdbId})`);
      conditions.push(`(SeasonEpisodeKey,eq,${match.SeasonEpisodeKey})`);
    } else if (match.ImdbId && match.WatchlistId) {
      // Movie or series without episode — dedup by IMDB + watchlist
      conditions.push(`(ImdbId,eq,${match.ImdbId})`);
    } else {
      // Fallback: dedup by WarezId (exact same upload)
      const url = `${this.tablePath(this.matchesTableId)}/records?where=(WarezId,eq,${match.WarezId})&limit=1`;
      const data = await this.request<NocoDbV3ListResponse<MatchRow>>('GET', url);
      return data.records.length > 0;
    }

    const where = conditions.join('~and');
    const url = `${this.tablePath(this.matchesTableId)}/records?where=${where}&limit=1`;
    const data = await this.request<NocoDbV3ListResponse<MatchRow>>('GET', url);
    return data.records.length > 0;
  }

  async createMatch(match: Omit<MatchRow, 'Id'>): Promise<void> {
    const url = `${this.tablePath(this.matchesTableId)}/records`;
    await this.request('POST', url, { fields: match });
  }

  /**
   * Insert a match only if it doesn't already exist.
   * Returns true if a new record was created, false if skipped (duplicate).
   */
  async upsertMatch(match: Omit<MatchRow, 'Id'>): Promise<boolean> {
    const exists = await this.matchExistsByContent(match);
    if (!exists) {
      await this.createMatch(match);
      return true;
    }
    return false;
  }

  /**
   * Find a match record by IMDB ID. Used by the sort step to look up metadata.
   * Returns the most recent match (by MatchedAt) for the given IMDB ID.
   */
  async getMatchByImdbId(imdbId: string): Promise<(MatchRow & { Id: number }) | null> {
    const where = `(ImdbId,eq,${imdbId})`;
    const sort = encodeURIComponent(JSON.stringify([{ field: 'MatchedAt', direction: 'desc' }]));
    const url = `${this.tablePath(this.matchesTableId)}/records?where=${where}&sort=${sort}&limit=1`;
    const data = await this.request<NocoDbV3ListResponse<MatchRow>>('GET', url);
    if (data.records.length === 0) return null;
    return this.flatten(data.records[0]!);
  }

  /**
   * Find a match record by IMDB ID and SeasonEpisodeKey.
   * Used by sort to find the exact episode match.
   */
  async getMatchByImdbIdAndEpisode(
    imdbId: string,
    seasonEpisodeKey: string,
  ): Promise<(MatchRow & { Id: number }) | null> {
    const where = `(ImdbId,eq,${imdbId})~and(SeasonEpisodeKey,eq,${seasonEpisodeKey})`;
    const sort = encodeURIComponent(JSON.stringify([{ field: 'MatchedAt', direction: 'desc' }]));
    const url = `${this.tablePath(this.matchesTableId)}/records?where=${where}&sort=${sort}&limit=1`;
    const data = await this.request<NocoDbV3ListResponse<MatchRow>>('GET', url);
    if (data.records.length === 0) return null;
    return this.flatten(data.records[0]!);
  }

  // ─── Watchlist updates ───────────────────────────────────────────────────────

  async updateWatchlistLastMatched(id: number, timestamp: string): Promise<void> {
    const url = `${this.tablePath(this.watchlistTableId)}/records`;
    await this.request('PATCH', url, { id, fields: { LastMatchedAt: timestamp } });
  }

  /** Update the highest episode found for a series watchlist item */
  async updateWatchlistEpisode(id: number, episode: number): Promise<void> {
    const url = `${this.tablePath(this.watchlistTableId)}/records`;
    await this.request('PATCH', url, { id, fields: { LastEpisodeFound: episode } });
  }

  /** Deactivate a watchlist item (e.g. after DeactivateOnMatch) */
  async deactivateWatchlistItem(id: number): Promise<void> {
    const url = `${this.tablePath(this.watchlistTableId)}/records`;
    await this.request('PATCH', url, { id, fields: { Active: false } });
  }

  // ─── Scraper state ───────────────────────────────────────────────────────────

  async getState(key: string): Promise<string | null> {
    const url = `${this.tablePath(this.stateTableId)}/records?where=(Key,eq,${encodeURIComponent(key)})&limit=1`;
    const data = await this.request<NocoDbV3ListResponse<ScraperStateRow>>('GET', url);
    if (data.records.length === 0) return null;
    return data.records[0]!.fields.Value;
  }

  async setState(key: string, value: string): Promise<void> {
    const url = `${this.tablePath(this.stateTableId)}/records`;
    const existing = await this.request<NocoDbV3ListResponse<ScraperStateRow>>(
      'GET',
      `${url}?where=(Key,eq,${encodeURIComponent(key)})&limit=1`,
    );
    if (existing.records.length === 0) {
      await this.request('POST', url, { fields: { Key: key, Value: value } });
    } else {
      await this.request('PATCH', url, {
        id: existing.records[0]!.id,
        fields: { Value: value },
      });
    }
  }
}
