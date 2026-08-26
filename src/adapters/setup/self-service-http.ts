import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FixedTestRunnerPort, WorkspaceRegistryPort } from "../../domain/workspace-ports.js";
import type { OperatorBrowserSession } from "../../application/browser-bootstrap.js";
import { WorkspaceService, workspaceRuntimeLayout } from "../../application/workspaces.js";
import { TestLabService, SELF_SERVICE_TEST_CATALOG } from "../../application/test-lab.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../browser/profile-lock.js";
import { ChromiumCdpRuntimeAdapter } from "../browser/chromium-cdp.js";
import { BrowserBootstrapService } from "../../application/browser-bootstrap.js";
import type { Platform } from "../../domain/model.js";
import type { ChannelDiscoveryPort } from "../../domain/channel-discovery-ports.js";
import type { ChannelDiscoveryResult } from "../../domain/channel-discovery.js";
import { deriveProfileKey, selectDiscoveredChannel } from "../../domain/channel-discovery.js";
import { SetupChannelRegistrationService } from "../../application/setup-channel-registration.js";
import { loginProfileKey, seedChannelProfile } from "../../application/login-profile.js";
import { computeSetupProgress, assertPrerequisite, type SetupProgress } from "../../application/setup-progress.js";
import type { SourceFolderBrowserPort } from "../../domain/source-folder-ports.js";
import type { SourceFolderListing, SourceFolderPreview } from "../../domain/source-folder.js";
import { DRIVE_ROOT } from "../ingress/google-drive/google-drive-browser.js";
import { FileDriveCredentialStore, type StoredDriveCredential } from "../ingress/google-drive/drive-credentials.js";

interface SelectedFolder { folderId: string; folderPath: string; preview?: SourceFolderPreview; selectedAt: string; }
interface TestResultRecord { testId: string; passed: boolean; summary: string; checkedAt: string; artifactRefs: readonly string[]; }
interface RetainedOperatorSession { session: OperatorBrowserSession; store: SqliteControlPlaneStore; profileKey: string; platform: Platform; }
interface PendingDiscovery { platform: Platform; result: ChannelDiscoveryResult; }

