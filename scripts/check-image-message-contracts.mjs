#!/usr/bin/env node
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const checks = [
  {
    name: "image broadcast API requires explicit recipient",
    file: "client/src/lib/imageChunking.ts",
    assert: (source) =>
      source.includes("broadcastImageMessage(\n  username: string,\n  recipientUsername: string,") &&
      source.includes("to: recipientUsername") &&
      source.includes("t: recipientUsername"),
  },
  {
    name: "extracted image broadcast API stays recipient-aware",
    file: "EXTRACTED_IMAGE_MESSAGING/lib/imageChunking.ts",
    assert: (source) =>
      source.includes("broadcastImageMessage(\n  username: string,\n  recipientUsername: string,") &&
      source.includes("to: recipientUsername") &&
      source.includes("t: recipientUsername"),
  },
  {
    name: "composer sends image recipient and writes conversation cache",
    file: "client/src/components/MessageComposer.tsx",
    assert: (source) =>
      source.includes("broadcastImageMessage(user.username, recipientUsername, encrypted, hash)") &&
      source.includes("messageType: 'customJsonImage'") &&
      source.includes("imageData: processedImage.base64Uncompressed"),
  },
  {
    name: "chain indexer accepts long and short recipient keys",
    file: "server/services/chainIndexer.ts",
    assert: (source) => source.includes("jsonData.to || jsonData.t || ''"),
  },
  {
    name: "blockchain hook gap-fills server history and image custom_json",
    file: "client/src/hooks/useBlockchainMessages.ts",
    assert: (source) =>
      source.includes("fetchServerHistoryMessages") &&
      source.includes("/api/history/") &&
      source.includes("getCustomJsonMessages(user.username, partnerUsername") &&
      source.includes("? 'customJsonImage'"),
  },
  {
    name: "image bubbles decrypt and render cached image payloads",
    file: "client/src/components/MessageBubble.tsx",
    assert: (source) =>
      source.includes("decryptImagePayload") &&
      source.includes("message.messageType === 'customJsonImage'") &&
      source.includes("data-testid={`image-message-${message.id}`}"),
  },
  {
    name: "message cache stores decrypted image metadata",
    file: "client/src/lib/messageCache.ts",
    assert: (source) =>
      source.includes("imageData?: string") &&
      source.includes("updates: Partial<Pick<MessageCache") &&
      source.includes("Object.assign(message, updates)"),
  },
];

const failures = checks.filter((check) => !check.assert(read(check.file)));

if (failures.length) {
  console.error("Image message contract check failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name} (${failure.file})`);
  }
  process.exit(1);
}

console.log(`Image message contract check passed (${checks.length} checks).`);
