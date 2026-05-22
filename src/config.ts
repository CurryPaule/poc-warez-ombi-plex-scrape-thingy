import { z } from 'zod';

const ConfigSchema = z.object({
  NOCODB_URL: z.string().url(),
  NOCODB_API_KEY: z.string().min(1),
  NOCODB_BASE_ID: z.string().min(1),
  NOCODB_WATCHLIST_TABLE_ID: z.string().min(1),
  NOCODB_MATCHES_TABLE_ID: z.string().min(1),
  NOCODB_STATE_TABLE_ID: z.string().min(1),

  WAREZ_API_BASE: z.string().url().default('https://api.warez.cx'),
  WAREZ_USER_AGENT: z.string().optional(),
  WAREZ_COOKIE: z.string().optional(),

  MAX_INCREMENTAL_PAGES: z.coerce.number().int().nonnegative().default(20),
  SEARCH_DELAY_MS: z.coerce.number().int().nonnegative().default(1500),
  DEFAULT_QUALITY: z.enum(['720p', '1080p', '2160p', '']).default(''),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  // Load .env file manually if not in Docker (Docker passes env vars directly)
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!(key in process.env)) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // Ignore file read errors — env vars may already be set
  }

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid configuration:');
    result.error.issues.forEach(issue => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }

  _config = result.data;
  return _config;
}
