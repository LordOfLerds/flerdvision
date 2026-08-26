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

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let envelope: CdpEnvelope;
      try {
        envelope = JSON.parse(String(event.data)) as CdpEnvelope;
      } catch {
        return;
      }
      if (typeof envelope.id !== "number") return;
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

  send(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
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
          const deadline = Date.now() + 10_000;
          let stableUrl = "";
          let stableCount = 0;
          while (Date.now() < deadline) {
            const snapshot = await this.evaluate<{ href: string; ready: string }>(`({ href: location.href, ready: document.readyState })`);
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
          throw new Error(`Navigation did not settle within 10000 ms: ${url}`);
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
        async setInputFiles(selector: string, filePaths: readonly string[]): Promise<void> {
          if (filePaths.length === 0) throw new Error("setInputFiles requires at least one file");
          const documentResult = await page.send("DOM.getDocument", { depth: 1, pierce: true });
          const root = documentResult.root as { nodeId?: number } | undefined;
          if (!root?.nodeId) throw new Error("Chromium did not return a DOM root node");
          const query = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector });
          const nodeId = Number(query.nodeId ?? 0);
          if (!Number.isInteger(nodeId) || nodeId <= 0) throw new Error(`File input not found for selector: ${selector}`);
          await page.send("DOM.setFileInputFiles", { nodeId, files: [...filePaths] });
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
