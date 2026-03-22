import { DatabaseSync } from 'node:sqlite';

export interface TradePost {
  id?: number;
  thread_id: string;
  item_name: string;
  title: string;
  price_fg: string | null;
  item_description: string | null;
  post_date: string | null;
  scraped_at: string;
}

export interface SearchResult extends TradePost {
  rank?: number;
}

export interface DbStats {
  total_posts: number;
  last_scraped: string | null;
}

export function initDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      item_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      price_fg TEXT,
      item_description TEXT,
      post_date TEXT,
      scraped_at TEXT NOT NULL,
      UNIQUE(thread_id, item_name)
    );

    CREATE INDEX IF NOT EXISTS idx_trade_posts_thread_id ON trade_posts(thread_id);
    CREATE INDEX IF NOT EXISTS idx_trade_posts_post_date ON trade_posts(post_date);
  `);

  // FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS trade_posts_fts USING fts5(
      item_name,
      title,
      item_description,
      content='trade_posts',
      content_rowid='id'
    );
  `);

  // Triggers to keep FTS index in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trade_posts_ai AFTER INSERT ON trade_posts BEGIN
      INSERT INTO trade_posts_fts(rowid, item_name, title, item_description)
      VALUES (new.id, new.item_name, new.title, new.item_description);
    END;

    CREATE TRIGGER IF NOT EXISTS trade_posts_ad AFTER DELETE ON trade_posts BEGIN
      INSERT INTO trade_posts_fts(trade_posts_fts, rowid, item_name, title, item_description)
      VALUES ('delete', old.id, old.item_name, old.title, old.item_description);
    END;

    CREATE TRIGGER IF NOT EXISTS trade_posts_au AFTER UPDATE ON trade_posts BEGIN
      INSERT INTO trade_posts_fts(trade_posts_fts, rowid, item_name, title, item_description)
      VALUES ('delete', old.id, old.item_name, old.title, old.item_description);
      INSERT INTO trade_posts_fts(rowid, item_name, title, item_description)
      VALUES (new.id, new.item_name, new.title, new.item_description);
    END;
  `);
  return db;
}

export function upsertPost(db: DatabaseSync, post: TradePost): void {
  const stmt = db.prepare(`
    INSERT INTO trade_posts (thread_id, item_name, title, price_fg, item_description, post_date, scraped_at)
    VALUES (:thread_id, :item_name, :title, :price_fg, :item_description, :post_date, :scraped_at)
    ON CONFLICT(thread_id, item_name) DO UPDATE SET
      title = excluded.title,
      price_fg = excluded.price_fg,
      item_description = excluded.item_description,
      post_date = excluded.post_date,
      scraped_at = excluded.scraped_at
  `);
  stmt.run({
    thread_id: post.thread_id,
    item_name: post.item_name,
    title: post.title,
    price_fg: post.price_fg,
    item_description: post.item_description,
    post_date: post.post_date,
    scraped_at: post.scraped_at,
  });
}

export function upsertPosts(db: DatabaseSync, posts: TradePost[]): void {
  for (const post of posts) {
    upsertPost(db, post);
  }
}

export function searchPosts(db: DatabaseSync, query: string, limit = 50): SearchResult[] {
  if (!query || query.trim().length === 0) {
    // Return most recent posts when no query
    const stmt = db.prepare(`
      SELECT * FROM trade_posts
      ORDER BY scraped_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as unknown as SearchResult[];
  }

  // Sanitize FTS5 query: escape special characters and add prefix matching
  const sanitized = query
    .replace(/['"]/g, '')        // remove quotes
    .replace(/[^\w\s-]/g, ' ')   // keep only word chars, spaces, hyphens
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t}"*`)          // prefix match each token
    .join(' ');

  if (!sanitized) {
    return [];
  }

  const stmt = db.prepare(`
    SELECT tp.*, rank
    FROM trade_posts_fts fts
    JOIN trade_posts tp ON tp.id = fts.rowid
    WHERE trade_posts_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(sanitized, limit) as unknown as SearchResult[];
}

export function getStats(db: DatabaseSync): DbStats {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM trade_posts').get() as unknown as { cnt: number };
  const lastRow = db.prepare('SELECT MAX(scraped_at) as last_scraped FROM trade_posts').get() as unknown as { last_scraped: string | null };
  return {
    total_posts: countRow.cnt,
    last_scraped: lastRow.last_scraped,
  };
}

export function hasThread(db: DatabaseSync, threadId: string): boolean {
  const row = db.prepare('SELECT 1 FROM trade_posts WHERE thread_id = ?').get(threadId);
  return row != null;
}

export function cleanupNoPrice(db: DatabaseSync): number {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM trade_posts WHERE price_fg IS NULL').get() as unknown as { cnt: number };
  db.exec('DELETE FROM trade_posts WHERE price_fg IS NULL');
  return count.cnt;
}
