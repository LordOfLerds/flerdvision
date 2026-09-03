/**
 * ONE context object, ONE renderer: every message the operator ever receives on Telegram is
 * built here. Before this module each builder formatted itself, which is why spec keys
 * ("tiktok-lucae71"), internal ids ("intent:…"), evidence file paths, ISO timestamps and raw
 * state words leaked into the chat while the one thing Luca actually recognises -- the video --
 * was missing. The renderer owns the vocabulary; callers only collect facts.
 */

export type OperatorMessageKind =
  | "POST_VERIFIED"
  | "POST_UNCERTAIN"
  | "WAVE"
  | "PLAN"
  | "ATTENTION"
  | "INCIDENT"
  | "DAY_END"
  | "WEEK_REPORT"
  | "STATUS"
  | "DOCTOR"
  | "SWITCH"
  | "RELOGIN";

/** "⏭️ Als Nächstes: 12:00 · Reels, Clips" -- the operator's next commitment, not a state dump. */
export interface OperatorNextSlot {
  timeLocal: string;
  channelNames: readonly string[];
}

export interface OperatorMessageSection {
  heading?: string;
  lines: readonly string[];
}

export interface OperatorMessageContext {
  /** Human day label, e.g. "Tagesplan Mo 2. Sep" -- never an ISO business date. */
  planLabel?: string;
  /** Local wall-clock slot, e.g. "09:30". */
  slotLocal?: string;
  channelName?: string;
  platformLabel?: string;
  handle?: string;
  /** Caption wording from the Drive file name -- what Luca calls this video. */
  videoLabel?: string;
  /** Hashtag part of the Drive file name, already normalised to "#a #b". */
  hashtags?: string;
  /** Caption exactly as posted. */
  caption?: string;
  /** Title exactly as posted (YouTube). */
  title?: string;
  /** "Reel", "Short", "Video" -- never the internal format token. */
  formatLabel?: string;
  permalink?: string;
  /** Local evidence file; transport metadata only, never rendered into text. */
  screenshotPath?: string;
  /** Local video file; transport metadata only, never rendered into text. */
  videoPath?: string;
  /** German plain-language sentence: what happened. */
  reason?: string;
  /** German plain-language sentence: what the operator does next. */
  nextStep?: string;
  /** noVNC/remote-screen URL for a manual re-login. */
  remoteScreenUrl?: string;
  /** Raw run id -- used ONLY inside a literal operator command. */
  runId?: string;
  /** Raw channel key -- used ONLY inside a literal operator command. */
  channelKey?: string;
  /** German status word already chosen by the caller ("unsicher, eingefroren"). */
  statusLabel?: string;
  badge?: string;
  ok?: boolean;
  headline?: string;
  lines?: readonly string[];
  sections?: readonly OperatorMessageSection[];
  entries?: readonly OperatorMessageContext[];
  nextSlot?: OperatorNextSlot;
}

export interface OperatorMessage {
  subject: string;
  body: string;
}

export const OPERATOR_MESSAGE_MAX_CHARS = 4000;

/** German words for every persisted state the operator could otherwise see raw. */
const GERMAN_STATE: Readonly<Record<string, string>> = {
  PLANNED: "geplant", READY: "bereit", SCHEDULED: "geplant", PREPARING: "wird vorbereitet",
  PUBLISHING: "wird veröffentlicht", VERIFYING: "wird geprüft", RETRY_WAIT: "wartet",
  PUBLISH_UNCERTAIN: "unsicher, eingefroren", VERIFIED: "verifiziert", BLOCKED: "blockiert",
  WAIVED: "übersprungen", OBSERVED: "beobachtet", STABILIZING: "stabilisiert", COMPLETE: "fertig",
  HEALTHY: "angemeldet", AUTH_REQUIRED: "Login nötig", CHALLENGE: "Sicherheitsabfrage",
  IDENTITY_MISMATCH: "falsches Konto", UNREACHABLE: "nicht erreichbar", UNKNOWN: "unbekannt",
  MISSING: "nicht eingerichtet", PASS: "in Ordnung", WARN: "Warnung", FAIL: "Fehler",
  OPEN: "offen", ACKNOWLEDGED: "gesehen", RESOLVED: "erledigt", CALIBRATED: "kalibriert",
  UNCERTAIN: "unsicher", CRITICAL: "kritisch", ERROR: "Fehler", WARNING: "Warnung", INFO: "Hinweis"
};

