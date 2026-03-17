/**
 * chainState.ts — PostgreSQL-backed cursor management for block indexer
 *
 * Adapted from Ragnarok's chainState.ts but uses PostgreSQL (via Drizzle)
 * instead of JSON file persistence.
 */

import { db } from '../db';
import { indexerState } from '@shared/schema';
import { eq } from 'drizzle-orm';

const BLOCK_CURSOR_KEY = 'block_cursor';

// In-memory cache for fast reads during block scanning
let _blockCursor: number = 0;
let _loaded = false;

export async function loadState(): Promise<void> {
  try {
    const row = await db.select()
      .from(indexerState)
      .where(eq(indexerState.key, BLOCK_CURSOR_KEY))
      .limit(1);

    if (row.length > 0) {
      _blockCursor = parseInt(row[0].value, 10) || 0;
    }
    _loaded = true;
    console.log('[chainState] Loaded block cursor:', _blockCursor);
  } catch (err) {
    console.warn('[chainState] Failed to load state, starting from 0:', err);
    _blockCursor = 0;
    _loaded = true;
  }
}

export function getBlockCursor(): number {
  return _blockCursor;
}

export async function setBlockCursor(blockNum: number): Promise<void> {
  _blockCursor = blockNum;

  try {
    // Upsert: insert or update
    const existing = await db.select()
      .from(indexerState)
      .where(eq(indexerState.key, BLOCK_CURSOR_KEY))
      .limit(1);

    if (existing.length > 0) {
      await db.update(indexerState)
        .set({ value: blockNum.toString(), updatedAt: new Date() })
        .where(eq(indexerState.key, BLOCK_CURSOR_KEY));
    } else {
      await db.insert(indexerState)
        .values({ key: BLOCK_CURSOR_KEY, value: blockNum.toString(), updatedAt: new Date() });
    }
  } catch (err) {
    console.error('[chainState] Failed to persist block cursor:', err);
  }
}

/**
 * Set the genesis block (first block to scan from).
 * Only sets if no cursor exists yet (fresh install).
 */
export async function setGenesisBlock(blockNum: number): Promise<void> {
  if (_blockCursor > 0) return; // Already have progress, don't reset

  const existing = await db.select()
    .from(indexerState)
    .where(eq(indexerState.key, BLOCK_CURSOR_KEY))
    .limit(1);

  if (existing.length === 0) {
    _blockCursor = blockNum;
    await db.insert(indexerState)
      .values({ key: BLOCK_CURSOR_KEY, value: blockNum.toString(), updatedAt: new Date() });
    console.log('[chainState] Set genesis block cursor:', blockNum);
  }
}
