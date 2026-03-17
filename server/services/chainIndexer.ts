/**
 * chainIndexer.ts — Server-side Hive block indexer for message recovery
 *
 * Adapted from Ragnarok's chainIndexer.ts.
 * Scans irreversible blocks sequentially, extracts messenger custom_json
 * and transfer ops, stores them in PostgreSQL for client gap-fill queries.
 *
 * - Crash-safe: cursor only advances after full block is processed
 * - Sequential block scanning via get_ops_in_block
 * - Filters for hive-messenger-text, hive-messenger-img, and encrypted transfers
 */

import { db } from '../db';
import { blockchainOps } from '@shared/schema';
import { loadState, getBlockCursor, setBlockCursor, setGenesisBlock } from './chainState';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HIVE_NODES = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
];

const NODE_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 10_000;   // Same as Ragnarok
const BLOCKS_PER_BATCH = 20;       // Smaller batches (messenger ops are sparser)

// Genesis: approximate block where hive-messenger custom_json was first used.
// Set this to a reasonable recent block to avoid scanning from block 1.
// Can be overridden via environment variable.
const DEFAULT_GENESIS_BLOCK = parseInt(process.env.INDEXER_GENESIS_BLOCK || '0', 10);

// ---------------------------------------------------------------------------
// Hive RPC (same pattern as Ragnarok chainIndexer)
// ---------------------------------------------------------------------------

interface HiveRpcResponse<T> {
  result?: T;
  error?: { message: string };
}

async function callHive<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error = new Error('No Hive nodes configured');

  for (const node of HIVE_NODES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NODE_TIMEOUT_MS);

    try {
      const res = await fetch(node, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: controller.signal,
      });

      const data = (await res.json()) as HiveRpcResponse<T>;
      if (data.result !== undefined) return data.result;
      if (data.error) throw new Error(data.error.message);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Block-level APIs
// ---------------------------------------------------------------------------

interface BlockOp {
  trx_id: string;
  block: number;
  trx_in_block: number;
  op_in_trx: number;
  timestamp: string;
  op: [string, Record<string, unknown>];
}

async function getOpsInBlock(blockNum: number): Promise<BlockOp[]> {
  return callHive<BlockOp[]>('condenser_api.get_ops_in_block', [blockNum, false]);
}

async function getLastIrreversibleBlock(): Promise<number> {
  const props = await callHive<{ last_irreversible_block_num: number }>(
    'condenser_api.get_dynamic_global_properties', [],
  );
  return props.last_irreversible_block_num;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _isSyncing = false;

// ---------------------------------------------------------------------------
// Block scanner (adapted from Ragnarok chainIndexer.scanBlocks)
// ---------------------------------------------------------------------------

async function scanBlocks(): Promise<number> {
  const cursor = getBlockCursor();
  let lib: number;

  try {
    lib = await getLastIrreversibleBlock();
  } catch (err) {
    console.warn('[chainIndexer] Failed to get LIB:', err instanceof Error ? err.message : err);
    return 0;
  }

  if (cursor >= lib) return 0; // fully caught up

  const startBlock = cursor + 1;
  const endBlock = Math.min(startBlock + BLOCKS_PER_BATCH - 1, lib);
  let totalStored = 0;

  for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
    let ops: BlockOp[];
    try {
      ops = await getOpsInBlock(blockNum);
    } catch (err) {
      console.warn(`[chainIndexer] Failed to fetch block ${blockNum}:`, err instanceof Error ? err.message : err);
      break; // Stop here, cursor stays at last completed block
    }

    let blockStored = 0;

    for (const op of ops) {
      const [opType, opData] = op.op;

      // Handle custom_json messenger operations
      if (opType === 'custom_json') {
        const cjId = (opData as any).id as string;
        if (cjId !== 'hive-messenger-text' && cjId !== 'hive-messenger-img') continue;

        const sender = (opData as any).required_posting_auths?.[0] ||
                        (opData as any).required_auths?.[0];
        if (!sender) continue;

        let jsonData: any;
        try {
          jsonData = JSON.parse((opData as any).json || '{}');
        } catch { continue; }

        const recipient = jsonData.to || '';
        const opTypeStr = cjId === 'hive-messenger-text' ? 'custom_json_text' : 'custom_json_img';

        try {
          await db.insert(blockchainOps).values({
            txId: op.trx_id,
            blockNum: op.block,
            opType: opTypeStr,
            sender,
            recipient,
            payload: jsonData.e || '',
            hash: jsonData.h || null,
            amount: null,
            sessionId: jsonData.sid || null,
            chunkIndex: jsonData.idx ?? null,
            totalChunks: jsonData.tot ?? null,
            timestamp: new Date(op.timestamp + 'Z'),
          }).onConflictDoNothing();
          blockStored++;
        } catch (err) {
          // Ignore duplicate key errors (idempotent)
          if (!(err instanceof Error) || !err.message.includes('duplicate')) {
            console.warn('[chainIndexer] Failed to store op:', err);
          }
        }
      }

      // Handle transfer operations with encrypted memos
      if (opType === 'transfer') {
        const transfer = opData as any;
        if (!transfer.memo || !transfer.memo.startsWith('#')) continue;

        try {
          await db.insert(blockchainOps).values({
            txId: op.trx_id,
            blockNum: op.block,
            opType: 'transfer',
            sender: transfer.from,
            recipient: transfer.to,
            payload: transfer.memo,
            hash: null,
            amount: transfer.amount || null,
            sessionId: null,
            chunkIndex: null,
            totalChunks: null,
            timestamp: new Date(op.timestamp + 'Z'),
          }).onConflictDoNothing();
          blockStored++;
        } catch (err) {
          if (!(err instanceof Error) || !err.message.includes('duplicate')) {
            console.warn('[chainIndexer] Failed to store transfer:', err);
          }
        }
      }
    }

    // Block fully processed — advance cursor atomically
    await setBlockCursor(blockNum);
    totalStored += blockStored;
  }

  return totalStored;
}

// ---------------------------------------------------------------------------
// Poll loop (same pattern as Ragnarok)
// ---------------------------------------------------------------------------

async function pollNext(): Promise<void> {
  if (_isSyncing) return;
  _isSyncing = true;

  try {
    const stored = await scanBlocks();
    if (stored > 0) {
      console.log(`[chainIndexer] Processed ${stored} ops, cursor now at block ${getBlockCursor()}`);
    }
  } catch (err) {
    console.warn('[chainIndexer] Poll error:', err instanceof Error ? err.message : err);
  } finally {
    _isSyncing = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startIndexer(): Promise<void> {
  if (_pollTimer) return;

  await loadState();

  // Set genesis block if this is a fresh install
  if (DEFAULT_GENESIS_BLOCK > 0) {
    await setGenesisBlock(DEFAULT_GENESIS_BLOCK);
  }

  // Immediate first scan
  pollNext();

  _pollTimer = setInterval(pollNext, POLL_INTERVAL_MS);
  console.log(
    '[chainIndexer] Started block scanner (every %ds, cursor at block %d)',
    POLL_INTERVAL_MS / 1000,
    getBlockCursor(),
  );
}

export function stopIndexer(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  console.log('[chainIndexer] Stopped');
}

export function getIndexerStatus(): { cursor: number; isRunning: boolean } {
  return {
    cursor: getBlockCursor(),
    isRunning: _pollTimer !== null,
  };
}