function escapeHtml(value: string): string { return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function parseBasicAuth(header: string | string[] | undefined): {username:string;password:string}|null { if(typeof header!=="string"||!header.startsWith("Basic "))return null; try{const decoded=Buffer.from(header.slice(6),"base64").toString("utf8"); const i=decoded.indexOf(":"); return i<0?null:{username:decoded.slice(0,i),password:decoded.slice(i+1)};}catch{return null;} }
async function readForm(req: IncomingMessage): Promise<URLSearchParams> { return await new Promise((resolvePromise)=>{let body="";req.on("data",c=>{body+=c.toString();});req.on("end",()=>resolvePromise(new URLSearchParams(body)));}); }
function platform(value: string): Platform { if(value==="instagram"||value==="tiktok"||value==="youtube") return value; throw new Error(`Unsupported platform: ${value}`); }
function bootstrapUrl(platformName: Platform): string { return platformName === "instagram" ? "https://www.instagram.com/" : platformName === "tiktok" ? "https://www.tiktok.com/" : "https://studio.youtube.com/"; }

export interface SelfServiceHttpOptions {
  runtimeRoot: string;
  repoRoot: string;
  password: string;
  username?: string;
  host?: string;
  port?: number;
  chromiumExecutablePath: string;
  testRunner: FixedTestRunnerPort;
  /** Absent until a deployment supplies OAuth credentials; step 1 then explains what is missing. */
  folderBrowser?: SourceFolderBrowserPort;
  /** Absent until discovery specs are calibrated; step 4 then refuses rather than inviting typing. */
  channelDiscovery?: ChannelDiscoveryPort;
  /** Absent until a deployment supplies an OAuth client. */
  driveOAuth?: DriveOAuthPort;
  /**
   * A directory the operator may pick from. Set this and the workspace needs no Google credential
   * at all: a mounted Google Drive, OneDrive or Dropbox folder is an ordinary directory.
   */
  localSourceRoot?: string;
  /**
   * The login browser is visible by default -- the operator has to type into it. Headless exists
   * for automated end-to-end runs of this wizard, which must be able to exercise the real flow.
   */
  headlessLogin?: boolean;
}

/**
 * The OAuth half of connecting Drive, kept behind a port so the wizard can be exercised without
 * talking to Google and so a deployment without credentials degrades to an explanation.
 */
export interface DriveOAuthPort {
  begin(workspaceId: string): { state: string; codeVerifier: string; authorizationUrl: string };
  complete(workspaceId: string, code: string, codeVerifier: string): Promise<StoredDriveCredential>;
}

/**
 * The setup wizard.
 *
 * Two properties matter more than the markup. First, step order is enforced from durable facts,
 * so a hand-made POST cannot bind a folder to a channel that was never confirmed. Second, nothing
 * on the account path accepts a typed handle: registration only ever consumes a discovery result.
 */
export class SelfServiceHttpServer {
  private server: Server | undefined;
  private readonly csrf = createHash("sha256").update(`${Date.now()}|${Math.random()}`).digest("hex");
  private readonly sessions = new Map<string, RetainedOperatorSession>();
  private readonly discoveries = new Map<string, PendingDiscovery>();
  private readonly selections = new Map<string, SelectedFolder>();

  constructor(private readonly registry: WorkspaceRegistryPort, private readonly options: SelfServiceHttpOptions) {
    if (!options.password) throw new Error("Self-service UI password is required");
  }

  private authorized(req: IncomingMessage): boolean { const auth=parseBasicAuth(req.headers.authorization); return Boolean(auth&&auth.username===(this.options.username??"flerdvision")&&auth.password===this.options.password); }
  private deny(res: ServerResponse): void { res.statusCode=401;res.setHeader("WWW-Authenticate",'Basic realm="Flerdvision Setup"');res.end("Authentication required"); }
  private redirect(res: ServerResponse, location:string): void { res.statusCode=303;res.setHeader("Location",location);res.end(); }
  private actor() { return { type: "operator" as const, id: this.options.username ?? "flerdvision" }; }
  private layout(workspaceId: string) { return workspaceRuntimeLayout(this.options.runtimeRoot, workspaceId); }
  private credentials(workspaceId: string) { return new FileDriveCredentialStore(this.layout(workspaceId).configDir); }
  private testsPath(workspaceId:string): string { return resolve(this.layout(workspaceId).configDir,"test-results.json"); }
  private readTests(workspaceId:string): TestResultRecord[] { const p=this.testsPath(workspaceId); return existsSync(p)?JSON.parse(readFileSync(p,"utf8")) as TestResultRecord[]:[]; }
  private recordTest(workspaceId:string,result:TestResultRecord):void { const all=this.readTests(workspaceId).filter(x=>x.testId!==result.testId); all.push(result); writeFileSync(this.testsPath(workspaceId),JSON.stringify(all,null,2),{encoding:"utf8",mode:0o600}); }

  /** A source counts as connected when either credential path is satisfied. */
  private sourceConnected(workspaceId: string): boolean {
    return Boolean(this.options.localSourceRoot) || this.credentials(workspaceId).status().connected;
  }

  /** Progress is recomputed from storage on every request; nothing about it is cached in a page. */
  progress(workspaceId: string): SetupProgress {
    const store = new SqliteControlPlaneStore(this.layout(workspaceId).databasePath);
    try {
      return computeSetupProgress({
        driveConnected: this.sourceConnected(workspaceId),
        folderSelected: this.selections.has(workspaceId),
        sessionDiscovered: this.discoveries.has(workspaceId),
        registeredAccounts: store.listSocialAccounts().length,
        bindings: store.listChannelSourceBindings().length
      });
    } finally { store.close(); }
  }

  // ---------------- rendering ----------------

  private shell(title:string, body:string):string {
    return `<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:1000px;margin:30px auto;padding:0 20px;line-height:1.55;color:#111}
a{color:#0e6b70}.card{border:1px solid #d8dedd;border-radius:10px;padding:16px 18px;margin:14px 0}
.card.now{border-color:#0e6b70;box-shadow:0 0 0 1px #0e6b70}.card.locked{opacity:.55}
.ok{color:#2f6b45}.warn{color:#8a6516}.bad{color:#9e3b2f}
input,select,button{padding:7px;margin:3px;font:inherit}button{cursor:pointer}
code,pre{background:#f2f5f4;padding:2px 5px;border-radius:4px;font-family:ui-monospace,monospace;font-size:.9em}
pre{white-space:pre-wrap;padding:10px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #e2e8e7;padding:7px;text-align:left}
.step{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#71827e;margin:0 0 4px}
.proof{border-left:3px solid #2f6b45;background:#f2f5f4;padding:10px 14px;margin:10px 0}
.gate{border-left:3px solid #9e3b2f;background:#f9efed;padding:10px 14px;margin:10px 0}
</style></head><body>${body}</body></html>`;
  }

  private home():string {
    const rows=this.registry.list().map(w=>`<tr><td><a href="/workspaces/${encodeURIComponent(w.workspaceId)}">${escapeHtml(w.displayName)}</a></td><td><code>${escapeHtml(w.workspaceId)}</code></td><td>${escapeHtml(w.status)}</td><td>${escapeHtml(w.timezone)}</td></tr>`).join("");
    return this.shell("Flerdvision Setup",`<h1>Flerdvision Self-Service</h1><p>Jeder Workspace ist getrennt: eigene Datenbank, eigene Browserprofile, eigene Evidence.</p><table><tr><th>Name</th><th>ID</th><th>Status</th><th>Zeitzone</th></tr>${rows||"<tr><td colspan=4>Noch keine Workspaces</td></tr>"}</table><div class=card><h2>Workspace anlegen</h2><form method=post action=/workspaces><input type=hidden name=csrf value=${this.csrf}><input name=workspaceId placeholder="workspace id" required><input name=displayName placeholder="Anzeigename" required><input name=timezone value="Europe/Vienna" required><button>Anlegen</button></form></div>`);
  }

  private card(index: number, title: string, done: boolean, current: boolean, body: string): string {
    const cls = current ? "card now" : done ? "card" : "card locked";
    const mark = done ? '<span class="ok">✓</span>' : current ? "▶" : "•";
    return `<div class="${cls}"><p class=step>Schritt ${index} ${mark}</p><h2>${escapeHtml(title)}</h2>${body}</div>`;
  }

  private driveCard(workspaceId: string, p: SetupProgress): string {
    if (this.options.localSourceRoot) {
      return this.card(1, "Quelle", true, false,
        `<div class=proof>Lokaler Ordner: <code>${escapeHtml(this.options.localSourceRoot)}</code><br>
         Kein Google-Konto, kein Token, nichts zu registrieren. Ein per Google&nbsp;Drive for Desktop,
         OneDrive oder Dropbox eingehängter Ordner ist hier einfach ein Verzeichnis.</div>`);
    }
    const status = this.credentials(workspaceId).status();
    if (status.connected) {
      return this.card(1, "Quelle", true, false,
        `<div class=proof>Google Drive verbunden${status.connectedAccount?` als <code>${escapeHtml(status.connectedAccount)}</code>`:""} seit ${escapeHtml(status.connectedAt ?? "")}.</div>
         <form method=post action="/workspaces/${workspaceId}/drive/disconnect"><input type=hidden name=csrf value=${this.csrf}><button>Verbindung lösen</button></form>`);
    }
    const oauthPart = this.options.driveOAuth
      ? `<form method=post action="/workspaces/${workspaceId}/drive/connect"><input type=hidden name=csrf value=${this.csrf}><button>Google-Login öffnen</button></form>`
      : `<p>Für den API-Weg fehlen <code>GOOGLE_OAUTH_CLIENT_ID</code> und <code>GOOGLE_OAUTH_CLIENT_SECRET</code>.</p>`;
    return this.card(1, "Quelle", false, p.currentStep === "DRIVE",
      `<div class=gate>Keine Quelle konfiguriert. Es gibt zwei Wege, und der einfachere braucht gar nichts:</div>
       <p><strong>Ohne Zugangsdaten:</strong> Starte die UI mit <code>--source-root &lt;Pfad&gt;</code> bzw. <code>FLERDVISION_SOURCE_ROOT</code> und zeig auf deinen eingehängten Cloud-Ordner. Derselbe Picker, dieselben Verknüpfungen.</p>
       <p><strong>Über die Drive-API:</strong> braucht einen Installed-App-Client. Nur nötig, wenn der Ordner nicht als Laufwerk eingehängt ist — etwa später auf dem VPS.</p>
       ${oauthPart}`);
  }

  private folderCard(workspaceId: string, p: SetupProgress): string {
    const selected = this.selections.get(workspaceId);
    const unlocked = p.facts.driveConnected;
    if (selected) {
      const pv = selected.preview;
      return this.card(2, "Ordner wählen", true, false,
        `<div class=proof><strong>${escapeHtml(selected.folderPath)}</strong>${pv?`<br>${pv.videoCount} Videos${pv.otherCount?`, ${pv.otherCount} weitere Dateien`:""}${pv.newestName?`<br>Neuestes: <code>${escapeHtml(pv.newestName)}</code>`:""}`:""}</div>
         <p><a href="/workspaces/${workspaceId}/browse?folderId=${encodeURIComponent(DRIVE_ROOT)}">Anderen Ordner wählen</a></p>`);
    }
    if (!unlocked) return this.card(2, "Ordner wählen", false, false, `<div class=gate>Zuerst Drive verbinden.</div>`);
    return this.card(2, "Ordner wählen", false, p.currentStep === "FOLDER",
      `<p><a href="/workspaces/${workspaceId}/browse?folderId=${encodeURIComponent(DRIVE_ROOT)}">Quelle durchsuchen</a> — klick dich hinein, dann auswählen.</p>`);
  }

  private loginCard(workspaceId: string, p: SetupProgress): string {
    const unlocked = p.facts.folderSelected;
    const open = [...this.sessions.entries()].find(([key]) => key.startsWith(`${workspaceId}:`));
    if (!unlocked) return this.card(3, "Kanal einloggen", false, false, `<div class=gate>Zuerst einen Ordner wählen.</div>`);
    if (p.facts.sessionDiscovered) {
      const d = this.discoveries.get(workspaceId)!;
      return this.card(3, "Kanal einloggen", true, false, `<div class=proof>Sitzung für <code>${escapeHtml(d.platform)}</code> gelesen.</div>`);
    }
    const body = open
      ? `<p>Browser offen für <code>${escapeHtml(open[1].platform)}</code>. Logge dich dort ein — Passwort und 2FA tippst du selbst — und lies dann die Sitzung aus.</p>
         <form method=post action="/workspaces/${workspaceId}/discover"><input type=hidden name=csrf value=${this.csrf}><button>Sitzung auslesen</button></form>
         <form method=post action="/workspaces/${workspaceId}/browser/close"><input type=hidden name=csrf value=${this.csrf}><button>Browser schließen</button></form>`
      : `<form method=post action="/workspaces/${workspaceId}/browser/open"><input type=hidden name=csrf value=${this.csrf}>
         <select name=platform><option value=instagram>Instagram</option><option value=tiktok>TikTok</option><option value=youtube>YouTube</option></select>
         <input name=slot value=primary size=10><button>Login-Browser öffnen</button></form>
         <small>Der Slot trennt mehrere Logins derselben Plattform in einem Workspace.</small>`;
    return this.card(3, "Kanal einloggen", false, p.currentStep === "LOGIN", body);
  }

  private channelCard(workspaceId: string, p: SetupProgress): string {
    if (!p.facts.sessionDiscovered) {
      return this.card(4, "Kanal bestätigen", p.facts.registeredAccounts > 0, false,
        p.facts.registeredAccounts > 0
          ? `<div class=proof>${p.facts.registeredAccounts} Kanal/Kanäle registriert.</div>`
          : `<div class=gate>Zuerst einloggen und die Sitzung auslesen.</div>`);
    }
    const d = this.discoveries.get(workspaceId)!;
    if (d.result.state !== "HEALTHY") {
      return this.card(4, "Kanal bestätigen", false, true,
        `<div class=gate>Sitzung meldet <code>${escapeHtml(d.result.state)}</code>${d.result.note?`: ${escapeHtml(d.result.note)}`:""}. Kein Kanal auswählbar — hier wird nichts geraten.</div>`);
    }
    const options = d.result.channels.map(c =>
      `<label style="display:block;padding:6px 0"><input type=radio name=channelKey value="${escapeHtml(c.channelKey)}" required> <strong>${escapeHtml(c.displayName)}</strong> — <code>${escapeHtml(c.handle)}</code>${c.detail?` · ${escapeHtml(c.detail)}`:""}</label>`).join("");
    return this.card(4, "Kanal bestätigen", false, true,
      `<div class=proof>Aus der Sitzung gelesen, nicht getippt: ${d.result.channels.length} Kanal/Kanäle auf <code>${escapeHtml(d.platform)}</code>.</div>
       <form method=post action="/workspaces/${workspaceId}/channel"><input type=hidden name=csrf value=${this.csrf}>${options}<button>Kanal übernehmen</button></form>
       <small>Der Browser wird geschlossen und die Sitzung in das Profil dieses Kanals kopiert.</small>`);
  }

  /** Everything registered in this workspace, and which folder feeds it. */
  private channels(workspaceId: string) {
    const store = new SqliteControlPlaneStore(this.layout(workspaceId).databasePath);
    try {
      const identities = store.listBrowserIdentities();
      return store.listSocialAccounts().map((a) => {
        const binding = store.getChannelSourceBindingForAccount(a.account.accountId);
        const identity = identities.find((i) => i.identity.accountId === a.account.accountId);
        const shared = binding
          ? store.listChannelSourceBindingsForFolder(binding.binding.folderId)
              .filter((b) => b.binding.accountId !== a.account.accountId)
              .map((b) => b.binding.accountId)
          : [];
        return {
          accountId: a.account.accountId,
          platform: a.account.platform,
          handle: a.account.expectedHandle,
          profileKey: identity?.identity.profileKey ?? "fehlt",
          folderPath: binding?.binding.folderPath ?? null,
          folderId: binding?.binding.folderId ?? null,
          substructure: binding?.binding.interpretSubstructure ?? false,
          sharesFolderWith: shared
        };
      });
    } finally { store.close(); }
  }

  private linkCard(workspaceId: string, p: SetupProgress): string {
    const all = this.channels(workspaceId);
    const unbound = all.filter((c) => !c.folderPath);
    const selected = this.selections.get(workspaceId);

    let form = "";
    if (!selected) {
      form = `<div class=gate>Kein Ordner ausgewählt — geh zurück zu Schritt 2.</div>`;
    } else if (unbound.length === 0) {
      form = `<p>Alle registrierten Kanäle sind verknüpft.</p>`;
    } else {
      const alsoFed = all.filter((c) => c.folderId === selected.folderId);
      const opts = unbound.map((u) => `<option value="${escapeHtml(u.accountId)}">${escapeHtml(u.platform)} · @${escapeHtml(u.handle)}</option>`).join("");
      form = `<form method=post action="/workspaces/${workspaceId}/bind"><input type=hidden name=csrf value=${this.csrf}>
        <p>Ordner: <strong>${escapeHtml(selected.folderPath)}</strong></p>
        ${alsoFed.length ? `<div class=proof>Dieser Ordner speist bereits ${alsoFed.map((c) => `<code>${escapeHtml(c.accountId)}</code>`).join(", ")}. Ein weiterer Kanal daran ist Cross-Posting: dasselbe Video geht auf beide, ohne es zweimal abzulegen.</div>` : ""}
        <select name=accountId>${opts}</select>
        <label><input type=checkbox name=interpretSubstructure value=on> <code>creator/woche/tag</code> auswerten</label>
        <button>Verknüpfung speichern</button></form>`;
    }
    return this.card(5, "Ordner ↔ Kanal", all.some((c) => c.folderPath), p.currentStep === "LINK", form);
  }

  /** The overview the operator actually lives in once setup has run at least once. */
  private channelsCard(workspaceId: string): string {
    const all = this.channels(workspaceId);
    if (all.length === 0) return "";
    const rows = all.map((c) => `<tr>
      <td>${escapeHtml(c.platform)}<br><small><code>${escapeHtml(c.accountId)}</code></small></td>
      <td>@${escapeHtml(c.handle)}</td>
      <td><code>${escapeHtml(c.profileKey)}</code></td>
      <td>${c.folderPath ? escapeHtml(c.folderPath) : "<span class=warn>nicht verknüpft</span>"}${c.substructure ? "<br><small>mit Unterstruktur</small>" : ""}</td>
      <td>${c.sharesFolderWith.length ? c.sharesFolderWith.map((x) => `<code>${escapeHtml(x)}</code>`).join("<br>") : "—"}</td>
    </tr>`).join("");
    return `<div class=card><h2>Kanäle in diesem Workspace</h2>
      <table><tr><th>Plattform</th><th>Konto</th><th>Browserprofil</th><th>Ordner</th><th>Teilt Ordner mit</th></tr>${rows}</table>
      <p>Jeder Kanal beobachtet genau <em>einen</em> Ordner — eine ankommende Datei hat damit nie zwei mögliche Ziele. Ein Ordner darf mehrere Kanäle speisen; das ist der Cross-Posting-Fall.</p>
      <form method=post action="/workspaces/${workspaceId}/channels/add"><input type=hidden name=csrf value=${this.csrf}>
        <button>Weiteren Kanal hinzufügen</button></form>
      <small>Setzt Schritt 2 bis 4 für einen weiteren Durchlauf zurück. Willst du denselben Ordner für einen zweiten Kanal, wähl ihn in Schritt 2 einfach wieder aus.</small></div>`;
  }

  private testCard(workspaceId: string, p: SetupProgress): string {
    const tests = this.readTests(workspaceId);
    const rows = SELF_SERVICE_TEST_CATALOG.map(t => {
      const r = tests.find(x => x.testId === t.testId);
      const blocked = t.requires !== "NONE" && p.currentStep !== "READY";
      const action = blocked
        ? `<span class=bad>gesperrt</span>`
        : `<form method=post action="/workspaces/${workspaceId}/tests/${encodeURIComponent(t.testId)}"><input type=hidden name=csrf value=${this.csrf}><button>Starten</button></form>`;
      return `<tr><td>${escapeHtml(t.label)}<br><small>${escapeHtml(t.description)}</small></td><td>${escapeHtml(t.risk)}</td><td class=${r?.passed?"ok":r?"bad":"warn"}>${r?r.passed?"BESTANDEN":"FEHLGESCHLAGEN":"NICHT GELAUFEN"}</td><td>${action}${r?`<details><summary>Details</summary><pre>${escapeHtml(r.summary)}</pre></details>`:""}</td></tr>`;
    }).join("");
    return this.card(6, "Test Lab", false, p.currentStep === "READY",
      `<p>Keine freie Shell — fest verdrahtete Kommandos, jedes mit erzwungenem <code>ALLOW_FINAL_PUBLISH=false</code>. Die drei lokalen Tests hängen an keinem Setup-Schritt: ein frischer Host muss beweisen können, dass er gesund ist.</p>
       <table><tr><th>Test</th><th>Risiko</th><th>Status</th><th>Aktion</th></tr>${rows}</table>`);
  }

  private workspacePage(workspaceId:string):string {
    const workspace=this.registry.get(workspaceId);
    if(!workspace) return this.shell("Nicht gefunden","<h1>Workspace nicht gefunden</h1>");
    const p = this.progress(workspaceId);
    return this.shell(workspace.displayName,
      `<p><a href=/>&larr; Workspaces</a></p><h1>${escapeHtml(workspace.displayName)}</h1>
       <p><code>${escapeHtml(workspace.workspaceId)}</code> · ${escapeHtml(workspace.status)} · ${escapeHtml(workspace.timezone)} · Schritt <strong>${escapeHtml(p.currentStep)}</strong></p>
       ${this.channelsCard(workspaceId)}${this.driveCard(workspaceId,p)}${this.folderCard(workspaceId,p)}${this.loginCard(workspaceId,p)}${this.channelCard(workspaceId,p)}${this.linkCard(workspaceId,p)}${this.testCard(workspaceId,p)}
       <div class=card><h2>Workspace-Isolation</h2><pre>${escapeHtml(JSON.stringify(this.layout(workspaceId),null,2))}</pre></div>`);
  }

  private async browsePage(workspaceId: string, folderId: string): Promise<string> {
    assertPrerequisite(this.progress(workspaceId), "DRIVE_CONNECTED");
    if (!this.options.folderBrowser) throw new Error("No source folder browser is configured");
    const listing: SourceFolderListing = await this.options.folderBrowser.listFolder(folderId);
    const crumbs = listing.path.map((c,i) =>
      i === listing.path.length-1 ? `<strong>${escapeHtml(c.name)}</strong>`
        : `<a href="/workspaces/${workspaceId}/browse?folderId=${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a>`).join(" / ");
    const rows = listing.entries.map(e => e.kind === "folder"
      ? `<tr><td>📁 <a href="/workspaces/${workspaceId}/browse?folderId=${encodeURIComponent(e.id)}">${escapeHtml(e.name)}</a></td><td>Ordner</td></tr>`
      : `<tr><td>📄 ${escapeHtml(e.name)}</td><td>${escapeHtml(e.mimeType ?? "Datei")}</td></tr>`).join("");
    const pickable = listing.folderId !== DRIVE_ROOT;
    return this.shell(`Ordner: ${listing.folderName}`,
      `<p><a href="/workspaces/${workspaceId}">&larr; Setup</a></p><h1>${escapeHtml(listing.folderName)}</h1><p>${crumbs}</p>
       <table><tr><th>Name</th><th>Typ</th></tr>${rows||"<tr><td colspan=2>Dieser Ordner ist leer.</td></tr>"}</table>
       ${listing.truncated?"<p class=warn>Liste gekürzt — dieser Ordner hat sehr viele Einträge.</p>":""}
       ${pickable?`<form method=post action="/workspaces/${workspaceId}/folder"><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=folderId value="${escapeHtml(listing.folderId)}"><input type=hidden name=folderPath value="${escapeHtml(listing.path.map(c=>c.name).join(" / "))}"><button>Diesen Ordner wählen</button></form>`:"<p>Wähle einen Unterordner; die Ablage-Wurzel selbst ist keine Quelle.</p>"}`);
  }

  // ---------------- routing ----------------

  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!this.authorized(req)){this.deny(res);return;}
    const method=req.method??"GET";
    const url=new URL(req.url??"/","http://127.0.0.1");
    const path=url.pathname;
    try {
      if(method==="GET"&&path==="/"){res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(this.home());return;}

      const wm=path.match(/^\/workspaces\/([^/]+)$/);
      if(method==="GET"&&wm){res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(this.workspacePage(decodeURIComponent(wm[1]!)));return;}

      const browse=path.match(/^\/workspaces\/([^/]+)\/browse$/);
      if(method==="GET"&&browse){const id=decodeURIComponent(browse[1]!);const html=await this.browsePage(id,url.searchParams.get("folderId")??DRIVE_ROOT);res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;}

      const cb=path.match(/^\/workspaces\/([^/]+)\/drive\/callback$/);
      if(method==="GET"&&cb){await this.driveCallback(decodeURIComponent(cb[1]!),url,res);return;}

      if(method!=="POST"){res.statusCode=404;res.end("Not found");return;}
      const form=await readForm(req);
      if(form.get("csrf")!==this.csrf){res.statusCode=403;res.end("Invalid CSRF token");return;}

      if(path==="/workspaces"){
        const ws=new WorkspaceService(this.registry,this.options.runtimeRoot).create({workspaceId:form.get("workspaceId")??"",displayName:form.get("displayName")??"",timezone:form.get("timezone")??"Europe/Vienna",now:new Date().toISOString()});
        this.redirect(res,`/workspaces/${ws.workspace.workspaceId}`);return;
      }

      const m=(re:RegExp)=>path.match(re);
      let hit;

      if((hit=m(/^\/workspaces\/([^/]+)\/drive\/connect$/))){ await this.driveConnect(decodeURIComponent(hit[1]!),res); return; }

      if((hit=m(/^\/workspaces\/([^/]+)\/drive\/disconnect$/))){
        const id=decodeURIComponent(hit[1]!);
        writeFileSync(resolve(this.layout(id).configDir,"drive-credential.json"),"{}",{encoding:"utf8",mode:0o600});
        this.selections.delete(id); this.redirect(res,`/workspaces/${id}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/folder$/))){
        const id=decodeURIComponent(hit[1]!);
        assertPrerequisite(this.progress(id),"DRIVE_CONNECTED");
        const folderId=(form.get("folderId")??"").trim();
        const folderPath=(form.get("folderPath")??"").trim();
        if(!folderId) throw new Error("Kein Ordner übergeben");
        const preview = this.options.folderBrowser ? await this.options.folderBrowser.previewFolder(folderId) : undefined;
        this.selections.set(id,{folderId,folderPath,selectedAt:new Date().toISOString(),...(preview?{preview}:{})});
        this.redirect(res,`/workspaces/${id}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/browser\/open$/))){
        const id=decodeURIComponent(hit[1]!);
        assertPrerequisite(this.progress(id),"FOLDER_SELECTED");
        await this.openLoginBrowser(id, platform(form.get("platform")??""), (form.get("slot")??"primary").trim() || "primary");
        this.redirect(res,`/workspaces/${id}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/browser\/close$/))){
        await this.closeSessions(decodeURIComponent(hit[1]!)); this.redirect(res,`/workspaces/${decodeURIComponent(hit[1]!)}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/discover$/))){
        const id=decodeURIComponent(hit[1]!);
        await this.discover(id); this.redirect(res,`/workspaces/${id}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/channel$/))){
        const id=decodeURIComponent(hit[1]!);
        assertPrerequisite(this.progress(id),"SESSION_DISCOVERED");
        await this.confirmChannel(id, (form.get("channelKey")??"").trim());
        this.redirect(res,`/workspaces/${id}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/bind$/))){
        const id=decodeURIComponent(hit[1]!);
        const p=this.progress(id);
        assertPrerequisite(p,"CHANNEL_REGISTERED");
        assertPrerequisite(p,"FOLDER_SELECTED");
        this.bind(id, (form.get("accountId")??"").trim(), form.get("interpretSubstructure")==="on");
        this.redirect(res,`/workspaces/${id}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/channels\/add$/))){
        const id=decodeURIComponent(hit[1]!);
        // Only the transient pass is reset. Registered channels and their bindings are durable
        // and must survive starting another one.
        this.selections.delete(id); this.discoveries.delete(id); await this.closeSessions(id);
        this.redirect(res,`/workspaces/${id}`); return;
      }

      if((hit=m(/^\/workspaces\/([^/]+)\/tests\/([^/]+)$/))){
        const id=decodeURIComponent(hit[1]!); const testId=decodeURIComponent(hit[2]!);
        const result=await new TestLabService(this.options.testRunner,this.options.repoRoot).run(testId,this.progress(id));
        this.recordTest(id,{testId,...result,checkedAt:new Date().toISOString()});
        this.redirect(res,`/workspaces/${id}`); return;
      }

      res.statusCode=404;res.end("Not found");
    } catch(error) {
      res.statusCode=409;res.setHeader("Content-Type","text/plain; charset=utf-8");
      res.end(error instanceof Error?error.message:String(error));
    }
  }

  // ---------------- actions ----------------

  private pendingAuth = new Map<string, { state: string; codeVerifier: string }>();

  private async driveConnect(workspaceId: string, res: ServerResponse): Promise<void> {
    const oauth = this.options.driveOAuth;
    if (!oauth) throw new Error("Kein OAuth-Client hinterlegt: GOOGLE_OAUTH_CLIENT_ID und GOOGLE_OAUTH_CLIENT_SECRET fehlen.");
    const pending = oauth.begin(workspaceId);
    this.pendingAuth.set(workspaceId, { state: pending.state, codeVerifier: pending.codeVerifier });
    this.redirect(res, pending.authorizationUrl);
  }

  private async driveCallback(workspaceId: string, url: URL, res: ServerResponse): Promise<void> {
    const oauth = this.options.driveOAuth;
    const pending = this.pendingAuth.get(workspaceId);
    if (!oauth || !pending) throw new Error("Kein laufender Google-Login für diesen Workspace");
    const state = url.searchParams.get("state");
    // A mismatched state means the callback did not come from the flow this process started.
    if (!state || state !== pending.state) throw new Error("State stimmt nicht überein; Login abgebrochen");
    const code = url.searchParams.get("code");
    if (!code) throw new Error(`Google meldete: ${url.searchParams.get("error") ?? "kein Code"}`);
    const credential = await oauth.complete(workspaceId, code, pending.codeVerifier);
    this.pendingAuth.delete(workspaceId);
    this.credentials(workspaceId).write(credential);
    this.redirect(res, `/workspaces/${workspaceId}`);
  }

  private async openLoginBrowser(workspaceId: string, platformName: Platform, slot: string): Promise<void> {
    if (this.sessions.has(`${workspaceId}:login`)) throw new Error("Es ist bereits ein Login-Browser offen");
    const layout = this.layout(workspaceId);
    const profileKey = loginProfileKey(platformName, slot);
    const store = new SqliteControlPlaneStore(layout.databasePath);
    const resolver = new BrowserProfileDirectoryResolver(layout.profilesDir);
    const locks = new DurableBrowserProfileLockAdapter(store, new FileBrowserProfileLockAdapter(resolver));
    const runtime = new ChromiumCdpRuntimeAdapter({ profilesRoot: layout.profilesDir, executablePath: this.options.chromiumExecutablePath });
    // The login profile belongs to no identity yet, so a provisional one carries it.
    const provisional = { identityId: `setup:${profileKey}`, accountId: `setup:${profileKey}`, platform: platformName, profileKey, expectedHandle: "unknown", enabled: true };
    const session = await new BrowserBootstrapService(store, runtime, locks).openProvisional({
      identity: provisional, ownerId: this.actor().id, bootstrapUrl: bootstrapUrl(platformName), now: new Date().toISOString(), headless: this.options.headlessLogin ?? false
    });
    this.sessions.set(`${workspaceId}:login`, { session, store, profileKey, platform: platformName });
  }

  private async discover(workspaceId: string): Promise<void> {
    const retained = this.sessions.get(`${workspaceId}:login`);
    if (!retained) throw new Error("Kein Login-Browser offen");
    if (!this.options.channelDiscovery) {
      throw new Error("Kanal-Rücklesung ist noch nicht kalibriert. Ohne kalibrierte Selektoren wird hier nichts geraten — und getippt wird auch nichts.");
    }
    const result = await this.options.channelDiscovery.discover(retained.session.page, retained.platform, new Date().toISOString());
    this.discoveries.set(workspaceId, { platform: retained.platform, result });
  }

  private async confirmChannel(workspaceId: string, channelKey: string): Promise<void> {
    const pending = this.discoveries.get(workspaceId);
    if (!pending) throw new Error("Keine ausgelesene Sitzung");

    // Validate before touching anything. A rejected key must leave no trace: closing the browser
    // or creating a directory for a channel that was never discovered would turn a refused request
    // into a real side effect, and would strand the operator's session for the legitimate retry.
    const chosen = selectDiscoveredChannel(pending.result, channelKey);
    const targetProfile = deriveProfileKey(pending.platform, chosen.channelKey);

    const retained = this.sessions.get(`${workspaceId}:login`);
    const loginKey = retained?.profileKey;
    // Chromium must be gone before the profile is copied, or the copy restores no session.
    await this.closeSessions(workspaceId);

    const layout = this.layout(workspaceId);
    const store = new SqliteControlPlaneStore(layout.databasePath);
    try {
      if (loginKey) seedChannelProfile({ profilesRoot: layout.profilesDir, fromProfileKey: loginKey, toProfileKey: targetProfile });
      new SetupChannelRegistrationService(store).registerFromDiscovery({
        result: pending.result, channelKey: chosen.channelKey,
        checkId: `check:${workspaceId}:${chosen.channelKey}:${Date.now()}`,
        now: new Date().toISOString(), actor: this.actor(),
        ...(loginKey ? { profileKey: targetProfile } : {})
      });
    } finally { store.close(); }
    this.discoveries.delete(workspaceId);
  }

  private bind(workspaceId: string, accountId: string, interpretSubstructure: boolean): void {
    const selected = this.selections.get(workspaceId);
    if (!selected) throw new Error("Kein Ordner ausgewählt");
    const store = new SqliteControlPlaneStore(this.layout(workspaceId).databasePath);
    try {
      new SetupChannelRegistrationService(store).bindSource({
        accountId, bindingId: `bind:${accountId}`,
        folderId: selected.folderId, folderPath: selected.folderPath,
        interpretSubstructure, now: new Date().toISOString(), actor: this.actor()
      });
    } finally { store.close(); }
  }

  private async closeSessions(workspaceId: string): Promise<void> {
    for (const [key, retained] of [...this.sessions]) {
      if (!key.startsWith(`${workspaceId}:`)) continue;
      this.sessions.delete(key);
      try { await retained.session.close(); } finally { retained.store.close(); }
    }
  }

  async start():Promise<{host:string;port:number}>{
    if(this.server)throw new Error("Self-service server already started");
    const host=this.options.host??"127.0.0.1";const port=this.options.port??0;
    this.server=createServer((req,res)=>{void this.handle(req,res);});
    await new Promise<void>(resolvePromise=>this.server!.listen(port,host,resolvePromise));
    const a=this.server.address();
    if(!a||typeof a==="string")throw new Error("Self-service server did not expose address");
    return{host,port:a.port};
  }

  async stop():Promise<void>{
    for(const [key,retained] of [...this.sessions]){this.sessions.delete(key);try{await retained.session.close();}finally{retained.store.close();}}
    if(!this.server)return;
    const s=this.server;this.server=undefined;
    await new Promise<void>((resolvePromise,reject)=>s.close(error=>error?reject(error):resolvePromise()));
  }
}
