import type { Config } from '../config';

export interface FileBrowserItem {
  path: string;
  name: string;
  size: number;
  extension: string;
  modified: string;
  mode: number;
  isDir: boolean;
  isSymlink: boolean;
  type: string;
}

export interface FileBrowserListResponse {
  items: FileBrowserItem[];
  numDirs: number;
  numFiles: number;
  sorting: unknown;
  path: string;
  name: string;
  size: number;
  extension: string;
  modified: string;
  mode: number;
  isDir: boolean;
  isSymlink: boolean;
  type: string;
}

/**
 * FileBrowser REST API client.
 * Auth: JWT token via X-Auth header (not Bearer).
 *
 * Key endpoints:
 *   POST   /api/login                → JWT token string
 *   GET    /api/resources/{path}     → directory listing or file metadata
 *   POST   /api/resources/{path}/    → create directory (trailing slash)
 *   PATCH  /api/resources/{path}     → rename/move (body: { action: "rename", destination: "/new/path" })
 *   DELETE /api/resources/{path}     → delete file or directory
 */
export class FileBrowserClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private token: string | null = null;

  constructor(config: Config) {
    if (!config.FILEBROWSER_URL || !config.FILEBROWSER_USERNAME || !config.FILEBROWSER_PASSWORD) {
      throw new Error(
        'FileBrowser config missing. Set FILEBROWSER_URL, FILEBROWSER_USERNAME, and FILEBROWSER_PASSWORD.',
      );
    }
    this.baseUrl = config.FILEBROWSER_URL.replace(/\/+$/, '');
    this.username = config.FILEBROWSER_USERNAME;
    this.password = config.FILEBROWSER_PASSWORD;
  }

  /** Authenticate and cache the JWT token */
  async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FileBrowser login failed: ${response.status} ${text}`);
    }

    this.token = await response.text();
  }

  private async ensureToken(): Promise<string> {
    if (!this.token) {
      await this.login();
    }
    return this.token!;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/api/resources${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'X-Auth': token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      // Token expired — re-login and retry once
      await this.login();
      const retryResponse = await fetch(url, {
        method,
        headers: {
          'X-Auth': this.token!,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!retryResponse.ok) {
        const text = await retryResponse.text();
        throw new Error(`FileBrowser ${method} ${path} → ${retryResponse.status}: ${text}`);
      }
      const text = await retryResponse.text();
      return text ? JSON.parse(text) : ({} as T);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FileBrowser ${method} ${path} → ${response.status}: ${text}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  /** List contents of a directory */
  async listDir(dirPath: string): Promise<FileBrowserItem[]> {
    const normalized = dirPath.startsWith('/') ? dirPath : `/${dirPath}`;
    const data = await this.request<FileBrowserListResponse>('GET', normalized);
    return data.items ?? [];
  }

  /** Check if a path exists */
  async exists(filePath: string): Promise<boolean> {
    const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
    try {
      await this.request<unknown>('GET', normalized);
      return true;
    } catch {
      return false;
    }
  }

  /** Create a directory (recursively creates parents) */
  async createDir(dirPath: string): Promise<void> {
    const normalized = dirPath.startsWith('/') ? dirPath : `/${dirPath}`;
    // FileBrowser creates directories when posting to a path ending with /
    const token = await this.ensureToken();
    const url = `${this.baseUrl}/api/resources${normalized}/`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Auth': token },
    });

    // 409 = already exists, which is fine
    if (!response.ok && response.status !== 409) {
      const text = await response.text();
      throw new Error(`FileBrowser createDir ${normalized} → ${response.status}: ${text}`);
    }
  }

  /** Move/rename a file or directory */
  async move(sourcePath: string, destPath: string): Promise<void> {
    const normalized = sourcePath.startsWith('/') ? sourcePath : `/${sourcePath}`;
    const normalizedDest = destPath.startsWith('/') ? destPath : `/${destPath}`;
    const token = await this.ensureToken();

    // FileBrowser uses PATCH with action + destination for moves
    const url = `${this.baseUrl}/api/resources${normalized}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'X-Auth': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'rename',
        destination: normalizedDest,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FileBrowser move ${normalized} → ${normalizedDest}: ${response.status}: ${text}`);
    }
  }

  /** Delete a file or directory */
  async delete(filePath: string): Promise<void> {
    const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
    await this.request<unknown>('DELETE', normalized);
  }

  /**
   * Recursively list all files in a directory.
   * Returns flat list of file items with full paths.
   */
  async listDirRecursive(dirPath: string): Promise<FileBrowserItem[]> {
    const items = await this.listDir(dirPath);
    const results: FileBrowserItem[] = [];

    for (const item of items) {
      if (item.isDir) {
        const subItems = await this.listDirRecursive(item.path);
        results.push(...subItems);
      } else {
        results.push(item);
      }
    }

    return results;
  }
}
