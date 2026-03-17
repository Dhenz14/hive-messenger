# Hive Messenger

A decentralized, end-to-end encrypted messaging Progressive Web App (PWA) built on the Hive blockchain. No private keys ever leave your device.

## What It Does

- **FREE text messaging** via Hive `custom_json` operations (0.000 HBD per message)
- **End-to-end encryption** using Hive memo keys (ECDH + AES-256-CBC) via Hive Keychain
- **Full message history recovery** - lightweight replay engine crawls ALL blockchain history, never loses old messages
- **Bitcoin Lightning tips** with three payment methods (HBD bridge, manual, WebLN)
- **Auto-refreshing** - messages appear in 2-5 seconds without manual page refresh
- **Offline browsing** of cached messages via IndexedDB
- **PWA installable** on mobile and desktop

## Architecture

```
User Device
  └── Hive Messenger PWA (React)
        ├── Hive Keychain (auth + encryption)
        ├── Hive Blockchain (message storage)
        │     └── Public RPC nodes (3-node failover)
        ├── Replay Engine (full history crawl + sync cursors)
        ├── IndexedDB (local message cache + indexed ops)
        └── Lightning Network (Bitcoin tips)
              ├── LNURL endpoints
              ├── v4v.app (HBD→Lightning bridge)
              └── WebLN browser wallets

Server (optional, for gap-fill)
  └── Block Indexer
        ├── Sequential irreversible block scanning
        ├── PostgreSQL (blockchain_ops table)
        └── REST API for historical queries
```

## Quick Start

### Prerequisites

