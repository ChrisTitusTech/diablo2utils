import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { searchPosts, getStats, cleanupNoPrice } from './db.js';
import { importHtml } from './import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  port: number;
  db: DatabaseSync;
  logger: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void };
}

export function createServer(opts: ServerOptions): { app: express.Express; start: () => Promise<void> } {
  const { port, db, logger } = opts;
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.text({ limit: '5mb', type: 'text/html' }));

  // Serve static files (search UI)
  const staticDir = path.join(__dirname, '..', 'static');
  const distWwwDir = path.join(__dirname, 'www');
  app.use(express.static(staticDir));
  app.use(express.static(distWwwDir));

  // Search API
  app.get('/api/search', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limitStr = typeof req.query.limit === 'string' ? req.query.limit : '50';
    const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200);

    try {
      const results = searchPosts(db, query, limit);
      res.json({ query, count: results.length, results });
    } catch (err) {
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // Stats API
  app.get('/api/stats', (_req, res) => {
    try {
      const stats = getStats(db);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // Import HTML endpoint — accepts JSON body with {html: "..."} or raw HTML text
  app.post('/api/import', (req, res) => {
    try {
      let html: string;
      if (typeof req.body === 'string') {
        html = req.body;
      } else if (req.body && typeof req.body.html === 'string') {
        html = req.body.html;
      } else {
        res.status(400).json({ error: 'Request body must be {html: "..."} or raw HTML text (Content-Type: text/html)' });
        return;
      }

      if (html.length < 100) {
        res.status(400).json({ error: 'HTML content too short' });
        return;
      }

      const result = importHtml(db, html, logger);
      res.json({ message: 'Import complete', ...result });
    } catch (err) {
      logger.warn(`Import error: ${err}`);
      res.status(500).json({ error: 'Import failed' });
    }
  });

  // Cleanup: remove entries with no FG price
  app.post('/api/cleanup', (_req, res) => {
    try {
      const removed = cleanupNoPrice(db);
      const stats = getStats(db);
      res.json({ message: `Removed ${removed} entries with no FG price`, removed, remaining: stats.total_posts });
    } catch (err) {
      res.status(500).json({ error: 'Cleanup failed' });
    }
  });

  function start(): Promise<void> {
    return new Promise((resolve) => {
      app.listen(port, () => {
        logger.info(`d2jsp trade search server listening on http://localhost:${port}`);
        resolve();
      });
    });
  }

  return { app, start };
}
