import { Diablo2Mpq, Diablo2Item } from '@diablo2/data';
import { toHex } from 'binparse';
import { Process } from './process.js';
import { LogType } from './logger.js';

/**
 * When D2R is running, this scanner searches its process memory for the
 * in-memory ItemsTxt table (Weapons + Armor + Misc concatenated).
 *
 * D2R loads item data from its own CASC archive, which may differ from
 * the classic 1.13c MPQ files in assets/d2/.  In particular, newer D2R
 * patches add items (Sunder Charms, etc.) that shift txtFileNo indices.
 * By reading the table directly from the game's memory, we get the exact
 * mapping the game uses, regardless of version or mods.
 *
 * Algorithm:
 *   1. Scan D2R's readable memory for the 4-byte item code "hax\0"
 *      (Hand Axe — always the first weapon in every D2/D2R version).
 *   2. For each candidate hit, try common record strides and check
 *      whether the second item code is "axe\0" (Axe).
 *   3. Once the stride is confirmed, read all item codes from the table.
 *   4. Map each txtFileNo (array index) to its item code string.
 *   5. Look up Diablo2Mpq.items.byCode to resolve code → nameId.
 */

/** First few expected weapon codes — used for validation. */
const EXPECTED_FIRST_CODES = ['hax', 'axe', '2ax', 'mpi'];

/** Maximum number of items to read from the table. */
const MAX_ITEMS = 1200;

/**
 * The result of scanning D2R's memory for the ItemsTxt table.
 * Maps txtFileNo → Diablo2Item (code + nameId).
 */
export interface D2RItemTable {
  /** Map from txtFileNo (global item index) to item info. */
  byIndex: Map<number, Diablo2Item>;
  /** Total number of items found in the table. */
  count: number;
  /** The stride (bytes per ItemsTxt record) discovered by the scan. */
  stride: number;
  /** The memory address where the table starts. */
  baseAddress: number;
}

/**
 * Scan D2R's process memory for the in-memory ItemsTxt table.
 * Returns a D2RItemTable if found, or null if the table could not be located.
 */
export async function scanD2RItemsTable(
  proc: Process,
  logger: LogType,
): Promise<D2RItemTable | null> {
  // The needle: "hax\0" — the first weapon code (Hand Axe)
  const needle = Buffer.from('hax\0', 'ascii');
  // The second code: "axe\0"
  const secondNeedle = Buffer.from('axe\0', 'ascii');

  // Common ItemsTxt record sizes in D2R (depends on version).
  // We try a range of strides to discover the correct one.
  const candidateStrides: number[] = [];
  // Typical D2R ItemsTxt sizes are 0x298..0x2E0 (664..736 bytes)
  for (let s = 0x280; s <= 0x320; s += 4) candidateStrides.push(s);
  // Also try a wider range in case the version is very different
  for (let s = 0x200; s < 0x280; s += 4) candidateStrides.push(s);
  for (let s = 0x324; s <= 0x400; s += 4) candidateStrides.push(s);

  logger.debug({}, 'D2R:ItemsScan:Start');

  // Scan all readable+writable memory regions for "hax\0"
  for await (const { buffer, offset: regionBase, map } of proc.scan()) {
    // Skip very small regions — the items table is at least 200KB
    if (buffer.length < 200_000) continue;

    let searchPos = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const idx = buffer.indexOf(needle, searchPos);
      if (idx < 0) break;
      searchPos = idx + 4;

      const tableBase = regionBase + idx;

      // Try each candidate stride to see if the second item is "axe\0"
      for (const stride of candidateStrides) {
        // Check second item at tableBase + stride
        const secondOffset = idx + stride;
        if (secondOffset + 4 > buffer.length) continue;

        if (
          buffer[secondOffset] === secondNeedle[0] &&
          buffer[secondOffset + 1] === secondNeedle[1] &&
          buffer[secondOffset + 2] === secondNeedle[2] &&
          buffer[secondOffset + 3] === secondNeedle[3]
        ) {
          // Found a candidate! Validate with the third and fourth items.
          const thirdCode = readCode(buffer, idx + stride * 2);
          const fourthCode = readCode(buffer, idx + stride * 3);

          if (thirdCode === EXPECTED_FIRST_CODES[2] && fourthCode === EXPECTED_FIRST_CODES[3]) {
            // Confirmed! Read all item codes from this table.
            logger.info(
              { base: toHex(tableBase), stride: toHex(stride), region: toHex(regionBase) },
              'D2R:ItemsScan:Found',
            );

            const result = readItemsTable(buffer, idx, stride, regionBase);
            logger.info(
              { count: result.count, stride: toHex(stride), base: toHex(result.baseAddress) },
              'D2R:ItemsScan:Loaded',
            );
            return result;
          }
        }
      }
    }
  }

  logger.warn({}, 'D2R:ItemsScan:NotFound');
  return null;
}

/**
 * Read a 3-4 character item code at a given buffer offset.
 * Returns the trimmed code string, or empty string if out of bounds.
 */
function readCode(buf: Buffer, offset: number): string {
  if (offset + 4 > buf.length) return '';
  // Read 4 bytes and trim null bytes
  const raw = buf.slice(offset, offset + 4);
  const nullIdx = raw.indexOf(0);
  if (nullIdx === 0) return '';
  return raw.slice(0, nullIdx >= 0 ? nullIdx : 4).toString('ascii');
}

/**
 * Read all item records from the in-memory table, starting at the found position.
 * Returns a D2RItemTable with the byIndex map populated.
 */
function readItemsTable(
  buf: Buffer,
  startOffset: number,
  stride: number,
  regionBase: number,
): D2RItemTable {
  const byIndex = new Map<number, Diablo2Item>();
  let count = 0;

  for (let i = 0; i < MAX_ITEMS; i++) {
    const recordOffset = startOffset + i * stride;
    if (recordOffset + 4 > buf.length) break;

    const code = readCode(buf, recordOffset);
    if (code === '') break; // End of table (null code)

    // Try to find this item in the classic MPQ data by code
    const mpqItem = Diablo2Mpq.items.byCode.get(code);
    const nameId = mpqItem?.nameId ?? 0;

    byIndex.set(i, { code, nameId });
    count++;
  }

  return {
    byIndex,
    count,
    stride,
    baseAddress: regionBase + startOffset,
  };
}