- [Node.js 20+](https://nodejs.org)
- [Hive Keychain](https://hive-keychain.com) browser extension (or Keychain Mobile app)
- A Hive account

### Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:5000](http://localhost:5000) and log in with Hive Keychain.

### Build for Production

```bash
npm run build
npm start
```

## How Messaging Works

### Sending a Message

1. User types message in composer
2. Hive Keychain encrypts message client-side using recipient's public memo key
3. Encrypted payload + SHA-256 hash broadcast via `custom_json` to Hive blockchain
4. **Cost: 0.000 HBD** (only Resource Credits consumed)
5. Message appears in conversation after blockchain confirmation (~2-5 seconds)

### Receiving Messages

1. **Replay engine** crawls full account history on first login (1000 ops/page, backward pagination)
2. **Sync cursor** tracks progress — subsequent logins only fetch new ops (incremental sync)
3. Auto-refresh polls blockchain every 3-15 seconds for real-time updates (adaptive)
4. All messages cached in IndexedDB `indexedOps` store with conversation indexes
5. User clicks "Decrypt" → Keychain decodes encrypted payload
6. Decrypted message cached locally

### Message Recovery (Replay Engine)

Old messages are **never lost** even after long periods of inactivity or cache clearing:

1. **Client-side replay engine** paginates backward through ALL account history (not just the last 200 ops)
2. **Server-side block indexer** continuously scans irreversible blocks for messenger ops
3. **Gap-fill API** lets the client query the server when local cache has holes
4. **Sync cursors** persist in IndexedDB so re-syncs are instant (only new ops fetched)

### Legacy Support

Old memo-based messages (pre-v2.2.2) continue to work alongside new `custom_json` messages. Both types appear in the same conversation timeline.

## Message Types

| Type | Cost | Operation | Notes |
|------|------|-----------|-------|
| Text (new) | FREE | `custom_json` | SHA-256 integrity hash |
| Text (legacy) | 0.001 HBD | HBD transfer + memo | Backwards compatible |
| Lightning tip | Variable | HBD transfer to v4v.app | BTC via Lightning Network |

## Auto-Refresh System

No manual page refresh needed. The app uses adaptive polling:

| Mode | Interval | When |
|------|----------|------|
| Burst | 3 seconds | 15 seconds after you send |
| Active | 5 seconds | Mouse/keyboard activity |
| Idle | 15 seconds | No activity for 60s |
| Background | 45 seconds | Tab hidden |

## File Structure

```
client/src/
├── components/          # UI components
│   ├── ui/              # Shadcn base components
│   ├── MessageBubble.tsx
│   ├── MessageComposer.tsx
│   ├── ConversationsList.tsx
│   └── lightning/       # Lightning tip UI
├── contexts/            # Auth, theme, exceptions
├── hooks/
│   └── useBlockchainMessages.ts  # Message fetching (uses replay engine)
├── lib/
│   ├── hive.ts          # Blockchain API
│   ├── hiveClient.ts    # RPC node health + failover (dhive)
│   ├── hiveRpc.ts       # Lightweight direct RPC (fetch-based, 3 nodes)
│   ├── replayEngine.ts  # Full history crawler with sync cursors
│   ├── messageCache.ts  # IndexedDB (v2: + syncCursors, indexedOps)
│   ├── customJsonEncryption.ts
│   ├── accountMetadata.ts
│   └── lightning.ts
└── pages/
    └── Messages.tsx     # Main chat view

server/
├── routes.ts            # API routes (+ /api/history/* endpoints)
├── services/
│   ├── chainIndexer.ts  # Block-based irreversible scanner
│   └── chainState.ts    # PostgreSQL cursor management
└── db.ts                # Drizzle + Neon PostgreSQL

shared/
└── schema.ts            # DB tables (+ blockchain_ops, indexer_state)
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@hiveio/dhive` | Hive blockchain client |
| `keychain-sdk` | Hive Keychain integration |
| `idb` | IndexedDB wrapper |
| `lnurl-pay` | Lightning Address invoice generation |
| `light-bolt11-decoder` | BOLT11 invoice validation |
| `qrcode` | Lightning invoice QR codes |
| `pako` | Message payload compression |
| `@tanstack/react-query` | Data fetching + caching |
| `wouter` | Client-side routing |

## Hive RPC Nodes

The app uses two RPC strategies:

**hiveClient.ts** (dhive-based, with health scoring):

- `https://api.hive.blog`
- `https://api.deathwing.me`
- `https://hive-api.arcange.eu`

**hiveRpc.ts** (lightweight fetch-based, for replay engine):

- Same 3 nodes with 8s timeout per node
- Auto-failover on error or timeout

## Security

- Private keys **never** leave Hive Keychain
- All messages encrypted client-side before blockchain broadcast
- SHA-256 hash integrity verification on all `custom_json` messages
- Lightning invoices validated (amount, expiry, network) before payment
- Server-side indexer stores only encrypted payloads — no plaintext ever touches the server

## Replay Engine & Message Recovery

### The Problem

Previously, the app only fetched the last 200 account history operations. If a user was inactive for a long period or cleared their browser data, older messages were unrecoverable from the client's perspective.

### The Solution

Adapted from [Ragnarok Card Game](https://github.com/Dhenz14/norse-mythos-card-game) indexer patterns.

**Client-side replay engine** (`replayEngine.ts`):

- Paginates backward through ALL account history (1000 ops/page)
- Separate crawls for transfers (filter=4) and custom_json (filter=262144)
- Sync cursors persist in IndexedDB — incremental on subsequent logins
- 30-second polling interval for real-time updates
- Starts on login, stops on logout

**Server-side block indexer** (`chainIndexer.ts`):

- Scans irreversible blocks sequentially (20 blocks/batch, 10s polling)
- Stores messenger ops in PostgreSQL `blockchain_ops` table
- Crash-safe: cursor only advances after full block processed
- REST API for client gap-fill queries

**API Endpoints:**

| Endpoint | Purpose |
| --- | --- |
| `GET /api/history/:user/messages?partner=X` | Fetch historical messages for a conversation |
| `GET /api/history/:user/conversations` | Discover all conversation partners |
| `GET /api/indexer/status` | Check indexer health and block cursor |

### Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `INDEXER_GENESIS_BLOCK` | `0` | First block to scan (set to avoid scanning from block 1) |

## Platform Support

| Platform | How to Use |
|----------|-----------|
| Desktop Chrome/Firefox/Brave | Install [Hive Keychain extension](https://hive-keychain.com) |
| Keychain Mobile (iOS/Android) | Open in Keychain's built-in browser |
| Regular mobile browser | App redirects you to Keychain Mobile |

## Lightning Tips

To receive Lightning tips, add your Lightning Address in Settings (e.g. `user@getalby.com`). Three ways to send tips:

1. **V4V.app bridge** - Pay with HBD, recipient gets Bitcoin (0.8% fee)
2. **Manual** - Copy invoice or scan QR with any Lightning wallet
3. **WebLN** - One-click with Alby or other WebLN browser wallets

Exchange rates fetched live from CoinGecko (no API key required).

## Spam Protection

Users can set a minimum HBD requirement for incoming **legacy** messages:

- Minimum stored on-chain as profile metadata
- Only applies to old memo-based transfers (not free `custom_json` messages)
- Whitelist trusted contacts in Settings to bypass their minimum

## License

MIT
