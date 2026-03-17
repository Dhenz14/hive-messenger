/**
 * hiveRpc.ts — Lightweight multi-node Hive RPC helper
 *
 * Adapted from Ragnarok's replayEngine.ts callHive pattern.
 * Uses direct fetch instead of @hiveio/dhive for lower overhead
 * during high-throughput pagination (replay engine crawls).
 *
 * Features:
 *   - 3 public Hive RPC nodes with automatic failover
 *   - 8s timeout per node
 *   - Zero dependencies beyond fetch
 */

import { logger } from '@/lib/logger';

const HIVE_NODES = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
];

const NODE_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Core RPC
// ---------------------------------------------------------------------------

interface HiveRpcResponse<T> {
  result?: T;
  error?: { message: string };
}

export async function callHive<T>(method: string, params: unknown[]): Promise<T> {
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

      if (!res.ok) throw new Error(`HTTP ${res.status} from ${node}`);

      const data = (await res.json()) as HiveRpcResponse<T>;

      if (data.result !== undefined) return data.result;
      if (data.error) throw new Error(data.error.message);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.info('[hiveRpc] Node failed:', node, lastError.message);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Account history types
// ---------------------------------------------------------------------------

export type CustomJsonOpData = {
  required_auths: string[];
  required_posting_auths: string[];
  id: string;
  json: string;
};

export type TransferOpData = {
  from: string;
  to: string;
  amount: string;
  memo: string;
};

export type HiveHistoryEntry = {
  trx_id: string;
  block: number;
  timestamp: string;
  op: ['custom_json', CustomJsonOpData] | ['transfer', TransferOpData] | [string, unknown];
};

export type HistoryPage = [number, HiveHistoryEntry][];

// ---------------------------------------------------------------------------
// Account history pagination
// ---------------------------------------------------------------------------

/**
 * Fetch a single page of account history from the Hive blockchain.
 *
 * @param account   Hive username
 * @param start     Starting operation index (-1 = latest)
 * @param limit     Max operations to return (max 1000)
 * @param opFilter  Operation bitmask filter (4 = transfers, 262144 = custom_json)
 */
export async function fetchHistoryPage(
  account: string,
  start: number,
  limit: number,
  opFilter?: number,
): Promise<HistoryPage> {
  if (opFilter !== undefined) {
    return callHive<HistoryPage>('condenser_api.get_account_history', [
      account, start, limit, opFilter, 0,
    ]);
  }
  return callHive<HistoryPage>('condenser_api.get_account_history', [
    account, start, limit,
  ]);
}

// ---------------------------------------------------------------------------
// Block-level APIs (for server-side indexer)
// ---------------------------------------------------------------------------

export interface BlockOp {
  trx_id: string;
  block: number;
  trx_in_block: number;
  op_in_trx: number;
  timestamp: string;
  op: [string, Record<string, unknown>];
}

export async function getOpsInBlock(blockNum: number): Promise<BlockOp[]> {
  return callHive<BlockOp[]>('condenser_api.get_ops_in_block', [blockNum, false]);
}

export async function getLastIrreversibleBlock(): Promise<number> {
  const props = await callHive<{ last_irreversible_block_num: number }>(
    'condenser_api.get_dynamic_global_properties', [],
  );
  return props.last_irreversible_block_num;
}
