import type { Config } from '../config';
import type {
  WarezApiResponse,
  WarezDetailResponse,
  WarezEntryDetail,
  WarezFetchParams,
  WarezRelease,
  WarezSearchEntry,
  WarezSearchResponse,
} from './types';

export class WarezClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: Config) {
    this.baseUrl = config.WAREZ_API_BASE;
    this.headers = {
      'Accept': 'application/json',
      'User-Agent': config.WAREZ_USER_AGENT
        ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (config.WAREZ_COOKIE) {
      this.headers['Cookie'] = config.WAREZ_COOKIE;
    }
  }

  async fetchReleases(params: WarezFetchParams = {}): Promise<WarezApiResponse> {
    const query = new URLSearchParams();
    if (params.q !== undefined) query.set('q', params.q);
    if (params.page !== undefined) query.set('page', String(params.page));
    if (params.per_page !== undefined) query.set('per_page', String(params.per_page));
    if (params.sortBy !== undefined) query.set('sortBy', params.sortBy);
    if (params.sortOrder !== undefined) query.set('sortOrder', params.sortOrder);
    if (params.types !== undefined) query.set('types', params.types);
    if (params.source !== undefined) query.set('source', params.source);
    if (params.unique !== undefined) query.set('unique', String(params.unique));

    const url = `${this.baseUrl}/start/release?${query.toString()}`;

    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(`warez API error ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<WarezApiResponse>;
  }

  /**
   * Fetch all pages of media releases (movie + series only) until stopCondition returns true.
   * stopCondition receives the current batch and should return true to halt pagination.
   */
  async* streamReleases(
    params: Omit<WarezFetchParams, 'page'> = {},
    stopCondition?: (releases: WarezRelease[]) => boolean,
    maxPages = 0,
  ): AsyncGenerator<WarezRelease[]> {
    let page = 1;
    while (true) {
      const data = await this.fetchReleases({ ...params, page });
      const batch = data.items.data;

      yield batch;

      if (stopCondition && stopCondition(batch)) break;
      if (page >= data.items.last_page) break;
      if (maxPages > 0 && page >= maxPages) break;

      page++;
    }
  }

  /**
   * Search for a specific title using /start/search (entry-level results).
   * Returns media entries with metadata (IMDB/TMDB IDs, description, etc.)
   * but NOT individual releases with download links.
   */
  async searchEntries(query: string): Promise<WarezSearchEntry[]> {
    const results: WarezSearchEntry[] = [];
    let page = 1;

    while (true) {
      const params = new URLSearchParams();
      params.set('q', query);
      params.set('page', String(page));

      const url = `${this.baseUrl}/start/search?${params.toString()}`;
      const response = await fetch(url, { headers: this.headers });
      if (!response.ok) {
        throw new Error(`warez search API error ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as WarezSearchResponse;
      results.push(...data.items.data);

      if (page >= data.items.last_page) break;
      page++;

      // Safety cap
      if (page > 10) break;
    }

    return results;
  }

  /**
   * Fetch full entry detail including all releases with download links.
   * Uses the /start/d/:uid endpoint discovered from the SPA.
   */
  async fetchEntryDetail(uid: string): Promise<WarezEntryDetail> {
    const url = `${this.baseUrl}/start/d/${uid}`;
    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(`warez detail API error ${response.status}: ${await response.text()}`);
    }
    const data = await response.json() as WarezDetailResponse;
    return data.item;
  }

}
