import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from './config';
import type { Config } from './config';
import { NocoDbClient } from './nocodb/client';
import { WarezClient } from './warez/api';
import { JDownloaderClient } from './jdownloader/client';
import { FileBrowserClient } from './filebrowser/client';
import { runSearchScraper } from './scrapers/search';
import { runEnrichScraper } from './scrapers/enrich';
import { runPushScraper } from './scrapers/push';
import { sortDownload } from './scrapers/sort';

export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({ logger: true });

  const nocodb = new NocoDbClient(config);
  const warez = new WarezClient(config);

  // ─── Health ──────────────────────────────────────────────────────────────────

  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ─── Search ──────────────────────────────────────────────────────────────────

  app.post('/api/search', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await runSearchScraper(warez, nocodb, config);
      return { status: 'ok', mode: 'search' };
    } catch (err) {
      app.log.error(err, 'Search scraper failed');
      reply.status(500);
      return { status: 'error', mode: 'search', error: String(err) };
    }
  });

  // ─── Enrich ──────────────────────────────────────────────────────────────────

  app.post('/api/enrich', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await runEnrichScraper(warez, nocodb, config);
      return { status: 'ok', mode: 'enrich' };
    } catch (err) {
      app.log.error(err, 'Enrich scraper failed');
      reply.status(500);
      return { status: 'error', mode: 'enrich', error: String(err) };
    }
  });

  // ─── Push ────────────────────────────────────────────────────────────────────

  app.post('/api/push', async (_req: FastifyRequest, reply: FastifyReply) => {
    let jdownloader: JDownloaderClient | null = null;
    try {
      jdownloader = new JDownloaderClient(config);
      await jdownloader.connect();
      await runPushScraper(jdownloader, nocodb, config);
      return { status: 'ok', mode: 'push' };
    } catch (err) {
      app.log.error(err, 'Push scraper failed');
      reply.status(500);
      return { status: 'error', mode: 'push', error: String(err) };
    } finally {
      if (jdownloader) {
        await jdownloader.disconnect().catch(() => {});
      }
    }
  });

  // ─── Workflow (full pipeline) ────────────────────────────────────────────────

  app.post('/api/workflow', async (_req: FastifyRequest, reply: FastifyReply) => {
    const results: Record<string, string> = {};
    let jdownloader: JDownloaderClient | null = null;

    try {
      // Search
      try {
        await runSearchScraper(warez, nocodb, config);
        results.search = 'ok';
      } catch (err) {
        app.log.error(err, 'Workflow: search failed');
        results.search = `error: ${err}`;
      }

      // Enrich
      try {
        await runEnrichScraper(warez, nocodb, config);
        results.enrich = 'ok';
      } catch (err) {
        app.log.error(err, 'Workflow: enrich failed');
        results.enrich = `error: ${err}`;
      }

      // Push
      try {
        jdownloader = new JDownloaderClient(config);
        await jdownloader.connect();
        await runPushScraper(jdownloader, nocodb, config);
        results.push = 'ok';
      } catch (err) {
        app.log.error(err, 'Workflow: push failed');
        results.push = `error: ${err}`;
      } finally {
        if (jdownloader) {
          await jdownloader.disconnect().catch(() => {});
        }
      }

      const hasErrors = Object.values(results).some(v => v.startsWith('error'));
      if (hasErrors) {
        reply.status(207); // Multi-Status: some steps may have failed
      }

      return { status: hasErrors ? 'partial' : 'ok', mode: 'workflow', results };
    } catch (err) {
      app.log.error(err, 'Workflow failed');
      reply.status(500);
      return { status: 'error', mode: 'workflow', error: String(err), results };
    }
  });

  // ─── Sort (webhook target from JDownloader) ──────────────────────────────────

  interface SortBody {
    downloadPath?: string;   // directory name containing metadata, e.g. "tt1234567-movie"
    downloadDir?: string;    // full path in FileBrowser, e.g. "/downloads/tt1234567-movie"
  }

  app.post('/api/sort', async (req: FastifyRequest<{ Body: SortBody }>, reply: FastifyReply) => {
    const { downloadPath, downloadDir } = req.body || {};

    if (!downloadPath && !downloadDir) {
      reply.status(400);
      return {
        status: 'error',
        error: 'Either "downloadPath" or "downloadDir" must be provided',
      };
    }

    // Extract the directory name from whichever field was provided
    let dirName: string;
    let basePath: string | undefined;

    if (downloadDir) {
      // Full path provided — split into base and dir name
      const parts = downloadDir.replace(/\/+$/, '').split('/');
      dirName = parts.pop()!;
      basePath = parts.join('/') || undefined;
    } else {
      dirName = downloadPath!.replace(/\/+$/, '').split('/').pop()!;
    }

    try {
      const fb = new FileBrowserClient(config);
      const result = await sortDownload(fb, nocodb, config, dirName, basePath);

      if (result.success) {
        return {
          status: 'ok',
          mode: 'sort',
          destination: result.destination,
          movedFiles: result.movedFiles,
        };
      } else {
        reply.status(422);
        return {
          status: 'error',
          mode: 'sort',
          error: result.error,
        };
      }
    } catch (err) {
      app.log.error(err, 'Sort failed');
      reply.status(500);
      return { status: 'error', mode: 'sort', error: String(err) };
    }
  });

  return app;
}

/** Start the Fastify server */
export async function startServer(config: Config): Promise<void> {
  const app = buildServer(config);

  try {
    await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
    console.log(`🚀 API server running on http://0.0.0.0:${config.API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