/** German meaning of every incident kind: what it is, said in one noun phrase. */
const GERMAN_INCIDENT: Readonly<Record<string, { meaning: string; effect: string; nextStep: string }>> = {
  AUTH_REQUIRED: { meaning: "Der Kanal ist abgemeldet", effect: "Für diesen Kanal wird nichts veröffentlicht.", nextStep: "Im Remote-Browser neu einloggen, danach /fortsetzen." },
  CHALLENGE: { meaning: "Die Plattform verlangt eine Sicherheitsabfrage", effect: "Für diesen Kanal wird nichts veröffentlicht.", nextStep: "Abfrage im Remote-Browser selbst lösen, danach /fortsetzen." },
  IDENTITY_MISMATCH: { meaning: "Im Browser ist das falsche Konto angemeldet", effect: "Posten ist gesperrt, damit nichts im falschen Konto landet.", nextStep: "Richtiges Konto einloggen und den Kanal prüfen." },
  MISSED_WINDOW: { meaning: "Ein Slot ist verstrichen, ohne dass gepostet wurde", effect: "Der Post von heute fällt aus.", nextStep: "Nichts tun — der nächste Slot läuft normal weiter." },
  PUBLISH_UNCERTAIN: { meaning: "Nach dem Klick ist unklar, ob der Post online ist", effect: "Dieser Post ist eingefroren — kein automatischer Neuversuch.", nextStep: "Im Terminal prüfen, bevor irgendetwas wiederholt wird." },
  SOURCE_BLOCKED: { meaning: "Eine Datei aus Drive lässt sich nicht verwenden", effect: "Für diese Datei entsteht kein Post.", nextStep: "Datei in Drive ersetzen — der Slot bleibt frei." },
  PLATFORM_CAPABILITY_MISSING: { meaning: "Die Plattform-Oberfläche kann den nötigen Schritt nicht", effect: "Diese Route postet nicht.", nextStep: "Route neu kalibrieren, bevor sie wieder läuft." },
  BROWSER_UNREACHABLE: { meaning: "Der Browser ist nicht erreichbar", effect: "Es wird nichts veröffentlicht.", nextStep: "Den Rechner bzw. den Dienst prüfen." },
  UI_UNKNOWN: { meaning: "Die Oberfläche der Plattform sieht anders aus als kalibriert", effect: "Der Vorgang wurde abgebrochen, bevor etwas passiert ist.", nextStep: "Route neu kalibrieren." },
  UPLOAD_REJECTED: { meaning: "Die Plattform hat den Upload abgelehnt", effect: "Dieser Post ist nicht online.", nextStep: "Datei prüfen und in Drive ersetzen." },
  POLICY_WARNING: { meaning: "Die Plattform meldet einen Richtlinien-Hinweis", effect: "Posten ist für diesen Kanal gesperrt.", nextStep: "Hinweis im Konto selbst ansehen — nichts automatisch wiederholen." },
  COPYRIGHT_WARNING: { meaning: "Die Plattform meldet ein Urheberrechts-Problem", effect: "Posten ist für diesen Kanal gesperrt.", nextStep: "Hinweis im Konto selbst ansehen — nichts automatisch wiederholen." },
  ACCOUNT_WARNING: { meaning: "Die Plattform warnt das Konto", effect: "Posten ist für diesen Kanal gesperrt.", nextStep: "Kontostatus selbst prüfen, bevor wieder gepostet wird." },
  SYSTEM_ERROR: { meaning: "Ein interner Fehler ist aufgetreten", effect: "Der betroffene Schritt wurde abgebrochen.", nextStep: "Im Terminal /doctor ausführen." }
};

/** German meaning + action for every attention kind the read model produces. */
const GERMAN_ATTENTION: Readonly<Record<string, { meaning: string; action: string }>> = {
  ROUTE_BLOCKED: { meaning: "Eine Route kann nicht posten", action: "Route im Terminal prüfen — der Slot bleibt sonst leer." },
  ROUTE_NEEDS_TEST: { meaning: "Eine Route ist noch nicht freigegeben", action: "Qualifikationslauf im Terminal starten." },
  BACKLOG: { meaning: "Ein Video wartet länger als geplant", action: "Nichts tun — es rutscht in den nächsten freien Slot." },
  ACCOUNT_SLOT_CONFLICT: { meaning: "Zwei Posts zielen auf denselben Kanal zur selben Zeit", action: "Einen der beiden Slots verschieben." },
  NO_CONTENT: { meaning: "Für einen Slot fehlt ein Video", action: "Video in Drive ablegen — der Slot bleibt sonst leer." },
  NO_READY_CONTENT: { meaning: "Für einen Slot ist noch kein Video fertig", action: "Video in Drive ablegen — der Slot bleibt sonst leer." },
  SESSION_UNHEALTHY: { meaning: "Ein Kanal ist abgemeldet", action: "Im Remote-Browser neu einloggen." },
  AUTH_REQUIRED: { meaning: "Ein Kanal ist abgemeldet", action: "Im Remote-Browser neu einloggen." },
  CHALLENGE: { meaning: "Ein Kanal verlangt eine Sicherheitsabfrage", action: "Abfrage im Remote-Browser selbst lösen." }
};

