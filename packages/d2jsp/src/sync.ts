import { DatabaseSync } from 'node:sqlite';
import { upsertPost, hasThread } from './db.js';
import type { TradePost } from './db.js';
import {
  fetchForumPage,
  parseForumPage,
  fetchThread,
  parseThread,
  sleep,
  DEFAULT_DELAY_MS,
} from './scraper.js';
import type { ForumThread } from './scraper.js';

export interface SyncOptions {
  forumId: number;
  maxDays: number;
  delayMs: number;
  maxPages: number;
  logger: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void };
}

const DEFAULT_OPTIONS: SyncOptions = {
  forumId: 271,
  maxDays: 7,
  delayMs: DEFAULT_DELAY_MS,
  maxPages: 20,
  logger: console,
};

/**
 * Scrape recent trade posts from d2jsp and upsert them into the database.
 * Paginates through forum listings until posts exceed maxDays or maxPages is hit.
 */
export async function syncRecentPosts(
  db: DatabaseSync,
  options: Partial<SyncOptions> = {},
): Promise<{ scraped: number; skipped: number; pages: number }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { forumId, maxDays, delayMs, maxPages, logger } = opts;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxDays);

  let scraped = 0;
  let skipped = 0;
  let page = 1;
  let reachedCutoff = false;

  logger.info(`Starting sync: forum=${forumId}, maxDays=${maxDays}, maxPages=${maxPages}`);

  while (page <= maxPages && !reachedCutoff) {
    logger.info(`Fetching forum page ${page}...`);

    let html: string;
    try {
      html = await fetchForumPage(forumId, page);
    } catch (err) {
      logger.warn(`Failed to fetch page ${page}: ${err}`);
      break;
    }

    const threads = parseForumPage(html);
    if (threads.length === 0) {
      logger.info(`No threads found on page ${page}, stopping.`);
      break;
    }

    logger.info(`Found ${threads.length} threads on page ${page}`);

    for (const thread of threads) {
      // Check if post date suggests we've gone past the cutoff
      if (isOlderThanCutoff(thread.postDate, cutoffDate)) {
        reachedCutoff = true;
        logger.info(`Reached cutoff date at thread ${thread.threadId}`);
        break;
      }

      // Skip threads already in DB
      if (hasThread(db, thread.threadId)) {
        skipped++;
        continue;
      }

      // Rate limit before fetching thread details
      await sleep(delayMs);

      try {
        const threadHtml = await fetchThread(thread.threadId);
        const detail = parseThread(threadHtml, thread.threadId);
        const now = new Date().toISOString();

        if (detail.items.length > 0) {
          for (const item of detail.items) {
            const post: TradePost = {
              thread_id: thread.threadId,
              item_name: item.name,
              title: detail.title || thread.title,
              price_fg: item.priceFg,
              item_description: item.description || null,
              post_date: detail.postDate || thread.postDate || null,
              scraped_at: now,
            };
            upsertPost(db, post);
          }
        } else {
          const post: TradePost = {
            thread_id: thread.threadId,
            item_name: detail.title || thread.title,
            title: detail.title || thread.title,
            price_fg: detail.priceFg,
            item_description: detail.firstPostBody || null,
            post_date: detail.postDate || thread.postDate || null,
            scraped_at: now,
          };
          upsertPost(db, post);
        }

        scraped++;
        logger.info(`Scraped thread ${thread.threadId}: ${detail.title || thread.title} (${detail.items.length} items)`);
      } catch (err) {
        logger.warn(`Failed to scrape thread ${thread.threadId}: ${err}`);
      }
    }

    page++;

    // Rate limit between pages
    if (!reachedCutoff && page <= maxPages) {
      await sleep(delayMs);
    }
  }

  logger.info(`Sync complete: scraped=${scraped}, skipped=${skipped}, pages=${page - 1}`);
  return { scraped, skipped, pages: page - 1 };
}

/**
 * Check if a relative date string (e.g. "5 days ago") is older than the cutoff.
 */
function isOlderThanCutoff(dateStr: string, cutoff: Date): boolean {
  if (!dateStr) return false;

  // Relative dates: "X days ago", "X hours ago", etc.
  const relMatch = dateStr.match(/(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const now = new Date();
    let postDate = new Date(now);

    switch (unit) {
      case 'second': postDate.setSeconds(now.getSeconds() - amount); break;
      case 'minute': postDate.setMinutes(now.getMinutes() - amount); break;
      case 'hour': postDate.setHours(now.getHours() - amount); break;
      case 'day': postDate.setDate(now.getDate() - amount); break;
      case 'week': postDate.setDate(now.getDate() - amount * 7); break;
      case 'month': postDate.setMonth(now.getMonth() - amount); break;
    }

    return postDate < cutoff;
  }

  // Absolute dates: "Mar 6 2023"
  const absMatch = dateStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s+(\d{4}))?/i);
  if (absMatch) {
    const year = absMatch[3] ? parseInt(absMatch[3], 10) : new Date().getFullYear();
    const dateObj = new Date(`${absMatch[1]} ${absMatch[2]} ${year}`);
    return dateObj < cutoff;
  }

  return false;
}
