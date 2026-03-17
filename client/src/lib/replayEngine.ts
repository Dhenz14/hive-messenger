/**
 * replayEngine.ts — Client-side Hive chain replay engine for message recovery
 *
 * Adapted from Ragnarok's replayEngine.ts pattern. Paginates backward through
 * ALL account history (1000 ops/page), filters for messenger operations, and
 * stores them in IndexedDB with sync cursors for incremental updates.
 *
 * Solves the "old messages get lost" problem: instead of fetching only the
 * last 200 ops, this crawls the entire history on first load, then does
 * incremental syncs on subsequent loads.
 *
 * Usage:
 *   await syncAccount('username')   — one-shot full sync
 *   startSync('username')           — begin polling every SYNC_INTERVAL_MS
 *   stopSync()                      — cancel polling
 */

import { fetchHistoryPage, type HiveHistoryEntry, type CustomJsonOpData, type TransferOpData } from './hiveRpc';
import {
  getSyncCursor,
  putSyncCursor,
  putIndexedOps,
  getConversationKey,
  type SyncCursor,
  type IndexedOp,
} from './messageCache';
import { normalizeHiveTimestamp } from './hive';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_PAGE_SIZE = 1000;
const SYNC_INTERVAL_MS = 30_000;   // re-sync every 30s (faster than Ragnarok's 60s for messaging)
const PAGE_DELAY_MS = 100;         // throttle between pages to avoid rate limiting
const TRANSFER_FILTER = 4;         // 2^2 for transfer operations
const CUSTOM_JSON_FILTER = 262144; // 2^18 for custom_json operations

// ---------------------------------------------------------------------------
// Sync status (observable by UI)
// ---------------------------------------------------------------------------

export type SyncStatus = 'idle' | 'incremental' | 'full-resync' | 'error';

let _syncStatus: SyncStatus = 'idle';
let _syncProgress = 0; // 0-100 for full resync progress
let _statusListeners: Array<(status: SyncStatus, progress: number) => void> = [];

export function getSyncStatus(): { status: SyncStatus; progress: number } {
  return { status: _syncStatus, progress: _syncProgress };
}

export function onSyncStatusChange(listener: (status: SyncStatus, progress: number) => void): () => void {
  _statusListeners.push(listener);
  return () => {
    _statusListeners = _statusListeners.filter(l => l !== listener);
  };
}

