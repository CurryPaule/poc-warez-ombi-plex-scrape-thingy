import JDownloader from 'myjdownloader';
import type { Config } from '../config';

export interface PushLinksOptions {
  links: string[];
  packageName: string;
  autostart: boolean;
  destinationFolder?: string;
}

export interface CrawledLink {
  uuid: number;
  name: string;
  url: string;
  packageUUID: string;
  size: number;
}

/**
 * Wrapper around the myjdownloader library.
 * Handles connect/disconnect lifecycle and device resolution by name.
 */
export class JDownloaderClient {
  private client: JDownloader;
  private deviceName: string;
  private resolvedDeviceId: string | null = null;

  constructor(config: Config) {
    if (!config.JDOWNLOADER_EMAIL || !config.JDOWNLOADER_PASSWORD || !config.JDOWNLOADER_DEVICE_NAME) {
      throw new Error(
        'JDownloader config missing. Set JDOWNLOADER_EMAIL, JDOWNLOADER_PASSWORD, and JDOWNLOADER_DEVICE_NAME.',
      );
    }
    this.client = new JDownloader(config.JDOWNLOADER_EMAIL, config.JDOWNLOADER_PASSWORD);
    this.deviceName = config.JDOWNLOADER_DEVICE_NAME;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.resolveDevice();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.resolvedDeviceId = null;
  }

  private async resolveDevice(): Promise<void> {
    const response = await this.client.listDevices();
    // listDevices() returns { list: [{ id, name, ... }] }
    const devices: { id: string; name: string }[] = response?.list ?? [];

    if (devices.length === 0) {
      throw new Error('No JDownloader devices found on this MyJDownloader account.');
    }

    const match = devices.find(d => d.name === this.deviceName);
    if (!match) {
      const available = devices.map(d => d.name).join(', ');
      throw new Error(
        `JDownloader device "${this.deviceName}" not found. Available: ${available}`,
      );
    }

    this.resolvedDeviceId = match.id;
    console.log(`  🔗 Connected to JDownloader device: "${match.name}" (${match.id})`);
  }

  private get deviceId(): string {
    if (!this.resolvedDeviceId) {
      throw new Error('JDownloader client not connected. Call connect() first.');
    }
    return this.resolvedDeviceId;
  }

  /**
   * Push links to JDownloader's linkgrabber.
   * Uses addLinks to send URLs and optionally auto-start downloads.
   */
  async pushLinks(options: PushLinksOptions): Promise<void> {
    await this.client.linkgrabberV2.addLinks(this.deviceId, options.links, {
      packageName: options.packageName,
      autostart: options.autostart,
      ...(options.destinationFolder ? { destinationFolder: options.destinationFolder } : {}),
    });
  }

  /**
   * Query all links currently in the linkgrabber.
   */
  async queryLinks(): Promise<CrawledLink[]> {
    const result = await this.client.linkgrabberV2.queryLinks(this.deviceId, {
      name: true,
      url: true,
      packageUUID: true,
      bytesTotal: true,
    });
    // Response is { data: [...], rid: ... }
    const items: any[] = Array.isArray(result) ? result : ((result as any)?.data ?? []);
    return items.map((link: any) => ({
      uuid: link.uuid,
      name: link.name ?? '',
      url: link.url ?? '',
      packageUUID: String(link.packageUUID ?? ''),
      size: link.bytesTotal ?? 0,
    }));
  }

  /**
   * Remove specific links from the linkgrabber by their UUIDs.
   * JD API expects positional params: [linkIds[], packageIds[]]
   */
  async removeLinks(linkIds: number[]): Promise<void> {
    if (linkIds.length === 0) return;
    await (this.client as any).callAction(
      '/linkgrabberv2/removeLinks',
      this.deviceId,
      [linkIds, []],
    );
  }

  /**
   * Move links from linkgrabber to the download list (starts them).
   * JD API expects positional params: [linkIds[], packageIds[]]
   */
  async moveToDownloadList(linkIds?: number[], packageIds?: number[]): Promise<void> {
    await (this.client as any).callAction(
      '/linkgrabberv2/moveToDownloadlist',
      this.deviceId,
      [linkIds ?? [], packageIds ?? []],
    );
  }
}
