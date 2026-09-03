import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Operator messages print commands like "/fortsetzen clips" — the channel key without its
// platform prefix, because the sanitizer strips spec keys from operator text. A person types
// what they read, so the command parser must accept that form (and the display name) too.
const source = readFileSync(new URL("../src/application/operator-commands.ts", import.meta.url).pathname, "utf8");

test("a channel argument may be the key, the key without platform prefix, or the display name", () => {
  assert.match(source, /replace\(\/\^\(instagram\|tiktok\|youtube\)-\/, ""\)/);
  assert.match(source, /item\.name\.toLocaleLowerCase\("en-US"\) === normalized/);
});

test("an ambiguous short form is refused instead of guessed", () => {
  assert.match(source, /matches\.length > 1\) return `⚠️ „\$\{argument\}“ ist mehrdeutig/);
});