function setSyncStatus(status: SyncStatus, progress: number = 0) {
  _syncStatus = status;
  _syncProgress = progress;
  for (const listener of _statusListeners) {
    try { listener(status, progress); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _syncTimer: ReturnType<typeof setInterval> | null = null;
let _isSyncing = false;

// ---------------------------------------------------------------------------
// Core sync
// ---------------------------------------------------------------------------

export interface SyncResult {
  newOps: number;
  fullSyncComplete: boolean;
}

export async function syncAccount(username: string): Promise<SyncResult> {
  if (_isSyncing) return { newOps: 0, fullSyncComplete: false };
  _isSyncing = true;

  try {
    return await _doSync(username);
  } catch (err) {
    setSyncStatus('error');
    logger.error('[replayEngine] Sync error:', err);
    return { newOps: 0, fullSyncComplete: false };
  } finally {
    _isSyncing = false;
  }
}

async function _doSync(username: string): Promise<SyncResult> {
  const cursor = await getSyncCursor(username);
  const isFullSync = !cursor?.fullSyncComplete;

  if (isFullSync) {
    setSyncStatus('full-resync', 0);
    logger.info('[replayEngine] Starting FULL history crawl for:', username);
  } else {
    setSyncStatus('incremental');
  }

  // We need to crawl TWO operation types separately because the Hive API
  // only supports one filter bitmask at a time.
  const lastTransferIdx = cursor?.lastTransferIndex ?? -1;
  const lastCustomJsonIdx = cursor?.lastCustomJsonIndex ?? -1;

  // Crawl transfers (legacy encrypted memos)
  const transferOps = await crawlHistory(
    username, lastTransferIdx, TRANSFER_FILTER, isFullSync, 'transfer'
  );

  if (isFullSync) setSyncStatus('full-resync', 50);

  // Crawl custom_json (new text + image messages)
  const customJsonOps = await crawlHistory(
    username, lastCustomJsonIdx, CUSTOM_JSON_FILTER, isFullSync, 'custom_json'
  );

  if (isFullSync) setSyncStatus('full-resync', 90);

  // Process and store all ops
  const allOps = [...transferOps, ...customJsonOps];
  const indexedOps = processOps(username, allOps);

  if (indexedOps.length > 0) {
    await putIndexedOps(indexedOps, username);
    logger.info('[replayEngine] Stored', indexedOps.length, 'indexed ops');
  }

  // Compute highest indices seen
  let highestTransfer = lastTransferIdx;
  let highestCustomJson = lastCustomJsonIdx;

  for (const { idx, filterType } of allOps) {
    if (filterType === 'transfer' && idx > highestTransfer) highestTransfer = idx;
    if (filterType === 'custom_json' && idx > highestCustomJson) highestCustomJson = idx;
  }

  // Update cursor
  await putSyncCursor({
    account: username,
    lastTransferIndex: highestTransfer,
    lastCustomJsonIndex: highestCustomJson,
    lastSyncedAt: Date.now(),
    fullSyncComplete: true,
  });

  setSyncStatus('idle');
  return { newOps: indexedOps.length, fullSyncComplete: true };
}

// ---------------------------------------------------------------------------
// Backward pagination (adapted from Ragnarok replayEngine lines 137-169)
// ---------------------------------------------------------------------------

interface RawHistoryOp {
  idx: number;
  entry: HiveHistoryEntry;
  filterType: 'transfer' | 'custom_json';
}

async function crawlHistory(
  username: string,
  lastIndex: number,
  opFilter: number,
  isFullSync: boolean,
  filterType: 'transfer' | 'custom_json',
): Promise<RawHistoryOp[]> {
  const ops: RawHistoryOp[] = [];
  let pageStart = -1; // -1 = fetch from latest
  let done = false;
  let pageCount = 0;

  while (!done) {
    let page;
    try {
      page = await fetchHistoryPage(username, pageStart, HISTORY_PAGE_SIZE, opFilter);
    } catch (err) {
      logger.warn('[replayEngine] Failed to fetch history page:', err);
      break;
    }

    if (!page || page.length === 0) break;
    pageCount++;

    // Update progress during full sync (estimate based on pages fetched)
    if (isFullSync && pageCount > 1) {
      // Estimate: most accounts have <10 pages, cap at 20 for progress calc
      const estimatedProgress = Math.min(pageCount / 20, 0.95) * 100;
      setSyncStatus('full-resync', Math.round(estimatedProgress));
    }

    for (const [idx, entry] of page) {
      // Stop once we hit already-processed entries
      if (idx <= lastIndex) {
        done = true;
        break;
      }
      ops.push({ idx, entry, filterType });
    }

    // If we got a full page AND haven't hit overlap, fetch older entries
    if (!done && page.length >= HISTORY_PAGE_SIZE) {
      const lowestIdx = page[0][0];
      if (lowestIdx <= lastIndex + 1) break;
      pageStart = lowestIdx - 1;

      // Throttle between pages to avoid rate limiting
      if (PAGE_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
      }
    } else {
      break;
    }
  }

  logger.info(`[replayEngine] Crawled ${pageCount} pages of ${filterType}, found ${ops.length} ops`);
  return ops;
}

// ---------------------------------------------------------------------------
// Process raw ops into IndexedOp records
// ---------------------------------------------------------------------------

function processOps(username: string, rawOps: RawHistoryOp[]): IndexedOp[] {
  const indexedOps: IndexedOp[] = [];

  for (const { idx, entry, filterType } of rawOps) {
    const [opType, opData] = entry.op;

    if (filterType === 'transfer' && opType === 'transfer') {
      const transfer = opData as TransferOpData;

      // Only care about encrypted memos involving this user
      if (!transfer.memo || !transfer.memo.startsWith('#')) continue;
      if (transfer.from !== username && transfer.to !== username) continue;

      const from = transfer.from;
      const to = transfer.to;

      indexedOps.push({
        key: `${username}:${idx}`,
        account: username,
        historyIndex: idx,
        opType: 'transfer',
        txId: entry.trx_id,
        from,
        to,
        conversationKey: getConversationKey(from, to),
        timestamp: normalizeHiveTimestamp(entry.timestamp),
        block: entry.block,
        payload: transfer.memo,
        amount: transfer.amount,
      });
    } else if (filterType === 'custom_json' && opType === 'custom_json') {
      const cjData = opData as CustomJsonOpData;
      const cjId = cjData.id;

      // Only care about messenger custom_json ops
      if (cjId !== 'hive-messenger-text' && cjId !== 'hive-messenger-img') continue;

      const sender = cjData.required_posting_auths?.[0];
      if (!sender) continue;

      let jsonData: any;
      try {
        jsonData = typeof cjData.json === 'string' ? JSON.parse(cjData.json) : cjData.json;
      } catch {
        continue;
      }

      // Determine recipient
      let recipient: string;
      if (cjId === 'hive-messenger-text') {
        recipient = jsonData.to;
        if (!recipient) continue;
        // Only care about ops involving this user
        if (sender !== username && recipient !== username) continue;
      } else {
        // For image messages, recipient is determined from the 'to' field in the outer JSON
        // or we infer from the conversation context
        recipient = jsonData.to || (sender === username ? '' : username);
        if (!recipient) continue;
        if (sender !== username && recipient !== username) continue;
      }

      const opTypeStr = cjId === 'hive-messenger-text' ? 'custom_json_text' : 'custom_json_img';

      // Handle chunked vs single messages
      if (jsonData.sid) {
        // Multi-chunk message
        indexedOps.push({
          key: `${username}:${idx}`,
          account: username,
          historyIndex: idx,
          opType: opTypeStr as 'custom_json_text' | 'custom_json_img',
          txId: entry.trx_id,
          from: sender,
          to: recipient,
          conversationKey: getConversationKey(sender, recipient),
          timestamp: normalizeHiveTimestamp(entry.timestamp),
          block: entry.block,
          payload: jsonData.e || '',
          hash: jsonData.h,
          sessionId: jsonData.sid,
          chunkIndex: jsonData.idx,
          totalChunks: jsonData.tot,
        });
      } else {
        // Single operation message
        indexedOps.push({
          key: `${username}:${idx}`,
          account: username,
          historyIndex: idx,
          opType: opTypeStr as 'custom_json_text' | 'custom_json_img',
          txId: entry.trx_id,
          from: sender,
          to: recipient,
          conversationKey: getConversationKey(sender, recipient),
          timestamp: normalizeHiveTimestamp(entry.timestamp),
          block: entry.block,
          payload: jsonData.e || '',
          hash: jsonData.h,
        });
      }
    }
  }

  return indexedOps;
}

// ---------------------------------------------------------------------------
// Polling start / stop (same pattern as Ragnarok)
// ---------------------------------------------------------------------------

export function startSync(username: string): void {
  if (_syncTimer !== null) return; // already running

  // Immediate sync on start, then poll
  syncAccount(username).catch(err =>
    logger.warn('[replayEngine] sync error:', err)
  );

  _syncTimer = setInterval(
    () => syncAccount(username).catch(err =>
      logger.warn('[replayEngine] sync error:', err)
    ),
    SYNC_INTERVAL_MS,
  );

  logger.info('[replayEngine] Started sync polling (every', SYNC_INTERVAL_MS / 1000, 's)');
}

export function stopSync(): void {
  if (_syncTimer !== null) {
    clearInterval(_syncTimer);
    _syncTimer = null;
    setSyncStatus('idle');
    logger.info('[replayEngine] Stopped sync polling');
  }
}

// ---------------------------------------------------------------------------
// One-shot manual refresh
// ---------------------------------------------------------------------------

export async function forceSync(username: string): Promise<SyncResult> {
  return syncAccount(username);
}
