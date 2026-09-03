import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BrowserIdentityStorePort } from "../../domain/browser-identity-ports.js";
import type { ControlPlaneStorePort } from "../../domain/control-plane-ports.js";
import type { IncidentStorePort, HumanActionStorePort, KillSwitchStorePort } from "../../domain/operations-ports.js";
import { DailyOperationsService, HumanRecoveryService, KillSwitchService } from "../../application/operations.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function parseBasicAuth(header: string | string[] | undefined): { username: string; password: string } | null {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split < 0) return null;
    return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
  } catch { return null; }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return await new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => resolve(new URLSearchParams(body)));
  });
}

type OpsUiStore = ControlPlaneStorePort & IncidentStorePort & HumanActionStorePort & KillSwitchStorePort & BrowserIdentityStorePort;

export interface OpsHttpServerOptions {
  host?: string;
  port?: number;
  username?: string;
  password: string;
  businessDate?: () => string;
  now?: () => string;
  operatorSessionBaseUrl?: string;
}

export class OpsHttpServer {
  private server: Server | undefined;
  private readonly csrfToken: string;
  private readonly now: () => string;
  private readonly businessDate: () => string;

  constructor(private readonly store: OpsUiStore, private readonly options: OpsHttpServerOptions) {
    if (!options.password) throw new Error("Ops UI password is required");
    this.csrfToken = createHash("sha256").update(`${Date.now()}|${Math.random()}`).digest("hex");
    this.now = options.now ?? (() => new Date().toISOString());
    this.businessDate = options.businessDate ?? (() => new Date(this.now()).toISOString().slice(0, 10));
  }

  private authorized(req: IncomingMessage): boolean {
    const auth = parseBasicAuth(req.headers.authorization);
    return Boolean(auth && auth.username === (this.options.username ?? "flerdvision") && auth.password === this.options.password);
  }

  private deny(res: ServerResponse): void {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="Flerdvision Ops"');
    res.end("Authentication required");
  }

  private redirect(res: ServerResponse, location = "/"): void {
    res.statusCode = 303;
    res.setHeader("Location", location);
    res.end();
  }

  private recoveryHint(kind: string): string {
    if (kind === "AUTH_REQUIRED" || kind === "CHALLENGE") return "Open the isolated browser session, complete normal login/2FA, run a health check, then Resume while the original slot is still valid.";
    if (kind === "IDENTITY_MISMATCH") return "Do not publish. Confirm the expected account in the isolated browser profile before any resume.";
    if (kind === "PUBLISH_UNCERTAIN") return "Never Resume or retry directly. Run W5 reconciliation until the post is VERIFIED or explicitly SAFE_TO_RETRY.";
    if (kind === "MISSED_WINDOW") return "Catch-up is automatic only for never-attempted posts within the catch-up window (default 4 h); after that the slot is waived. Waive this slot or create an explicit later scheduling decision.";
    return "Review evidence and state history. Resolve only after the underlying condition is removed.";
  }

