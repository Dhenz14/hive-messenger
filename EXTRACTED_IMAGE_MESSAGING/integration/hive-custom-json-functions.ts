/**
 * Hive Blockchain Custom JSON Functions
 * 
 * Add these functions to your hive.ts or hiveClient.ts file
 * These handle fetching custom_json operations from the blockchain
 */

import { Client } from '@hiveio/dhive';
import { reassembleChunks } from '../lib/imageChunking';

/**
 * Custom JSON operation structure from blockchain
 */
export interface CustomJsonOperation {
  txId: string;
  sessionId?: string;
  from: string;
  to: string;
  timestamp: string;
  encryptedPayload: string;
  hash?: string;
  chunks?: number;
}

/**
 * Fetch custom_json operations for image messaging
 * 
 * @param username - User's Hive username
 * @param partnerUsername - Conversation partner's username
 * @param limit - Maximum operations to fetch (default: 200)
 * @returns Array of custom_json image messages
 * 
 * @example
 * const messages = await getCustomJsonMessages('alice', 'bob', 200);
 * console.log(`Found ${messages.length} image messages`);
 */
export async function getCustomJsonMessages(
  username: string,
  partnerUsername: string,
  limit: number = 200
): Promise<CustomJsonOperation[]> {
  try {
    console.log('[CUSTOM JSON] Fetching messages for conversation:', { username, partnerUsername, limit });
    
    // Create Hive client with reliable RPC nodes
    const client = new Client([
      'https://api.hive.blog',
      'https://api.deathwing.me',
      'https://api.openhive.network',
    ]);
    
    // custom_json is operation type 18, so bit 18 = 2^18 = 262144
    const operationFilterLow = 262144;

    // A recipient is payload metadata, not an operation authority. Query both
    // participants so incoming and outgoing messages are discoverable.
    const histories = await Promise.all(
      [username, partnerUsername].map((account) =>
        client.database.call('get_account_history', [
          account,
          -1, // Start from most recent
          limit,
          operationFilterLow, // Only custom_json operations
        ])
      )
    );
    const history = histories.flat();

    console.log('[CUSTOM JSON] Retrieved', history.length, 'custom_json operations from blockchain');

    // Parse operations and reassemble chunks
    type ChunkEnvelope = {
      payload: any;
      from: string;
      to: string;
      txId: string;
      timestamp: string;
    };
    const chunkedSessions = new Map<string, ChunkEnvelope[]>();
    const singleOperations: CustomJsonOperation[] = [];
    const seenOperations = new Set<string>();

    for (const [, op] of history) {
      const [opType, customJson] = op.op;
      if (opType !== 'custom_json') continue;

      if (customJson.id !== 'hive-messenger-img') continue;

      const operationKey = `${op.trx_id}:${op.op_in_trx ?? 0}`;
      if (seenOperations.has(operationKey)) continue;
      seenOperations.add(operationKey);

      let payload: any;
      try {
        payload = JSON.parse(customJson.json);
      } catch {
        console.warn('[CUSTOM JSON] Failed to parse JSON for operation');
        continue;
      }

      if (payload.v !== 1 || (payload.type !== undefined && payload.type !== 'image')) continue;
      if (typeof payload.e !== 'string' || payload.e.length === 0) continue;

      // Verify this is between the two users
      const from = customJson.required_posting_auths?.[0];
      const recipient = typeof (payload.to || payload.t) === 'string'
        ? (payload.to || payload.t)
        : undefined;
      const isRelevant =
        (from === username && recipient === partnerUsername) ||
        (from === partnerUsername && recipient === username);
      if (!isRelevant || !from || !recipient) continue;

      // Check if this is a chunked operation
      if (payload.sid) {
        // Multi-chunk operation
        if (
          typeof payload.sid !== 'string' ||
          !Number.isSafeInteger(payload.idx) ||
          payload.idx < 0 ||
          !Number.isSafeInteger(payload.tot) ||
          payload.tot <= 0
        ) {
          continue;
        }
        const groupKey = `${from}\u0000${recipient}\u0000${payload.sid}`;
        if (!chunkedSessions.has(groupKey)) {
          chunkedSessions.set(groupKey, []);
        }
        chunkedSessions.get(groupKey)!.push({
          payload,
          from,
          to: recipient,
          txId: op.trx_id,
          timestamp: op.timestamp,
        });
      } else {
        // Single operation
        singleOperations.push({
          txId: op.trx_id || `${op.block}-${op.trx_in_block}`,
          from,
          to: recipient,
          timestamp: op.timestamp,
          encryptedPayload: payload.e,
          hash: payload.h,
          chunks: 1,
        });
      }
    }

    // Reassemble chunked messages
    const operations: CustomJsonOperation[] = [...singleOperations];

    for (const chunks of chunkedSessions.values()) {
      const firstChunk = chunks[0];
      if (!firstChunk) continue;
      const sessionId = firstChunk.payload.sid;
      const reassembled = reassembleChunks(chunks.map((chunk) => chunk.payload));
      const complete = reassembled.get(sessionId);
      if (!complete) continue;

      operations.push({
        txId: firstChunk.txId,
        sessionId,
        from: firstChunk.from,
        to: firstChunk.to,
        timestamp: firstChunk.timestamp,
        encryptedPayload: complete.encrypted,
        hash: complete.hash,
        chunks: chunks.length,
      });
    }

    console.log('[CUSTOM JSON] Processed', operations.length, 'image messages (including reassembled chunks)');
    return operations;

  } catch (error) {
    console.error('[CUSTOM JSON] Failed to fetch messages:', error);
    throw error;
  }
}

/**
 * INTEGRATION INSTRUCTIONS:
 * 
 * 1. Copy this function to your hive.ts file
 * 2. Make sure you have @hiveio/dhive installed
 * 3. Import reassembleChunks from imageChunking.ts
 * 4. Use in your React hooks like this:
 * 
 * import { getCustomJsonMessages } from '@/lib/hive';
 * 
 * const messages = await getCustomJsonMessages(
 *   user.username,
 *   partnerUsername,
 *   200
 * );
 */
