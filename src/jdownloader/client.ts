import JDownloader from 'myjdownloader';
import type { Config } from '../config';

export interface PushLinksOptions {
  links: string[];
  packageName: string;
  autostart: boolean;
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
    const devices = await this.client.listDevices();

    if (!devices || devices.length === 0) {
      throw new Error('No JDownloader devices found on this MyJDownloader account.');
    }

    // listDevices returns device objects with id and name properties
    const match = devices.find((d: { id: string; name: string }) => d.name === this.deviceName);
    if (!match) {
      const available = devices.map((d: { id: string; name: string }) => d.name).join(', ');
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
    });
  }
}
