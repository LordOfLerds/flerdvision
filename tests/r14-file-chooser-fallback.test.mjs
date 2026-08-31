import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Live 2026-08-31: TikTok's hidden upload input accepted DOM.setFileInputFiles without error and
// still held zero files, so the page waited forever for an upload that never began. Silent
// success is the one outcome a step this close to publishing may never report, so the write is
// read back and, when the page refuses it, the platform's own file chooser is used instead.

const cdp = readFileSync(new URL("../src/adapters/browser/chromium-cdp.ts", import.meta.url).pathname, "utf8");
const driver = readFileSync(new URL("../src/adapters/browser/dom-ui-driver.ts", import.meta.url).pathname, "utf8");

test("the protocol file write is proven by readback, not assumed", () => {
  const idx = cdp.indexOf("DOM.setFileInputFiles");
  const block = cdp.slice(idx, idx + 900);
  assert.match(block, /el\.files && el\.files\.length > 0/);
  assert.match(block, /throw new FileInputRejectedError/);
});

test("the chooser flow arms interception before the click and always disarms", () => {
  const idx = cdp.indexOf("async setInputFilesViaChooser");
  const block = cdp.slice(idx, idx + 2000);
  const arm = block.indexOf('Page.setInterceptFileChooserDialog", { enabled: true }');
  const wait = block.indexOf('waitForEvent("Page.fileChooserOpened"');
  const click = block.indexOf("await openChooser()");
  const disarm = block.indexOf('enabled: false');
  assert.ok(arm > 0 && arm < wait && wait < click, "the waiter must be armed before the click");
  assert.ok(disarm > click, "interception must be released in a finally");
  assert.match(block, /finally \{/);
});

test("the fallback only triggers on an explicit refusal and needs a real capability", () => {
  const idx = driver.indexOf("async setFile(");
  const block = driver.slice(idx, idx + 2400);
  assert.match(block, /if \(!\(error instanceof FileInputRejectedError\)\) throw error;/);
  assert.match(block, /if \(!this\.session\.setInputFilesViaChooser\) throw error;/);
  assert.match(block, /setInputFilesViaChooser\(\[filePath\]/);
});

test("chooser openers name upload controls only, never flow or publish controls", () => {
  const idx = driver.indexOf("FILE_CHOOSER_OPENERS");
  const block = driver.slice(idx, idx + 700);
  for (const forbidden of ["Teilen", "Share", "Posten", "Publish", "Veröffentlichen", "Weiter", "Next"]) {
    assert.ok(!block.includes(`value: "${forbidden}"`), `${forbidden} must never open a chooser`);
  }
});

test("the in-page DataTransfer handover is tried before the chooser and streams in chunks", () => {
  const idx = driver.indexOf("async setFile(");
  const block = driver.slice(idx, idx + 2400);
  const inPage = block.indexOf("setInputFilesInPage");
  const chooser = block.indexOf("setInputFilesViaChooser([filePath]");
  assert.ok(inPage > 0 && inPage < chooser, "the proven path must be tried first");
  const impl = cdp.indexOf("async setInputFilesInPage");
  const implBlock = cdp.slice(impl, impl + 2600);
  assert.match(implBlock, /chunkSize = 512 \* 1024/);
  assert.match(implBlock, /new DataTransfer\(\)/);
  assert.match(implBlock, /input\.files\.length === 0/);
  assert.match(implBlock, /marked input kept zero files/);
  assert.match(implBlock, /too large for in-page upload/);
});

test("an optional upload probe that fails leaves the flow to the required attempt", () => {
  const explorer = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  const idx = explorer.indexOf('else if (step.action === "SET_FILE")');
  const block = explorer.slice(idx, idx + 900);
  assert.match(block, /if \(step\.required\) throw error;/);
  assert.match(block, /outcome: "SKIPPED"/);
});

test("the chooser handshake keeps a timeout floor independent of the caller's probe budget", () => {
  const idx = driver.indexOf("setInputFilesViaChooser([filePath]");
  const block = driver.slice(idx - 300, idx + 300);
  assert.match(block, /Math\.max\(timeoutMs \?\? 0, 20_000\)/);
});

test("the in-page handover survives a re-render that drops the marker attribute", () => {
  const idx = cdp.indexOf("async setInputFilesInPage");
  const block = cdp.slice(idx, idx + 2600);
  assert.match(block, /\|\| document\.querySelector\('input\[type="file"\]'\)/);
});

test("the armed chooser waiter can never reject unobserved", () => {
  // A failing opener click left the waiter unawaited; its later rejection crashed the process
  // with a message that pointed at the wrong mechanism entirely.
  const idx = cdp.indexOf("async setInputFilesViaChooser");
  const block = cdp.slice(idx, idx + 1600);
  assert.match(block, /opened\.catch\(/);
  assert.match(block, /__failed/);
});

test("the in-page handover waits for the widget the refused protocol write tore down", () => {
  const idx = driver.indexOf("async setFile(");
  const block = driver.slice(idx, idx + 2600);
  assert.match(block, /Date\.now\(\) \+ 15_000/);
  assert.match(block, /setInputFilesInPage\('input\[type="file"\]', filePath\)/);
});
