#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

const checks = [
  {
    name: 'live and extracted image broadcast APIs bind an explicit recipient',
    assert: () => [
      'client/src/lib/imageChunking.ts',
      'EXTRACTED_IMAGE_MESSAGING/lib/imageChunking.ts',
    ].every((file) => {
      const source = read(file);
      return source.includes('recipientUsername: string') &&
        source.includes('to: recipientUsername') &&
        source.includes('t: recipientUsername');
    }),
  },
  {
    name: 'atomic image broadcasts fail closed above eight chunks',
    assert: () => [
      'client/src/lib/imageChunking.ts',
      'EXTRACTED_IMAGE_MESSAGING/lib/imageChunking.ts',
    ].every((file) => {
      const source = read(file);
      return source.includes('MAX_BATCHED_IMAGE_CHUNKS = 8') &&
        source.includes('validateAtomicImagePayloadSize(encrypted)') &&
        source.includes('Choose a smaller or simpler image.');
    }),
  },
  {
    name: 'chunk reassembly requires declared totals and contiguous indices',
    assert: () => {
      const source = read('client/src/lib/imageChunking.ts');
      return source.includes('sessionChunks.length === declaredTotal') &&
        source.includes('chunk.total === declaredTotal') &&
        source.includes('chunk.idx === index');
    },
  },
  {
    name: 'composer writes one canonical IndexedDB message copy',
    assert: () => {
      const source = read('client/src/components/MessageComposer.tsx');
      return source.includes('await cacheMessage({') &&
        source.includes("messageType: 'customJsonImage'") &&
        !source.includes('cacheCustomJsonMessage');
    },
  },
  {
    name: 'block index identity preserves every operation in a batched transaction',
    assert: () => {
      const schema = read('shared/schema.ts');
      const indexer = read('server/services/chainIndexer.ts');
      return schema.includes('opIndex: integer("op_index").notNull().default(0)') &&
        schema.includes('uniqueIndex("blockchain_ops_tx_op_idx").on(table.txId, table.opIndex)') &&
        !schema.includes('uniqueIndex("blockchain_ops_tx_id_idx").on(table.txId)') &&
        (indexer.match(/opIndex: op\.op_in_trx/g) || []).length === 2;
    },
  },
  {
    name: 'chain indexer accepts long and short recipient keys',
    assert: () => read('server/services/chainIndexer.ts').includes("jsonData.to || jsonData.t || ''"),
  },
  {
    name: 'direct and server history isolate chunk sessions by participants',
    assert: () => {
      const hive = read('client/src/lib/hive.ts');
      const hook = read('client/src/hooks/useBlockchainMessages.ts');
      return hive.includes('`${from}\\u0000${to}\\u0000${jsonData.sid}`') &&
        hive.includes('chunk.total === declaredTotal') &&
        hook.includes('`${op.from}\\u0000${op.to}\\u0000${op.sessionId}`') &&
        hook.includes('chunk.totalChunks === totalChunks');
    },
  },
  {
    name: 'direct Hive history queries both participants and deduplicates operation identity',
    assert: () => {
      const hive = read('client/src/lib/hive.ts');
      return (hive.match(/\[username, partnerUsername\]\.map/g) || []).length >= 2 &&
        hive.includes('seenTextOperations') &&
        hive.includes('seenOperations') &&
        (hive.match(/op\.op_in_trx \?\? 0/g) || []).length >= 2;
    },
  },
  {
    name: 'copyable integration helper parses Hive history and queries both participants',
    assert: () => {
      const source = read('EXTRACTED_IMAGE_MESSAGING/integration/hive-custom-json-functions.ts');
      return source.includes('[username, partnerUsername].map') &&
        source.includes('const [opType, customJson] = op.op') &&
        source.includes('seenOperations') &&
        source.includes('from === username && recipient === partnerUsername') &&
        source.includes('from === partnerUsername && recipient === username') &&
        source.includes('reassembleChunks(chunks.map((chunk) => chunk.payload))');
    },
  },
  {
    name: 'copy-paste documentation supplies the explicit image recipient',
    assert: () => {
      const readme = read('EXTRACTED_IMAGE_MESSAGING/README.md');
      const architecture = read('EXTRACTED_IMAGE_MESSAGING/docs/ARCHITECTURE.md');
      const integration = read('EXTRACTED_IMAGE_MESSAGING/docs/INTEGRATION_EXAMPLE.md');
      return readme.includes('broadcastImageMessage(username: string, recipientUsername: string, encrypted: string, hash: string)') &&
        architecture.includes('broadcastImageMessage(username, recipientUsername, encrypted, hash)') &&
        integration.includes('broadcastImageMessage(user.username, recipientUsername, encrypted, hash)') &&
        !integration.includes('broadcastImageMessage(user.username, encrypted, hash)');
    },
  },
  {
    name: 'image bubbles accept only safe raster data URL media types',
    assert: () => {
      const source = read('client/src/components/MessageBubble.tsx');
      return source.includes('SAFE_IMAGE_CONTENT_TYPES') &&
        source.includes("'image/webp'") &&
        source.includes('safeImageDataUrl(imageData, message.imageContentType)');
    },
  },
  {
    name: 'documentation forbids blind retry after ambiguous broadcast failure',
    assert: () => {
      const source = read('EXTRACTED_IMAGE_MESSAGING/docs/ARCHITECTURE.md');
      return source.includes('Do not blindly retry') &&
        !source.includes('Network failure**: Retry with exponential backoff');
    },
  },
];

const failures = checks.filter((check) => !check.assert());
if (failures.length) {
  console.error('Image message contract check failed:');
  for (const failure of failures) console.error(`- ${failure.name}`);
  process.exit(1);
}

console.log(`Image message contract check passed (${checks.length} checks).`);
