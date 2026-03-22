import { parse, HTMLElement } from 'node-html-parser';

const BASE_URL = 'https://forums.d2jsp.org';
const DEFAULT_DELAY_MS = 2000;

// Browser-like headers to work with Cloudflare-protected sites.
// If d2jsp still blocks requests, use the file-import approach instead.
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

export interface ForumThread {
  threadId: string;
  title: string;
  author: string;
  postDate: string;
  url: string;
}

export interface ThreadItem {
  name: string;
  priceFg: string | null;
  description: string;
}

export interface ThreadDetail {
  threadId: string;
  title: string;
  firstPostBody: string;
  postDate: string;
  priceFg: string | null;
  items: ThreadItem[];
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a single forum listing page. Returns raw HTML.
 * Forum 271 = D2R Softcore Ladder, t=3 = FT/ISO/Services/Price Checks
 * Pagination: p=1, p=2, etc.
 */
export async function fetchForumPage(forumId: number, page: number): Promise<string> {
  const url = `${BASE_URL}/forum.php?f=${forumId}&t=3&p=${page}`;
  return fetchPage(url);
}

/**
 * Parse the forum listing HTML to extract thread metadata.
 */
export function parseForumPage(html: string): ForumThread[] {
  const root = parse(html);
  const threads: ForumThread[] = [];

  // Forum listing rows contain links to topic.php?t=<id>
  const links = root.querySelectorAll('a');

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/topic\.php\?t=(\d+)(?:&f=(\d+))?/);
    if (!match) continue;

    const threadId = match[1];
    const title = link.text.trim();

    // Skip empty titles, navigation links, sticky/pinned threads
    if (!title || title.length < 3) continue;
    // Skip "»" page indicators that are child links within a topic row
    if (title.startsWith('»') && title.length < 5) continue;

    // Avoid duplicate thread IDs (pagination links etc)
    if (threads.some((t) => t.threadId === threadId)) continue;

    // Try to find the parent row to extract date info
    let postDate = '';
    let author = '';
    const row = findParentRow(link);
    if (row) {
      const dateInfo = extractDateFromRow(row);
      if (dateInfo) postDate = dateInfo;
      const authorInfo = extractAuthorFromRow(row);
      if (authorInfo) author = authorInfo;
    }

    threads.push({
      threadId,
      title,
      author,
      postDate,
      url: `${BASE_URL}/topic.php?t=${threadId}&f=271`,
    });
  }

  return threads;
}

function findParentRow(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el;
  while (current) {
    if (current.tagName === 'TR') return current;
    current = current.parentNode as HTMLElement | null;
  }
  return null;
}

function extractDateFromRow(row: HTMLElement): string {
  const text = row.text;
  // Look for date patterns like "2 days ago", "1 hour ago", "Mar 6 2023"
  const relMatch = text.match(/(\d+\s+(?:second|minute|hour|day|week|month)s?\s+ago)/i);
  if (relMatch) return relMatch[1];

  const absMatch = text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:\s+\d{4})?)/i);
  if (absMatch) return absMatch[1];

  return '';
}

function extractAuthorFromRow(row: HTMLElement): string {
  // Author is typically in a link to user.php
  const userLink = row.querySelector('a[href*="user.php"]');
  if (userLink) return userLink.text.trim();
  return '';
}

/**
 * Fetch a single thread page.
 */
export async function fetchThread(threadId: string): Promise<string> {
  const url = `${BASE_URL}/topic.php?t=${threadId}&f=271`;
  return fetchPage(url);
}

/**
 * Parse thread HTML to extract item details from the first post.
 */
export function parseThread(html: string, threadId: string): ThreadDetail {
  const root = parse(html);

  // Extract thread title
  let title = '';
  const titleEl = root.querySelector('title');
  if (titleEl) {
    title = titleEl.text
      .replace(/\s*-\s*d2jsp.*$/i, '')
      .replace(/^\s*d2jsp\s*.*?>\s*/i, '')
      .trim();
  }

  // Find the first post body — posts are typically in table cells or divs
  // d2jsp uses table-based layout; first post content is after the user info block
  let firstPostBody = '';
  let postDate = '';

  // Extract date from anywhere in the page
  const dateMatch = root.text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}(?:am|pm)?)/i);
  if (dateMatch) {
    postDate = dateMatch[1];
  }

  // Strategy 1: Look for specific post-body class/id elements (inner-most content)
  const bodySelectors = ['.post-body', '.post-content', '.message-body', '#post-body', '.postcontent'];
  for (const sel of bodySelectors) {
    const el = root.querySelector(sel);
    if (el) {
      firstPostBody = el.text.trim().substring(0, 2000);
      break;
    }
  }

  // Strategy 2: Look for td cells that contain post content (d2jsp table layout)
  if (!firstPostBody) {
    const allTds = root.querySelectorAll('td');
    for (const td of allTds) {
      const text = td.text.trim();
      if (text.length <= 20) continue;

      // Skip navigation and user info cells
      const hasNavLinks = td.querySelector('a[href*="forum.php"]') || td.querySelector('a[href*="index.php"]');
      const hasUserInfo = td.querySelector('a[href*="user.php"]');
      if (hasNavLinks || hasUserInfo) continue;
      if (/^bump$/i.test(text)) continue;

      // Prefer inner-most child that still has substantial text
      const innerDivs = td.querySelectorAll('div');
      let bestInner = '';
      for (const div of innerDivs) {
        const divText = div.text.trim();
        if (divText.length > 20 && !divText.includes('d2jsp Forums') && !divText.includes('Log In')) {
          // Pick the inner-most (smallest containing) div with enough content
          if (!bestInner || divText.length < bestInner.length) {
            bestInner = divText;
          }
        }
      }
      firstPostBody = (bestInner || text).substring(0, 2000);
      break;
    }
  }

  // Strategy 3: Broad div search as last resort
  if (!firstPostBody) {
    const postDivs = root.querySelectorAll('div');
    for (const div of postDivs) {
      const text = div.text.trim();
      if (text.length > 20 && !text.includes('d2jsp Forums') && !text.includes('Log In')) {
        firstPostBody = text.substring(0, 2000);
        break;
      }
    }
  }

  const priceFg = extractPrice(title + ' ' + firstPostBody);
  const items = extractItems(title, firstPostBody);

  return {
    threadId,
    title: title || `Thread #${threadId}`,
    firstPostBody,
    postDate,
    priceFg,
    items,
  };
}

