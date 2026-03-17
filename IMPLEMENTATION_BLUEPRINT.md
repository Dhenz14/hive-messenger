# 🎯 CUSTOM JSON IMAGE MESSAGING - IMPLEMENTATION BLUEPRINT

## 📋 IMPLEMENTATION CHECKLIST

### **Phase 1: Core Infrastructure** (4-6 hours)
- [ ] Install pako library
- [ ] Create compression utilities (`client/src/lib/compression.ts`)
- [ ] Create image utilities (`client/src/lib/imageUtils.ts`)
- [ ] Create encryption module (`client/src/lib/customJsonEncryption.ts`)
- [ ] Add unit tests for compression/encryption

### **Phase 2: Chunking & Broadcasting** (3-4 hours)
- [ ] Create chunking module (`client/src/lib/imageChunking.ts`)
- [ ] Implement single-op broadcast
- [ ] Implement multi-chunk batched broadcast
- [ ] Add RC estimation warnings (`client/src/lib/rcEstimation.ts`)

### **Phase 3: Storage Layer** (3-4 hours)
- [ ] Extend IndexedDB schema (v5)
- [ ] Add custom_json message table
- [ ] Create cache functions
- [ ] Add migration logic

### **Phase 4: Blockchain Integration** (4-5 hours)
- [ ] Fetch custom_json operations (`client/src/lib/hive.ts`)
- [ ] Implement reassembly logic
- [ ] Add integrity verification
- [ ] Handle partial chunks (error recovery)

### **Phase 5: UI Integration** (5-6 hours)
- [ ] Update MessageComposer with image picker
- [ ] Add image preview
- [ ] Add progress indicators
- [ ] Merge memo + custom_json timelines
- [ ] Create ImageMessage component (`client/src/components/ImageMessage.tsx`)
- [ ] Add decrypt-on-demand for images

### **Phase 6: Testing & Polish** (3-4 hours)
- [ ] Test single image send
- [ ] Test multi-chunk images
- [ ] Test integrity verification
- [ ] Test RC warnings
- [ ] Test timeline merging
- [ ] End-to-end encryption verification

---

## 🏗️ TECHNICAL SPECIFICATIONS

### Data Flow
```
User selects image
→ WebP compression (60% reduction)
→ Base64 encoding (+33%)
→ JSON with short keys (-25%)
→ Gzip compression (-75%)
→ Memo encryption (+30%)
→ Chunking if needed (7KB chunks)
→ Broadcast as custom_json (batched if multi-chunk)
→ Store in IndexedDB
→ Display in merged timeline
```

### Storage Schema
```typescript
customJsonMessages: {
  txId: string (primary key)
  sessionId?: string
  conversationKey: string
  from: string
  to: string
  imageData?: string
  message?: string
  filename?: string
  contentType?: string
  timestamp: string
  encryptedPayload: string
  hash?: string
  chunks?: number
  isDecrypted: boolean
  confirmed: boolean
}
```

### Payload Structure (Pre-Encryption)
```json
{
  "t": "recipient",
  "f": "sender", 
  "i": "base64_image",
  "m": "optional_text",
  "n": "filename.webp",
  "c": "image/webp",
  "ts": 1234567890
}
```

### Custom JSON Operations
```json
// Single operation
{
  "id": "hive-messenger-img",
  "required_posting_auths": ["username"],
  "json": {
    "v": 1,
    "e": "encrypted_payload",
    "h": "sha256_hash"
  }
}

// Multi-chunk
{
  "id": "hive-messenger-img",
  "json": {
    "v": 1,
    "sid": "session_id",
    "idx": 0,
    "tot": 3,
    "h": "hash",
    "e": "chunk_data"
  }
}
```

---

## 🎯 SUCCESS CRITERIA

1. ✅ Existing memo system untouched
2. ✅ Image compressed to WebP + Gzipped
3. ✅ End-to-end encryption via memo key
4. ✅ Batched broadcast (all chunks in ONE tx)
5. ✅ SHA-256 integrity verification
6. ✅ Merged timeline (memos + images)
7. ✅ RC warnings before expensive operations
8. ✅ Graceful error handling
9. ✅ Progressive enhancement (works without images)
10. ✅ Performance: <3 seconds send time

---

## Phase 7: Replay Engine & Message Recovery (Implemented March 2026)

Full history recovery system adapted from the [Ragnarok Card Game](https://github.com/Dhenz14/norse-mythos-card-game) lightweight indexer pattern.

### New Files

- `client/src/lib/hiveRpc.ts` — Lightweight multi-node RPC (fetch-based, 3 nodes, 8s timeout)
- `client/src/lib/replayEngine.ts` — Full history crawler with sync cursors (1000 ops/page)
- `server/services/chainIndexer.ts` — Block-based irreversible scanner (20 blocks/batch)
- `server/services/chainState.ts` — PostgreSQL cursor management

### Modified Files

- `client/src/lib/messageCache.ts` — IndexedDB v2 with `syncCursors` + `indexedOps` stores
- `client/src/hooks/useBlockchainMessages.ts` — Uses replay engine instead of 200-op limit
- `client/src/contexts/AuthContext.tsx` — `startSync()`/`stopSync()` on login/logout
- `shared/schema.ts` — `blockchain_ops` + `indexer_state` PostgreSQL tables
- `server/routes.ts` — `/api/history/*` endpoints + indexer startup

### Checklist

- [x] Client-side backward pagination (1000 ops/page, two passes)
- [x] Sync cursors in IndexedDB (incremental after first load)
- [x] Server-side block indexer (crash-safe, sequential)
- [x] REST API for gap-fill queries
- [x] Auth lifecycle integration
- [x] Legacy 50-op fetch for real-time recency

---

**STATUS: ALL PHASES IMPLEMENTED**
