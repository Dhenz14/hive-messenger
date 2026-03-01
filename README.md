# Hive Messenger

A decentralized, end-to-end encrypted messaging Progressive Web App (PWA) built on the Hive blockchain. No servers. No database. No private keys ever leave your device.

## What It Does

- **FREE text messaging** via Hive `custom_json` operations (0.000 HBD per message)
- **End-to-end encryption** using Hive memo keys (ECDH + AES-256-CBC) via Hive Keychain
- **Bitcoin Lightning tips** with three payment methods (HBD bridge, manual, WebLN)
- **Auto-refreshing** - messages appear in 2-5 seconds without manual page refresh
- **Offline browsing** of cached messages via IndexedDB
- **PWA installable** on mobile and desktop

## Architecture

100% client-side. Zero backend for user data.

```
User Device
  └── Hive Messenger PWA (React)
        ├── Hive Keychain (auth + encryption)
        ├── Hive Blockchain (message storage)
        │     └── Public RPC nodes
        ├── IndexedDB (local message cache)
        └── Lightning Network (Bitcoin tips)
              ├── LNURL endpoints
              ├── v4v.app (HBD→Lightning bridge)
              └── WebLN browser wallets
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

1. Auto-refresh system polls blockchain every 3-15 seconds (adaptive)
2. New messages fetched from Hive RPC nodes
3. Cached in IndexedDB for instant loading
4. User clicks "Decrypt" → Keychain decodes encrypted payload
5. Decrypted message cached locally

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
├── hooks/               # useBlockchainMessages, etc.
├── lib/
│   ├── hive.ts          # Blockchain API
│   ├── hiveClient.ts    # RPC node health + failover
│   ├── messageCache.ts  # IndexedDB
│   ├── customJsonEncryption.ts
│   ├── accountMetadata.ts
│   └── lightning.ts
└── pages/
    └── Messages.tsx     # Main chat view
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

The app automatically selects the healthiest node via health scoring and transparent failover:

- `https://api.hive.blog`
- `https://api.hivekings.com`
- `https://anyx.io`
- `https://api.openhive.network`

## Security

- Private keys **never** leave Hive Keychain
- All messages encrypted client-side before blockchain broadcast
- SHA-256 hash integrity verification on all `custom_json` messages
- Lightning invoices validated (amount, expiry, network) before payment
- No API keys, no backend, no central point of failure

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
