import { loadConfig } from './config';
import { startServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  await startServer(config);
}

main();