  private html(): string {
    const incidents = this.store.listIncidents(["OPEN", "ACKNOWLEDGED"]);
    const switches = this.store.listKillSwitches();
    const summary = new DailyOperationsService(this.store).summary(this.businessDate(), this.now());
    const incidentRows = incidents.map((incident) => `
      <tr>
        <td>${escapeHtml(incident.severity)}</td><td>${escapeHtml(incident.kind)}</td><td>${escapeHtml(incident.status)}</td>
        <td>${escapeHtml(incident.title)}<br><small>${escapeHtml(incident.summary)}</small><br><small><strong>Recovery:</strong> ${escapeHtml(this.recoveryHint(incident.kind))}</small>${incident.scope.browserIdentityId && this.options.operatorSessionBaseUrl ? `<br><a href="${escapeHtml(this.options.operatorSessionBaseUrl.replace(/\/$/, ""))}/${encodeURIComponent(incident.scope.browserIdentityId)}" target="_blank" rel="noreferrer">Open browser session</a>` : ""}</td>
        <td>${escapeHtml(incident.scope.accountId ?? incident.scope.intentId ?? incident.scope.browserIdentityId ?? "-")}</td>
        <td>
          <form method="post" action="/actions/incidents/${encodeURIComponent(incident.incidentId)}/ack">
            <input type="hidden" name="csrf" value="${this.csrfToken}"><input name="note" placeholder="note"><button>Acknowledge</button>
          </form>
          <form method="post" action="/actions/incidents/${encodeURIComponent(incident.incidentId)}/resolve">
            <input type="hidden" name="csrf" value="${this.csrfToken}"><input name="note" required placeholder="resolution"><button>Resolve</button>
          </form>
          ${incident.scope.intentId ? `<form method="post" action="/actions/intents/${encodeURIComponent(incident.scope.intentId)}/resume"><input type="hidden" name="csrf" value="${this.csrfToken}"><input name="note" required placeholder="resume reason"><button>Resume</button></form>
          <form method="post" action="/actions/intents/${encodeURIComponent(incident.scope.intentId)}/waive"><input type="hidden" name="csrf" value="${this.csrfToken}"><input name="reason" required placeholder="waive reason"><button>Waive</button></form>` : ""}
        </td>
      </tr>`).join("");
    const switchRows = switches.map((item) => `<li>${escapeHtml(item.scopeType)}:${escapeHtml(item.scopeKey)} — <strong>${item.enabled ? "ON" : "OFF"}</strong> — ${escapeHtml(item.reason)}</li>`).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Flerdvision Ops</title><style>
      body{font-family:system-ui,sans-serif;max-width:1200px;margin:30px auto;padding:0 20px} table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}form{margin:4px 0}input,select,button{padding:6px}small{color:#555}.kpi{display:inline-block;margin-right:18px}
    </style></head><body>
    <h1>Flerdvision Operations</h1>
    <p><span class="kpi">Date <strong>${escapeHtml(summary.businessDate)}</strong></span><span class="kpi">Total <strong>${summary.total}</strong></span><span class="kpi">Verified <strong>${summary.verified}</strong></span><span class="kpi">Blocked <strong>${summary.blocked}</strong></span><span class="kpi">Uncertain <strong>${summary.uncertain}</strong></span><span class="kpi">Incidents <strong>${summary.openIncidents}</strong></span></p>
    <h2>Active incidents</h2><table><thead><tr><th>Severity</th><th>Kind</th><th>Status</th><th>Incident</th><th>Scope</th><th>Actions</th></tr></thead><tbody>${incidentRows || "<tr><td colspan=6>No active incidents</td></tr>"}</tbody></table>
    <h2>Kill switches</h2><ul>${switchRows || "<li>None configured</li>"}</ul>
    <form method="post" action="/actions/kill-switch"><input type="hidden" name="csrf" value="${this.csrfToken}">
      <select name="scopeType"><option>GLOBAL</option><option>ACCOUNT</option><option>PLATFORM</option></select>
      <input name="scopeKey" value="*" required><select name="enabled"><option value="true">ON</option><option value="false">OFF</option></select>
      <input name="reason" required placeholder="reason"><button>Set</button></form>
    </body></html>`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) { this.deny(res); return; }
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?", 1)[0] ?? "/";
    if (method === "GET" && path === "/") {
      res.statusCode = 200; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(this.html()); return;
    }
    if (method !== "POST") { res.statusCode = 404; res.end("Not found"); return; }
    const form = await readForm(req);
    if (form.get("csrf") !== this.csrfToken) { res.statusCode = 403; res.end("Invalid CSRF token"); return; }
    const operator = this.options.username ?? "flerdvision";
    const now = this.now();
    const incidentAck = path.match(/^\/actions\/incidents\/([^/]+)\/ack$/);
    const incidentResolve = path.match(/^\/actions\/incidents\/([^/]+)\/resolve$/);
    const intentResume = path.match(/^\/actions\/intents\/([^/]+)\/resume$/);
    const intentWaive = path.match(/^\/actions\/intents\/([^/]+)\/waive$/);
    try {
      const recovery = new HumanRecoveryService(this.store);
      if (incidentAck) recovery.acknowledgeIncident(decodeURIComponent(incidentAck[1]!), now, operator, form.get("note") ?? undefined);
      else if (incidentResolve) recovery.resolveIncident(decodeURIComponent(incidentResolve[1]!), now, operator, form.get("note") ?? "");
      else if (intentResume) recovery.resumeIntent(decodeURIComponent(intentResume[1]!), now, operator, form.get("note") ?? "");
      else if (intentWaive) recovery.waiveIntent(decodeURIComponent(intentWaive[1]!), now, operator, form.get("reason") ?? "");
      else if (path === "/actions/kill-switch") {
        const scopeType = form.get("scopeType");
        if (scopeType !== "GLOBAL" && scopeType !== "ACCOUNT" && scopeType !== "PLATFORM") throw new Error("Invalid kill switch scope");
        new KillSwitchService(this.store).set(scopeType, form.get("scopeKey") ?? "", form.get("enabled") === "true", form.get("reason") ?? "", now, operator);
      } else { res.statusCode = 404; res.end("Not found"); return; }
      this.redirect(res);
    } catch (error) {
      res.statusCode = 409;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("Ops server already started");
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 0;
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Ops server did not expose a TCP address");
    return { host, port: address.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