/**
 * Best-effort extraction of Forum Gold price from text.
 * Common patterns: "40fg", "40 fg", "100 Forum Gold", "BIN 50fg", "c/o 30fg"
 */
export function extractPrice(text: string): string | null {
  // Try explicit FG patterns
  const patterns = [
    /(\d+(?:\.\d+)?)\s*fg\b/i,
    /(\d+(?:\.\d+)?)\s*forum\s*gold/i,
    /bin\s*:?\s*(\d+(?:\.\d+)?)\s*fg/i,
    /b\/o\s*:?\s*(\d+(?:\.\d+)?)\s*fg/i,
    /price\s*:?\s*(\d+(?:\.\d+)?)\s*fg/i,
    /asking\s*:?\s*(\d+(?:\.\d+)?)\s*fg/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1] + ' fg';
  }

  return null;
}

/**
 * Split a post into individual trade items.
 * Handles common d2jsp formats:
 *   - Line-per-item lists (newline/br separated)
 *   - Slash-separated: "Shako 40fg / Oculus 10fg / War Travs 15fg"
 *   - Comma-separated with prices
 * Falls back to treating the whole post as one item.
 */
export function extractItems(title: string, body: string): ThreadItem[] {
  const items: ThreadItem[] = [];
  const seen = new Set<string>();

  // Strip title text from the body if it was accidentally concatenated
  let text = body.replace(/\r/g, '');
  if (title) {
    // Remove the title (or cleaned variants) from the start of the body
    const titleVariants = [
      title,
      title.replace(/^(?:wts|wtt|ft|iso|selling|trading|for trade)\s*:?\s*/i, '').trim(),
    ];
    for (const v of titleVariants) {
      if (v && text.startsWith(v)) {
        text = text.substring(v.length).trim();
        break;
      }
    }
  }

  // Split on newlines first (most common multi-item format)
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 3);

  // Try to find item+price pairs in each line
  for (const line of lines) {
    // Skip noise lines
    if (/^(bump|up|free bump|\^+|tt|t4t|thanks)/i.test(line)) continue;
    if (/^(reply|quote|posted|edited|post|report|profile)/i.test(line)) continue;

    // Check for slash-separated items within a single line: "Shako 40fg / Oculus 10fg"
    const slashParts = line.split(/\s*\/\s*/);
    if (slashParts.length > 1 && slashParts.every((p) => extractPrice(p) !== null)) {
      for (const part of slashParts) {
        const item = parseItemFromText(part);
        if (item && !seen.has(item.name.toLowerCase())) {
          seen.add(item.name.toLowerCase());
          items.push(item);
        }
      }
      continue;
    }

    // Try this line as a single item
    const item = parseItemFromText(line);
    if (item && !seen.has(item.name.toLowerCase())) {
      seen.add(item.name.toLowerCase());
      items.push(item);
    }
  }

  // If no items found from body, try the title
  if (items.length === 0) {
    const titleItem = parseItemFromText(title);
    if (titleItem) {
      items.push(titleItem);
    }
  }

  return items;
}

function parseItemFromText(text: string): ThreadItem | null {
  const price = extractPrice(text);
  if (!price) return null;

  // Remove the price portion to get the item name
  let name = text
    .replace(/\d+(?:\.\d+)?\s*fg\b/gi, '')
    .replace(/\b(?:bin|b\/o|c\/o|price|asking|offer|want)\s*:?\s*/gi, '')
    .replace(/\b(?:wts|wtt|ft|iso|selling|trading|for trade)\s*:?\s*/gi, '')
    .replace(/[\-\|:]+\s*$/g, '')
    .replace(/^\s*[\-\|:]+/g, '')
    .trim();

  // Collapse multiple spaces
  name = name.replace(/\s+/g, ' ').trim();

  if (!name || name.length < 2) return null;

  return { name, priceFg: price, description: text.trim() };
}

export { DEFAULT_DELAY_MS };
