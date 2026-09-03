import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type {
  BrowserPageSessionPort,
  BrowserRuntimeLaunchOptions,
  BrowserRuntimePort
} from "../../domain/browser-identity-ports.js";
import { BrowserProfileDirectoryResolver } from "./profile-lock.js";
import { resolveChromiumExecutablePath } from "./resolve-chromium.js";

interface CdpEnvelope {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** The page refused a protocol-set file; callers may fall back to the file-chooser flow. */
export class FileInputRejectedError extends Error {}

export type CdpEventHandler = (params: Record<string, unknown>) => void;

/** The subset of a WebSocket the client relies on; tests drive it with an in-memory fake. */
export interface CdpSocketLike {
  addEventListener(type: "message" | "close", listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly eventWaiters = new Map<string, Array<{ resolve: (params: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>>();
  private readonly listeners = new Map<string, Set<CdpEventHandler>>();

  /**
   * Standing subscription to a CDP event, for streams rather than one-shot waits: the screencast
   * delivers a frame per event for as long as it runs. A throwing handler is isolated so one bad
   * subscriber can never take a protocol call (or another subscriber) down with it.
   */
  on(method: string, handler: CdpEventHandler): void {
    const handlers = this.listeners.get(method) ?? new Set<CdpEventHandler>();
    handlers.add(handler);
    this.listeners.set(method, handlers);
  }

  off(method: string, handler: CdpEventHandler): void {
    const handlers = this.listeners.get(method);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.listeners.delete(method);
  }

  /** Waits for one CDP event. Needed for protocol flows that are event-driven, e.g. the file chooser. */
  waitForEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) ?? [];
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.eventWaiters.set(method, (this.eventWaiters.get(method) ?? []).filter((item) => item !== entry));
          reject(new Error(`Timed out waiting for CDP event ${method} after ${timeoutMs} ms`));
        }, timeoutMs)
      };
      waiters.push(entry);
      this.eventWaiters.set(method, waiters);
    });
  }

  private constructor(private readonly socket: CdpSocketLike) {
    socket.addEventListener("message", (event) => {
      let envelope: CdpEnvelope;
      try {
        envelope = JSON.parse(String(event.data)) as CdpEnvelope;
      } catch {
        return;
      }
      if (typeof envelope.id !== "number") {
        const method = (envelope as { method?: string }).method;
        if (!method) return;
        const params = ((envelope as { params?: Record<string, unknown> }).params) ?? {};
        for (const handler of [...(this.listeners.get(method) ?? [])]) {
          try { handler(params); } catch {}
        }
        const waiters = this.eventWaiters.get(method);
        if (!waiters?.length) return;
        this.eventWaiters.delete(method);
        for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(params); }
        return;
      }
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      this.pending.delete(envelope.id);
      if (envelope.error) {
        pending.reject(new Error(envelope.error.message ?? "Chrome DevTools Protocol error"));
      } else {
        pending.resolve(envelope.result ?? {});
      }
    });
    socket.addEventListener("close", () => {
      for (const request of this.pending.values()) request.reject(new Error("Chrome DevTools Protocol socket closed"));
      this.pending.clear();
      for (const waiters of this.eventWaiters.values()) for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error("Chrome DevTools Protocol socket closed")); }
      this.eventWaiters.clear();
    });
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to Chrome DevTools at ${url}`)), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed connecting to Chrome DevTools at ${url}`));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  /** Wraps an already-open socket (or an in-memory fake) without any network handshake. */
  static fromSocket(socket: CdpSocketLike): CdpClient {
    return new CdpClient(socket);
  }

  /**
   * Every protocol call is bounded. Without this a browser that stops answering -- a crashed
   * renderer, a frozen tab -- left the caller waiting forever: a live qualification hung with no
   * output and no evidence, and nothing in the system could notice. A hang is a failure.
   */
  send(method: string, params: Readonly<Record<string, unknown>> = {}, timeoutMs = 90_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools Protocol call ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface DebugTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function waitForDevTools(profileDirectory: string, timeoutMs: number): Promise<{ port: number; browserWsPath: string }> {
  const marker = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const [portLine, browserWsPath] = readFileSync(marker, "utf8").trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && browserWsPath) return { port, browserWsPath };
    }
    await sleep(50);
  }
  throw new Error(`Chromium did not expose DevToolsActivePort within ${timeoutMs} ms`);
}