/** Attention/incident kinds whose fix is a login, not a config change. */
const SESSION_KINDS = new Set(["SESSION_UNHEALTHY", "AUTH_REQUIRED", "CHALLENGE", "IDENTITY_MISMATCH"]);

/** Reason codes the pipeline actually writes. Unknown codes are dropped, never invented. */
const GERMAN_BLOCK_REASON: Readonly<Record<string, string>> = {
  source_media_mutated: "Die Datei in Drive wurde nach dem Einlesen verändert",
  media_probe_blocked: "Das Video lässt sich nicht lesen",
  media_unreadable: "Das Video lässt sich nicht lesen",
  blocked_by_interpreter: "Die Datei passt nicht in diese Drive-Spur",
  missing_media_fingerprint: "Die Datei lässt sich nicht eindeutig identifizieren",
  new_only_activation_baseline_missing: "Die Drive-Spur ist noch nicht aktiviert",
  source_missing_or_disabled: "Die Drive-Quelle ist aus",
  activation_cursor_missing: "Die Drive-Spur ist noch nicht aktiviert"
};

/** Route blockers as the doctor reports them. */
const GERMAN_BLOCKER: Readonly<Record<string, string>> = {
  route_disabled: "Route ist aus",
  account_missing_or_disabled: "Konto fehlt oder ist aus",
  identity_missing_or_disabled: "Browser-Profil fehlt oder ist aus",
  session_not_healthy: "Login fehlt",
  session_probe_not_calibrated: "Login-Prüfung nicht kalibriert",
  no_ready_asset: "kein fertiges Video",
  surface_not_calibrated: "Oberfläche nicht kalibriert",
  route_readiness_missing: "Qualifikation fehlt",
  route_release_stale: "Qualifikation ist veraltet",
  source_not_proven: "Quelle nicht nachgewiesen",
  session_not_proven: "Login nicht nachgewiesen",
  identity_not_proven: "Konto nicht nachgewiesen",
  prepare_only_lt_3: "zu wenige Trockenläufe",
  verification_surface_not_proven: "Prüfung nicht nachgewiesen",
  surface_evidence_stale: "Nachweis ist veraltet",
  private_e2e_missing: "privater Testpost fehlt",
  private_e2e_cleanup_missing_or_stale: "Aufräumen nach dem Testpost fehlt"
};

/** Doctor check keys as German nouns. */
const GERMAN_DOCTOR_CHECK: Readonly<Record<string, string>> = {
  node: "Node-Version",
  timezone: "Zeitzone",
  workspace_runtime: "Arbeitsverzeichnis",
  database: "Datenbank",
  distribution_config: "Konfiguration",
  release_sha: "Release",
  drive_auth: "Google-Drive-Zugang",
  local_source: "Lokaler Quellordner"
};

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"] as const;
const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;

