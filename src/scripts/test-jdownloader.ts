/**
 * Test script: verify MyJDownloader connectivity.
 * Usage: npx ts-node src/scripts/test-jdownloader.ts
 */
import { loadConfig } from '../config';
import { JDownloaderClient } from '../jdownloader/client';

async function main(): Promise<void> {
  console.log('🔌 Testing MyJDownloader connection...\n');

  const config = loadConfig();
  const client = new JDownloaderClient(config);

  try {
    await client.connect();
    console.log('\n✅ Successfully connected to MyJDownloader and resolved device.');
  } catch (err) {
    console.error('\n❌ Connection failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.disconnect();
    console.log('🔌 Disconnected.');
  }
}

main();