async function waitForTarget(port: number, targetId: string, timeoutMs: number): Promise<DebugTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (response.ok) {
      const targets = await response.json() as DebugTarget[];
      const target = targets.find((candidate) => candidate.id === targetId && candidate.webSocketDebuggerUrl);
      if (target) return target;
    }
    await sleep(50);
  }
  throw new Error(`Chromium target ${targetId} did not become attachable within ${timeoutMs} ms`);
}

export interface ChromiumCdpRuntimeConfig {
  profilesRoot: string;
  executablePath?: string;
  launchTimeoutMs?: number;
  extraArgs?: readonly string[];
}

export function buildChromiumArgs(profileDirectory: string, options: BrowserRuntimeLaunchOptions, extraArgs: readonly string[] = []): string[] {
  const args = [
    `--user-data-dir=${profileDirectory}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--disable-background-mode",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--no-pings",
    "--password-store=basic",
    // Google's sign-in blocks browsers it flags as automated ("this browser may not be secure").
    // This switch removes the navigator.webdriver signal the CDP launch would otherwise expose;
    // it changes no other behaviour and the persistent human-login profile stays a normal login.
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate",
    ...extraArgs
  ];
  if (options.headless) args.push("--headless=new", "--disable-gpu", "--no-sandbox");
  args.push("about:blank");
  return args;
}

export class ChromiumCdpRuntimeAdapter implements BrowserRuntimePort {
  private readonly resolver: BrowserProfileDirectoryResolver;
  private readonly executablePath: string;
  private readonly launchTimeoutMs: number;

  constructor(private readonly config: ChromiumCdpRuntimeConfig) {
    this.resolver = new BrowserProfileDirectoryResolver(config.profilesRoot);
    this.executablePath = config.executablePath ?? resolveChromiumExecutablePath();
    this.launchTimeoutMs = config.launchTimeoutMs ?? 15_000;
  }

  async launch(identity: BrowserIdentity, options: BrowserRuntimeLaunchOptions): Promise<BrowserPageSessionPort> {
    const profileDirectory = this.resolver.resolve(identity.profileKey);
    // A stale DevToolsActivePort from an unclean prior shutdown must never be trusted.
    rmSync(join(profileDirectory, "DevToolsActivePort"), { force: true });
    const args = buildChromiumArgs(profileDirectory, options, this.config.extraArgs ?? []);
    const child = spawn(this.executablePath, args, { stdio: "ignore" });
    let exited = false;
    child.once("exit", () => { exited = true; });

    try {
      const { port, browserWsPath } = await waitForDevTools(profileDirectory, this.launchTimeoutMs);
      if (exited) throw new Error("Chromium exited before DevTools was ready");
      const browser = await CdpClient.connect(`ws://127.0.0.1:${port}${browserWsPath}`);
      const created = await browser.send("Target.createTarget", { url: options.initialUrl });
      const targetId = String(created.targetId ?? "");
      if (!targetId) throw new Error("Chromium did not return a target id");
      const target = await waitForTarget(port, targetId, this.launchTimeoutMs);
      if (!target.webSocketDebuggerUrl) throw new Error("Chromium target has no page debugger URL");
      const page = await CdpClient.connect(target.webSocketDebuggerUrl);
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Network.enable");
      await page.send("DOM.enable");

      let closed = false;
      const session: BrowserPageSessionPort = {
        identityId: identity.identityId,
        profileDirectory,
        async navigate(url: string): Promise<void> {
          const navigation = await page.send("Page.navigate", { url });
          if (navigation.errorText) throw new Error(`Navigation failed: ${String(navigation.errorText)}`);
          // 10 s was too tight once redirect chains began being waited out rather than thrown:
          // Instagram's settings page settles in that window only on a good day, and a healthy
          // session was reported UNREACHABLE mid-qualification. Still bounded, just honest.
          const deadline = Date.now() + 25_000;
          let stableUrl = "";
          let stableCount = 0;
          while (Date.now() < deadline) {
            let snapshot: { href: string; ready: string };
            try {
              snapshot = await this.evaluate<{ href: string; ready: string }>(`({ href: location.href, ready: document.readyState })`);
            } catch (error) {
              // A redirect chain destroys the execution context mid-poll -- the normal case for
              // YouTube Studio, which bounced the whole login run with "Inspected target
              // navigated or closed". Redirecting is what we are waiting for; keep waiting until
              // the deadline. Non-navigation failures still escape immediately.
              const message = error instanceof Error ? error.message : String(error);
              if (!/navigated or closed|execution context was destroyed|cannot find context/i.test(message)) throw error;
              await sleep(120);
              continue;
            }
            const isDocumentReady = snapshot.ready === "complete" || snapshot.ready === "interactive";
            const targetAllowsBlank = url === "about:blank";
            const hasReachedUsableDocument = targetAllowsBlank
              ? snapshot.href === "about:blank"
              : snapshot.href !== "about:blank" && !snapshot.href.startsWith("chrome://newtab");
            if (isDocumentReady && hasReachedUsableDocument) {
              if (snapshot.href === stableUrl) stableCount += 1;
              else { stableUrl = snapshot.href; stableCount = 1; }
              if (stableCount >= 2) return;
            }
            await sleep(75);
          }
          throw new Error(`Navigation did not settle within 25000 ms: ${url}`);
        },
        async currentUrl(): Promise<string> {
          return this.evaluate<string>("location.href");
        },
        async evaluate<T>(expression: string): Promise<T> {
          const result = await page.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true
          });
          const exceptionDetails = result.exceptionDetails;
          if (exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(exceptionDetails)}`);
          const remote = result.result as { value?: T; description?: string } | undefined;
          if (!remote) throw new Error("Browser evaluation returned no result");
          return remote.value as T;
        },
        async clickAt(x: number, y: number): Promise<void> {
          const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, pointerType: "mouse" };
          await page.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none", clickCount: 0 });
          await page.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
          await page.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
        },
        async setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<void> {
          await page.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: false });
        },
        async pressKey(key: "a" | "Delete" | "Backspace" | "Enter", modifiers: { meta?: boolean; ctrl?: boolean } = {}): Promise<void> {
          const descriptors: Readonly<Record<string, { code: string; keyCode: number; text?: string }>> = {
            a: { code: "KeyA", keyCode: 65, text: "a" },
            Delete: { code: "Delete", keyCode: 46 },
            Backspace: { code: "Backspace", keyCode: 8 },
            Enter: { code: "Enter", keyCode: 13, text: "\r" }
          };
          const descriptor = descriptors[key];
          if (!descriptor) throw new Error(`Unsupported key: ${key}`);
          const mask = (modifiers.meta ? 4 : 0) | (modifiers.ctrl ? 2 : 0);
          const base = { key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode, modifiers: mask };
          await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(descriptor.text && mask === 0 ? { text: descriptor.text } : {}) });
          await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
        },
        async typeText(text: string, delayMs?: (index: number) => number): Promise<void> {
          for (let index = 0; index < text.length; index += 1) {
            const char = text[index]!;
            if (char === "\n") {
              await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
              await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            } else {
              await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char, unmodifiedText: char });
              await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
            }
            const wait = delayMs?.(index) ?? 0;
            if (wait > 0) await sleep(wait);
          }
        },
        async insertText(text: string): Promise<void> {
          await page.send("Input.insertText", { text });
        },
        async setInputFiles(selector: string, filePaths: readonly string[]): Promise<void> {
          if (filePaths.length === 0) throw new Error("setInputFiles requires at least one file");
          const documentResult = await page.send("DOM.getDocument", { depth: 1, pierce: true });
          const root = documentResult.root as { nodeId?: number } | undefined;
          if (!root?.nodeId) throw new Error("Chromium did not return a DOM root node");
          const query = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector });
          const nodeId = Number(query.nodeId ?? 0);
          if (!Number.isInteger(nodeId) || nodeId <= 0) throw new Error(`File input not found for selector: ${selector}`);
          await page.send("DOM.setFileInputFiles", { nodeId, files: [...filePaths] });
          // Verified readback: TikTok's upload input accepted the protocol call without error and
          // still held zero files, so the page waited forever for an upload that never began.
          // Silent success is the one outcome an irreversible-adjacent step may never report.
          const accepted = await this.evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && el.files && el.files.length > 0); })()`).catch(() => false);
          if (!accepted) throw new FileInputRejectedError(`File input did not accept the file for selector: ${selector}`);
        },
        async setInputFilesInPage(selector: string, filePath: string): Promise<void> {
          // TikTok ignores DOM.setFileInputFiles entirely (verified: no error, zero files, no
          // upload) but accepts the page's own DataTransfer path, which is what a human drop
          // does. The payload is streamed in chunks: a real video must never have to fit into a
          // single protocol message.
          const bytes = readFileSync(filePath);
          const base64 = bytes.toString("base64");
          const limitBytes = 256 * 1024 * 1024;
          if (bytes.length > limitBytes) throw new Error(`File is too large for in-page upload: ${bytes.length} bytes`);
          const name = filePath.split("/").at(-1) ?? "upload.mp4";
          const chunkSize = 512 * 1024;
          await this.evaluate("(() => { window.__flerdvisionUpload = []; return true; })()");
          for (let offset = 0; offset < base64.length; offset += chunkSize) {
            const chunk = base64.slice(offset, offset + chunkSize);
            await this.evaluate(`(() => { window.__flerdvisionUpload.push(${JSON.stringify(chunk)}); return true; })()`);
          }
          const accepted = await this.evaluate<{ ok: boolean; reason: string }>(`(() => {
            const chunks = window.__flerdvisionUpload || [];
            delete window.__flerdvisionUpload;
            const binary = atob(chunks.join(""));
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            const file = new File([bytes], ${JSON.stringify(name)}, { type: "video/mp4" });
            // The marker attribute can be dropped by the app's own re-render between locating the
            // input and handing over the bytes; the file input itself is what matters here.
            const marked = document.querySelector(${JSON.stringify(selector)});
            const input = marked || document.querySelector('input[type="file"]');
            if (!input) return { ok: false, reason: "no file input on the page" };
            const transfer = new DataTransfer();
            transfer.items.add(file);
            try { input.files = transfer.files; } catch (error) { return { ok: false, reason: "assignment threw: " + String(error && error.message || error) }; }
            if (!input.files || input.files.length === 0) return { ok: false, reason: marked ? "marked input kept zero files" : "fallback input kept zero files" };
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, reason: (marked ? "marked" : "fallback") + " input accepted " + input.files.length + " file(s)" };
          })()`);
          if (!accepted?.ok) throw new Error(`In-page file handover was rejected (${accepted?.reason ?? "no diagnosis"}) for selector: ${selector}`);
        },
        async setInputFilesViaChooser(filePaths: readonly string[], openChooser: () => Promise<void>, timeoutMs: number): Promise<void> {
          if (filePaths.length === 0) throw new Error("setInputFilesViaChooser requires at least one file");
          await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
          try {
            // Arm the waiter before the click: the event can arrive before the click resolves.
            // Its rejection must never go unobserved -- when the click itself failed, the armed
            // waiter later rejected with nobody listening and took the whole process down with
            // an unhandled rejection that named the wrong mechanism.
            const opened = page.waitForEvent("Page.fileChooserOpened", timeoutMs);
            const observed = opened.catch((error: unknown) => ({ __failed: error instanceof Error ? error : new Error(String(error)) }));
            await openChooser();
            const result = await observed;
            if ("__failed" in result) throw (result as { __failed: Error }).__failed;
            const params = result as Record<string, unknown>;
            const backendNodeId = Number(params.backendNodeId ?? 0);
            if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) throw new Error("File chooser did not name a backing node");
            await page.send("DOM.setFileInputFiles", { backendNodeId, files: [...filePaths] });
          } finally {
            await page.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
          }
        },
        async captureScreenshot(filePath: string): Promise<void> {
          const result = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
          const data = typeof result.data === "string" ? result.data : "";
          if (!data) throw new Error("Chromium returned an empty screenshot");
          mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
          writeFileSync(filePath, data, { encoding: "base64", mode: 0o600 });
        },
        async setCookie(url: string, name: string, value: string, expires?: number): Promise<void> {
          const result = await page.send("Network.setCookie", {
            url, name, value,
            ...(typeof expires === "number" ? { expires } : {})
          });
          if (result.success !== true) throw new Error(`Chromium refused cookie ${name} for ${url}`);
        },
        async cookies(url: string) {
          const result = await page.send("Network.getCookies", { urls: [url] });
          const cookies = (result.cookies ?? []) as Array<{ name: string; value: string; domain: string; path: string; expires?: number }>;
          return cookies.map((cookie) => ({
            name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
            ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {})
          }));
        },
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          try { page.close(); } catch {}
          try { await browser.send("Browser.close"); } catch {}
          try { browser.close(); } catch {}
          const deadline = Date.now() + 5_000;
          while (!exited && Date.now() < deadline) await sleep(50);
          if (!exited) child.kill("SIGTERM");
        }
      };
      await session.navigate(options.initialUrl);
      return session;
    } catch (error) {
      if (!exited) child.kill("SIGTERM");
      throw error;
    }
  }
}