/** "2026-09-02" -> "Mi 2. Sep". Used for every day label the operator sees. */
export function germanDayLabel(businessDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate.trim());
  if (!match) return businessDate;
  const date = new Date(`${businessDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return businessDate;
  return `${WEEKDAYS[date.getUTCDay()]} ${Number(match[3])}. ${MONTHS[Number(match[2]) - 1]}`;
}

const PLATFORM_LABEL: Readonly<Record<string, string>> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
const FORMAT_LABEL: Readonly<Record<string, string>> = {
  reel: "Reel", trial_reel: "Test-Reel", tiktok: "TikTok-Video", short: "Short", story: "Story", unknown: "Video"
};

/** "instagram" -> "Instagram". The operator never sees the platform token. */
export function germanPlatformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

/** "trial_reel" -> "Test-Reel". The operator never sees the format token. */
export function germanFormatLabel(format: string): string {
  return FORMAT_LABEL[format] ?? "Video";
}

export function germanState(state: string): string {
  return GERMAN_STATE[state] ?? state.toLocaleLowerCase("de-AT").replace(/_/g, " ");
}

export function germanBlockReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return GERMAN_BLOCK_REASON[reason.trim()];
}

export function germanBlocker(blocker: string): string {
  return GERMAN_BLOCKER[blocker] ?? blocker.replace(/_/g, " ");
}

export function germanDoctorCheck(key: string): string {
  return GERMAN_DOCTOR_CHECK[key] ?? key.replace(/_/g, " ");
}

export function germanIncident(kind: string): { meaning: string; effect: string; nextStep: string } {
  return GERMAN_INCIDENT[kind] ?? GERMAN_INCIDENT.SYSTEM_ERROR!;
}

export function germanAttention(kind: string): { meaning: string; action: string } {
  return GERMAN_ATTENTION[kind] ?? { meaning: "Etwas braucht deine Aufmerksamkeit", action: "Im Terminal /doctor ausführen." };
}

export function isSessionKind(kind: string): boolean {
  return SESSION_KINDS.has(kind);
}

const ID_PREFIX = /\b(?:account|intent|incident|asset|route|content|attention|notification|browser|identity|lane|observation|publication|attempt|check|profile|workspace|delivery|contract|copy|creator)\s*:\s*[A-Za-z0-9_.@:\/-]+/g;
const SPEC_KEY = /\b(?:instagram|tiktok|youtube)-([A-Za-z0-9][A-Za-z0-9_.]*)\b/g;
const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const POSIX_PATH = /(?<![\w:/.])(?:~)?\/[\w.@%+-]+(?:\/[\w.@%+-]+)+/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s"']+/g;
const RAW_STATE = new RegExp(`\\b(?:${Object.keys(GERMAN_STATE).sort((a, b) => b.length - a.length).join("|")})\\b`, "g");

/**
 * Last line of defence, not the design: every rendered fragment passes through here so a caller
 * that forgets what it is holding still cannot leak an id, a spec key, an evidence path, an ISO
 * timestamp or a raw state word into Luca's chat. Literal operator commands are assembled by the
 * renderer itself and never routed through this function.
 */
export function sanitizeOperatorText(value: string): string {
  return value
    .replace(WINDOWS_PATH, "")
    .replace(ISO_INSTANT, (match) => germanDayLabel(match.slice(0, 10)))
    .replace(ID_PREFIX, "")
    .replace(POSIX_PATH, "")
    .replace(ISO_DATE, (match) => germanDayLabel(match))
    .replace(SPEC_KEY, (_all, handle: string) => handle)
    .replace(RAW_STATE, (match) => germanState(match))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s*[·—]\s*$/gm, "")
    .trimEnd();
}

function safe(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = sanitizeOperatorText(value).trim();
  return cleaned === "" ? undefined : cleaned;
}

function join(parts: readonly (string | undefined)[], separator = " · "): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(separator);
}

function quoted(label: string | undefined): string | undefined {
  const value = safe(label);
  return value === undefined ? undefined : `„${value}“`;
}

/** The operator's own command line; ids inside a literal command are allowed and required. */
function command(text: string): string {
  return text;
}

function channelLabel(context: OperatorMessageContext): string | undefined {
  const name = safe(context.channelName) ?? safe(context.handle);
  const platform = safe(context.platformLabel);
  if (name && platform) return `${name} (${platform})`;
  return name ?? platform;
}

function copyLine(context: OperatorMessageContext): string | undefined {
  const copy = safe(context.caption) ?? safe(context.title);
  return copy === undefined ? undefined : `📝 ${copy}`;
}

function nextSlotLine(next: OperatorNextSlot | undefined): string | undefined {
  if (!next) return undefined;
  const names = next.channelNames.map((name) => safe(name)).filter((name): name is string => Boolean(name));
  const time = safe(next.timeLocal);
  if (!time) return undefined;
  return names.length > 0 ? `⏭️ Als Nächstes: ${time} · ${names.join(", ")}` : `⏭️ Als Nächstes: ${time}`;
}

function sectionLines(context: OperatorMessageContext): string[] {
  const lines: string[] = [];
  for (const section of context.sections ?? []) {
    const rendered = section.lines.map((line) => safe(line)).filter((line): line is string => Boolean(line));
    if (rendered.length === 0) continue;
    lines.push("");
    const heading = safe(section.heading);
    if (heading) lines.push(heading);
    lines.push(...rendered);
  }
  return lines;
}

/** List-shaped kinds keep deliberate blank lines between blocks but never a run of them. */
function block(lines: readonly (string | undefined)[]): string {
  return lines.filter((line): line is string => line !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function ownLines(context: OperatorMessageContext): string[] {
  return (context.lines ?? []).map((line) => safe(line)).filter((line): line is string => Boolean(line));
}

function postHeader(context: OperatorMessageContext): string[] {
  return [
    join([safe(context.planLabel), safe(context.slotLocal) ? `${safe(context.slotLocal)} Uhr` : undefined]),
    join([channelLabel(context), safe(context.formatLabel)]),
    join([quoted(context.videoLabel) ? `🎬 ${quoted(context.videoLabel)}` : undefined, safe(context.hashtags)], " · "),
    copyLine(context) ?? ""
  ].filter((line) => line.trim() !== "");
}

function waveEntryLines(entry: OperatorMessageContext): string[] {
  const verified = entry.ok !== false;
  const head = join([
    `${verified ? "✅" : "🛑"} ${channelLabel(entry) ?? "Kanal"}`,
    safe(entry.formatLabel),
    quoted(entry.videoLabel),
    safe(entry.hashtags),
    verified ? safe(entry.permalink) : undefined
  ]);
  const lines = [head];
  if (!verified) {
    const reason = safe(entry.reason);
    if (reason) lines.push(`   ${reason}`);
    const nextStep = safe(entry.nextStep);
    if (nextStep) lines.push(`   Was jetzt: ${nextStep}`);
  }
  return lines;
}

function planEntryLines(entry: OperatorMessageContext): string[] {
  const head = join([
    `${entry.badge ?? "⬜"} ${safe(entry.slotLocal) ?? ""}`.trim(),
    channelLabel(entry),
    quoted(entry.videoLabel),
    safe(entry.statusLabel)
  ]);
  const lines = [head];
  const copy = copyLine(entry);
  if (copy) lines.push(`     ${copy}`);
  const reason = safe(entry.reason);
  if (reason) lines.push(`     ${reason}`);
  const permalink = safe(entry.permalink);
  if (permalink) lines.push(`     ${permalink}`);
  return lines;
}

function normalize(input: OperatorMessageContext | readonly OperatorMessageContext[]): OperatorMessageContext {
  if (!Array.isArray(input)) return input as OperatorMessageContext;
  const list = input as readonly OperatorMessageContext[];
  const first = list[0] ?? {};
  return { ...first, entries: list };
}

function build(kind: OperatorMessageKind, context: OperatorMessageContext): OperatorMessage {
  const entries = context.entries ?? [];
  switch (kind) {
    case "POST_VERIFIED":
      return {
        subject: join(["✅ Post verifiziert", safe(context.slotLocal), channelLabel(context)]),
        body: block([...postHeader(context), safe(context.permalink), ...ownLines(context), ...sectionLines(context)])
      };
    case "POST_UNCERTAIN": {
      const runId = context.runId?.trim();
      return {
        subject: join(["🛑 Post UNSICHER", safe(context.slotLocal), channelLabel(context)]),
        body: block([
          ...postHeader(context),
          safe(context.reason) ?? "Der Klick ist passiert, die Veröffentlichung ist nicht bestätigt.",
          "Dieser Post ist eingefroren — kein automatischer Neuversuch.",
          "",
          `Was jetzt: ${command(runId ? `npm run flerdvision -- verify --run-id ${runId}` : "npm run flerdvision -- verify")}`
        ])
      };
    }
    case "WAVE": {
      const failures = entries.filter((entry) => entry.ok === false).length;
      return {
        subject: join([
          `${failures === 0 ? "✅" : "🛑"} ${safe(context.slotLocal) ?? ""}-Welle`.trim(),
          `${entries.length} Posts`,
          failures === 0 ? "verifiziert" : `${failures} mit Problemen`
        ]),
        body: block([
          join([safe(context.planLabel), safe(context.slotLocal) ? `${safe(context.slotLocal)} Uhr` : undefined]),
          ...entries.flatMap(waveEntryLines),
          nextSlotLine(context.nextSlot)
        ])
      };
    }
    case "PLAN":
      return {
        subject: `📋 ${safe(context.planLabel) ?? "Tagesplan"}`,
        body: block([
          ...(entries.length === 0 ? ["Keine Posts geplant."] : entries.flatMap(planEntryLines)),
          nextSlotLine(context.nextSlot),
          ...sectionLines(context),
          ...ownLines(context)
        ])
      };
    case "ATTENTION": {
      const key = context.channelKey?.trim();
      const remote = context.remoteScreenUrl?.trim();
      return {
        subject: `${context.badge ?? "⚠️"} ${safe(context.headline) ?? "Aufmerksamkeit nötig"}`,
        body: block([
          safe(context.reason),
          join([channelLabel(context), safe(context.slotLocal) ? `${safe(context.slotLocal)} Uhr` : undefined]),
          quoted(context.videoLabel) ? `🎬 ${quoted(context.videoLabel)}` : undefined,
          safe(context.nextStep) ? `Was jetzt: ${safe(context.nextStep)}` : undefined,
          remote ? `Login im Remote-Browser: ${remote}` : undefined,
          !remote && key ? `Login im Terminal: ${command(`npm run flerdvision -- login --channel ${key}`)}` : undefined
        ])
      };
    }
    case "INCIDENT":
      return {
        subject: `${context.badge ?? "⚠️"} ${safe(context.headline) ?? "Störung"}`,
        body: block([
          safe(context.reason),
          join([channelLabel(context), safe(context.slotLocal) ? `${safe(context.slotLocal)} Uhr` : undefined]),
          quoted(context.videoLabel) ? `🎬 ${quoted(context.videoLabel)}` : undefined,
          safe(context.statusLabel),
          safe(context.nextStep) ? `Was jetzt: ${safe(context.nextStep)}` : undefined
        ])
      };
    case "DAY_END":
    case "WEEK_REPORT":
      return {
        subject: join([
          kind === "DAY_END" ? "🌙 Tagesabschluss" : "📅 Wochenbericht",
          safe(context.planLabel),
          kind === "DAY_END" ? (context.ok ? "✅" : "⚠️") : undefined
        ]),
        body: block([...ownLines(context), ...sectionLines(context), nextSlotLine(context.nextSlot)])
      };
    case "STATUS":
      return {
        subject: join(["📊 Status", safe(context.planLabel)]),
        body: block([...ownLines(context), ...sectionLines(context), nextSlotLine(context.nextSlot)])
      };
    case "DOCTOR":
      return {
        subject: join([`${context.badge ?? "⚠️"} Doctor`, safe(context.statusLabel) ? `Gesamt: ${safe(context.statusLabel)}` : undefined]),
        body: block([...ownLines(context), ...sectionLines(context)])
      };
    case "SWITCH":
      return {
        subject: `${context.badge ?? "ℹ️"} ${safe(context.headline) ?? "Zeitplan"}`,
        body: block([
          safe(context.reason),
          ...ownLines(context),
          safe(context.nextStep) ? `Was jetzt: ${safe(context.nextStep)}` : undefined
        ])
      };
    case "RELOGIN": {
      const key = context.channelKey?.trim();
      const remote = context.remoteScreenUrl?.trim();
      return {
        subject: join([`🛑 ${safe(context.headline) ?? "Re-Login nötig"}`, channelLabel(context)]),
        body: block([
          safe(context.reason),
          "Der Kanal ist pausiert — es wird nichts gepostet.",
          remote
            ? `Login im Remote-Browser: ${remote}`
            : `Login im Terminal: ${command(`npm run flerdvision -- login --channel ${key ?? "<kanal>"}`)}`,
          key ? `Nach dem Login: ${command(`/fortsetzen ${key}`)}` : undefined
        ])
      };
    }
  }
}

/**
 * The one entry point. Pass a single context, or an array when the message is a list (a wave,
 * a checklist): the array's first element supplies the shared header and the whole array becomes
 * `entries`.
 */
export function renderOperatorMessage(
  kind: OperatorMessageKind,
  input: OperatorMessageContext | readonly OperatorMessageContext[]
): OperatorMessage {
  const message = build(kind, normalize(input));
  return { subject: message.subject.slice(0, 200), body: message.body.slice(0, OPERATOR_MESSAGE_MAX_CHARS) };
}

/** One chat message as plain text: subject line, then body, capped for Telegram. */
export function operatorMessageText(message: OperatorMessage): string {
  return [message.subject, message.body].filter((part) => part.trim() !== "").join("\n").slice(0, OPERATOR_MESSAGE_MAX_CHARS);
}
