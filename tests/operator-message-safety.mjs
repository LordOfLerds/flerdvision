import assert from "node:assert/strict";

// Shared guarantee for every operator message: the chat never shows a spec key, an internal id,
// an evidence path, an ISO timestamp or a raw state word. Not a *.test.mjs file on purpose, so
// importing it does not run another suite twice.

const FORBIDDEN = [
  [/\b(?:account|intent|incident|asset|route|content|attention|notification|browser|identity|lane|publication|attempt)\s*:\s*\S/, "internal id"],
  [/\b(?:instagram|tiktok|youtube)-[A-Za-z0-9]/, "spec key"],
  [/(?<![\w:/.])(?:~)?\/[\w.@%+-]+\/[\w.@%+-]+/, "file path"],
  [/\d{4}-\d{2}-\d{2}/, "ISO date"],
  [/\b(?:PUBLISH_UNCERTAIN|SCHEDULED|VERIFIED|BLOCKED|WAIVED|AUTH_REQUIRED|CHALLENGE|STABILIZING|OBSERVED)\b/, "raw state"]
];

/** Commands are the one place a raw key may appear, so they are excluded from the id scan. */
export function withoutCommands(text) {
  return text
    .split("\n")
    .filter((line) => !line.includes("npm run flerdvision") && !line.startsWith("Nach dem Login:"))
    .join("\n");
}

export function assertOperatorSafe(text, label) {
  const scanned = withoutCommands(text);
  for (const [pattern, what] of FORBIDDEN) {
    assert.doesNotMatch(scanned, pattern, `${label} must not contain a ${what}: ${scanned}`);
  }
}
