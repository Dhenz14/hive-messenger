#!/usr/bin/env node
import { readFileSync } from "node:fs";

const pairs = [
  [
    "client/src/components/ImageMessage.tsx",
    "EXTRACTED_IMAGE_MESSAGING/components/ImageMessage.tsx",
  ],
  [
    "client/src/lib/imageChunking.ts",
    "EXTRACTED_IMAGE_MESSAGING/lib/imageChunking.ts",
  ],
  [
    "client/src/lib/customJsonEncryption.ts",
    "EXTRACTED_IMAGE_MESSAGING/lib/customJsonEncryption.ts",
  ],
  [
    "client/src/lib/rcEstimation.ts",
    "EXTRACTED_IMAGE_MESSAGING/lib/rcEstimation.ts",
  ],
];

const docs = [
  "EXTRACTED_IMAGE_MESSAGING/README.md",
  "EXTRACTED_IMAGE_MESSAGING/PACKAGE_SUMMARY.md",
];

function read(path) {
  return readFileSync(path);
}

function readText(path) {
  return readFileSync(path, "utf8");
}

const docsText = docs.map(readText).join("\n\n");
const status = docsText.match(/Generated source status:\s*(synced-copy|not-copyable-snapshot)\b/)?.[1];
const copyInstructionsRemain = /cp(?:\s+-r)?\s+EXTRACTED_IMAGE_MESSAGING\/(?:lib|components)\//.test(docsText);
const mismatches = pairs.filter(([source, extracted]) => !read(source).equals(read(extracted)));

if (!status) {
  console.error(
    "EXTRACTED_IMAGE_MESSAGING docs must declare Generated source status: synced-copy or not-copyable-snapshot.",
  );
  process.exit(1);
}

if (status === "not-copyable-snapshot") {
  if (copyInstructionsRemain) {
    console.error(
      "EXTRACTED_IMAGE_MESSAGING is marked not-copyable-snapshot but still contains copy commands.",
    );
    process.exit(1);
  }
  console.log("EXTRACTED_IMAGE_MESSAGING is documented as a non-copyable snapshot.");
  process.exit(0);
}

if (mismatches.length) {
  console.error("EXTRACTED_IMAGE_MESSAGING source drift detected:");
  for (const [source, extracted] of mismatches) {
    console.error(`- ${extracted} differs from ${source}`);
  }
  console.error("Resync the extracted files from client/src or mark the docs not-copyable-snapshot.");
  process.exit(1);
}

console.log(`EXTRACTED_IMAGE_MESSAGING drift guard passed (${pairs.length} file pairs).`);
