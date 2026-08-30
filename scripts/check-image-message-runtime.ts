import assert from 'node:assert/strict';
import {
  IMAGE_CHUNK_SIZE,
  MAX_BATCHED_IMAGE_CHUNKS,
  chunkEncryptedPayload,
  reassembleChunks,
  validateAtomicImagePayloadSize,
} from '../client/src/lib/imageChunking';

assert.equal(validateAtomicImagePayloadSize('x'), 1);
assert.equal(
  validateAtomicImagePayloadSize('x'.repeat(IMAGE_CHUNK_SIZE * MAX_BATCHED_IMAGE_CHUNKS)),
  MAX_BATCHED_IMAGE_CHUNKS,
);
assert.throws(
  () => validateAtomicImagePayloadSize('x'.repeat(IMAGE_CHUNK_SIZE * MAX_BATCHED_IMAGE_CHUNKS + 1)),
  /safe atomic Hive limit is 8/,
);
assert.throws(() => validateAtomicImagePayloadSize(''), /payload is empty/);

const chunked = chunkEncryptedPayload('x'.repeat(IMAGE_CHUNK_SIZE + 1), 'hash');
assert.equal(chunked.chunks.length, 2);
assert.equal(chunked.chunks.map((chunk) => chunk.data).join('').length, IMAGE_CHUNK_SIZE + 1);

const complete = reassembleChunks([
  { sid: 'complete', idx: 1, tot: 2, e: 'b' },
  { sid: 'complete', idx: 0, tot: 2, e: 'a', h: 'hash' },
]);
assert.deepEqual(complete.get('complete'), { encrypted: 'ab', hash: 'hash' });

const missing = reassembleChunks([
  { sid: 'missing', idx: 0, tot: 2, e: 'a', h: 'hash' },
]);
assert.equal(missing.has('missing'), false);

const duplicate = reassembleChunks([
  { sid: 'duplicate', idx: 0, tot: 2, e: 'a', h: 'hash' },
  { sid: 'duplicate', idx: 0, tot: 2, e: 'b' },
]);
assert.equal(duplicate.has('duplicate'), false);

const inconsistent = reassembleChunks([
  { sid: 'inconsistent', idx: 0, tot: 2, e: 'a', h: 'hash' },
  { sid: 'inconsistent', idx: 1, tot: 3, e: 'b' },
]);
assert.equal(inconsistent.has('inconsistent'), false);

console.log('Image message runtime check passed (atomic size and chunk completeness).');
