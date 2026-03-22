import path from 'path';
import { initDb, cleanupNoPrice } from './db.js';
import { syncRecentPosts } from './sync.js';
import { importFromDirectory } from './import.js';
import { createServer } from './server.js';

function parseArgs(argv: string[]): {
  command: string;
  days: number;
  port: number;
  dbPath: string;
  importDir: string;
} {
  let command = 'all'; // default: scrape then serve
  let days = 7;
  let port = 8900;
  let dbPath = 'tmp/d2jsp.sqlite';
  let importDir = '';

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'scrape' || arg === 'serve' || arg === 'all' || arg === 'import' || arg === 'cleanup') {
      command = arg;
    } else if (arg === '--days' && argv[i + 1]) {
      days = parseInt(argv[++i], 10);
    } else if (arg === '--port' && argv[i + 1]) {
      port = parseInt(argv[++i], 10);
    } else if (arg === '--db' && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (arg === '--dir' && argv[i + 1]) {
      importDir = argv[++i];
    }
  }

  return { command, days, port, dbPath, importDir };
}

function printUsage(): void {
  console.log(`
d2jsp Trade Search - Catalog and search D2R trade items from d2jsp forums

Usage: node cli.js <command> [options]

Commands:
  scrape    Scrape recent posts from d2jsp (may fail if Cloudflare blocks)
  import    Import from saved HTML files (recommended)
  serve     Start the search web server
  cleanup   Remove entries without FG prices
  all       Scrape + serve (default)

Options:
  --days N     How many days back to scrape (default: 7)
  --port N     Server port (default: 8900)
  --db PATH    SQLite database path (default: tmp/d2jsp.sqlite)
  --dir PATH   Directory of saved HTML files (for import command)

Import workflow (recommended):
  1. Open https://forums.d2jsp.org/forum.php?f=271&t=3 in your browser
  2. Right-click → "Save As..." → save as HTML
  3. Save individual thread pages the same way
  4. Place all saved HTML files in a directory
  5. Run: node cli.js import --dir ./saved-pages
  6. Run: node cli.js serve
  `);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const logger = console;

  if (args.command === 'help' || process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  const resolvedDb = path.resolve(args.dbPath);
  logger.info(`Using database: ${resolvedDb}`);

  const db = initDb(resolvedDb);

  if (args.command === 'cleanup') {
    const removed = cleanupNoPrice(db);
    logger.info(`Cleanup: removed ${removed} entries with no FG price`);
    db.close();
    return;
  }

  if (args.command === 'import') {
    if (!args.importDir) {
      logger.error('Error: --dir is required for import command');
      printUsage();
      process.exit(1);
    }
    const result = importFromDirectory(db, path.resolve(args.importDir), { logger });
    logger.info(`Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.errors} errors`);
    db.close();
    return;
  }

  if (args.command === 'scrape' || args.command === 'all') {
    logger.info(`Scraping recent ${args.days} days from d2jsp forum 271...`);
    logger.info(`Note: d2jsp uses Cloudflare protection. If scraping fails, use "import" command instead.`);
    const result = await syncRecentPosts(db, {
      forumId: 271,
      maxDays: args.days,
      logger,
    });
    logger.info(`Scrape complete: ${result.scraped} new, ${result.skipped} skipped, ${result.pages} pages`);
  }

  if (args.command === 'serve' || args.command === 'all') {
    const server = createServer({ port: args.port, db, logger });
    await server.start();
    logger.info(`Server running at http://localhost:${args.port}`);
    logger.info(`Search UI: http://localhost:${args.port}/`);
    logger.info(`API: http://localhost:${args.port}/api/search?q=shako`);
    logger.info(`Upload HTML: POST http://localhost:${args.port}/api/import (body: {html: "..."})`);
  }

  if (args.command === 'scrape' || args.command === 'import') {
    db.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
