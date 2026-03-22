import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { upsertPost, hasThread } from './db.js';
import type { TradePost } from './db.js';
import { parseForumPage, parseThread } from './scraper.js';

export interface ImportOptions {
  logger: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void };
}

/**
 * Import trade posts from saved HTML files (forum listing pages and/or thread pages).
 *
 * How to get the HTML files:
 *   1. Open https://forums.d2jsp.org/forum.php?f=271&t=3 in your browser
 *   2. Right-click → "Save As..." → save as "Complete webpage" or "HTML only"
 *   3. Repeat for individual thread pages you want to catalog
 *   4. Place saved HTML files in a directory and run: node cli.js import --dir ./saved-pages
 *
 * The importer auto-detects whether each file is a forum listing or a thread page.
 */
export function importFromDirectory(
  db: DatabaseSync,
  dirPath: string,
  opts: ImportOptions,
): { imported: number; skipped: number; errors: number } {
  const { logger } = opts;
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.html') || f.endsWith('.htm'));

  if (files.length === 0) {
    logger.warn(`No HTML files found in ${dirPath}`);
    return { imported, skipped, errors };
  }

  logger.info(`Found ${files.length} HTML files in ${dirPath}`);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const html = fs.readFileSync(filePath, 'utf-8');
      const result = importHtml(db, html, logger);
      imported += result.imported;
      skipped += result.skipped;
      logger.info(`Processed ${file}: ${result.imported} imported, ${result.skipped} skipped`);
    } catch (err) {
      logger.warn(`Error processing ${file}: ${err}`);
      errors++;
    }
  }

  return { imported, skipped, errors };
}

/**
 * Import trade posts from raw HTML content.
 * Auto-detects whether it's a forum listing page or a single thread page.
 */
export function importHtml(
  db: DatabaseSync,
  html: string,
  logger: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void },
): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;

  // Check if this is a forum listing page (contains multiple topic links)
  // or a single thread page (contains post content)
  const isForumListing = html.includes('forum.php') && (html.match(/topic\.php\?t=\d+/g) || []).length > 3;

  if (isForumListing) {
    // Parse as forum listing — extract thread metadata
    const threads = parseForumPage(html);
    logger.info(`Forum listing: found ${threads.length} threads`);

    for (const thread of threads) {
      if (hasThread(db, thread.threadId)) {
        skipped++;
        continue;
      }

      const post: TradePost = {
        thread_id: thread.threadId,
        item_name: thread.title,
        title: thread.title,
        price_fg: null,
        item_description: null,
        post_date: thread.postDate || null,
        scraped_at: new Date().toISOString(),
      };

      upsertPost(db, post);
      imported++;
    }
  } else {
    // Parse as single thread — extract full details including multiple items
    const threadIdMatch = html.match(/topic\.php\?(?:[^#]*&)?t=(\d+)/);
    const threadId = threadIdMatch ? threadIdMatch[1] : `manual-${Date.now()}`;

    const detail = parseThread(html, threadId);
    const now = new Date().toISOString();

    if (detail.items.length > 0) {
      // Store each item as a separate row
      for (const item of detail.items) {
        const post: TradePost = {
          thread_id: threadId,
          item_name: item.name,
          title: detail.title,
          price_fg: item.priceFg,
          item_description: item.description || null,
          post_date: detail.postDate || null,
          scraped_at: now,
        };
        upsertPost(db, post);
        imported++;
      }
    } else {
      // Fallback: store as single item using title
      const post: TradePost = {
        thread_id: threadId,
        item_name: detail.title,
        title: detail.title,
        price_fg: detail.priceFg,
        item_description: detail.firstPostBody || null,
        post_date: detail.postDate || null,
        scraped_at: now,
      };
      upsertPost(db, post);
      imported++;
    }
  }

  return { imported, skipped };
}
