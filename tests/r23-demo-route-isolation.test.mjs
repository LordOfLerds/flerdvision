import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A Trial-Reel route whose switch Instagram has not enabled yet must fail on its own; the Reel
// route beside it still qualifies. Before this, one failing route aborted the whole channel run.
test("a failing route is recorded and the channel's other routes still qualify", () => {
  const demo = readFileSync(new URL("../src/application/headless-demo.ts", import.meta.url).pathname, "utf8");
  const idx = demo.indexOf("for (const route of routes) {");
  const block = demo.slice(idx, idx + 900);
  assert.match(block, /try \{\s*qualifications\.push\(await qualifier\.qualify\(route\.routeId\)\);\s*\} catch/);
  assert.match(block, /stages\.push\(\{ stage: "QUALIFY", status: "FAIL"/);
  assert.match(block, /QUALIFY FAIL · \$\{route\.displayName\}/);
  assert.match(demo, /No selected route was qualified: \$\{failures\[0\]\}/);
});
