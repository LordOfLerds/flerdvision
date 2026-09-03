import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { detectPlatformRefusal, PlatformRefusedError } from "./platform-refusal.js";
import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { PostingProfile } from "../../domain/distribution.js";
import type { PublicationIntent } from "../../domain/model.js";
import type { PlatformSurfaceContract, SurfaceContractStep } from "../../domain/platform-surface.js";
import type { PrepareArtifactSinkPort } from "../../domain/platform-ui-ports.js";
import type { UiLocator } from "../../domain/platform-ui.js";
import type { SemanticInteractiveElement, SemanticSurfaceSnapshot, SurfaceAgentPort, SurfaceAgentRequest } from "../../domain/surface-agent.js";
import { BrowserCalibrationRecorder } from "./calibration-recorder.js";
import { BrowserDomUiDriver, UiTargetNotFoundError } from "./dom-ui-driver.js";
import { beginScreencast } from "./screencast-recorder.js";
import { surfaceExecutionBootstrapUrl } from "./surface-bootstrap.js";

export type AutonomousStepAction = "CLICK" | "SET_FILE" | "FILL_CAPTION" | "FILL_TITLE" | "FINAL_BOUNDARY";
/**
 * The journal also records read-only assertions that touch nothing at all (audio integrity). Those
 * are deliberately NOT step actions: they have no locator, propose nothing to the surface agent,
 * and can never be replayed as an interaction.
 */
export type AutonomousJournalAction = AutonomousStepAction | "OBSERVE";
interface AutonomousStep {
  stepKey: string;
  label: string;
  action: AutonomousStepAction;
  required: boolean;
  locators: readonly UiLocator[];
  timeoutMs?: number;
}
export interface AutonomousSurfaceJournalEntry {
  at: string;
  stepKey: string;
  action: AutonomousJournalAction;
  outcome: "PASS" | "SKIPPED" | "FAIL";
  locator?: UiLocator;
  detail: string;
}
export interface AutonomousSurfaceExplorationResult {
  contract: PlatformSurfaceContract;
  artifactRefs: readonly string[];
  journal: readonly AutonomousSurfaceJournalEntry[];
}

function locatorKey(locator: UiLocator): string { return JSON.stringify([locator.kind, locator.role ?? "", locator.value, locator.exact ?? false]); }
function unique(locators: readonly UiLocator[]): readonly UiLocator[] {
  const seen = new Set<string>();
  return locators.filter((locator) => { const key = locatorKey(locator); if (seen.has(key)) return false; seen.add(key); return true; });
}
function named(role: string, names: readonly string[]): UiLocator[] {
  return names.map((value) => ({ kind: "role" as const, role, value, exact: true }));
}
/**
 * Substring fallbacks, always appended after the exact candidates so precision is still tried
 * first.
 *
 * A control's accessible name is not always the label a human reads. Instagram renders its create
 * control as a single link holding two text nodes, so textContent concatenates to
 * "Neuer BeitragErstellen" and every exact match against "Erstellen" or "Neuer Beitrag" fails on
 * a perfectly ordinary page.
 */
function namedContains(role: string, names: readonly string[]): UiLocator[] {
  return names.map((value) => ({ kind: "role" as const, role, value, exact: false }));
}
function text(names: readonly string[]): UiLocator[] { return names.map((value) => ({ kind: "text" as const, value, exact: true })); }

function openingSteps(profile: PostingProfile): AutonomousStep[] {
  if (profile.platform === "instagram") {
    // Evidence from the live create menu (see qualification screenshots): it offers exactly one
    // entry, "Beitrag" -- Instagram merged the formats and a video post becomes a reel on its
    // own; trial mode is a later dialog setting, not a menu entry. "Reel"/"Reels" must NOT be
    // candidates here: "Reels" is the accessible name of the left-navigation feed item, so an
    // exact text match clicked the feed, which closed the menu and navigated away from the flow.
    const formatNames = profile.format === "story" ? ["Story", "Stories"] : ["Beitrag", "Post"];
    return [
      { stepKey: "OPEN_CREATE", label: "Open create flow", action: "CLICK", required: true, locators: [...named("button", ["Create", "Erstellen", "New post", "Neuer Beitrag"]), ...named("link", ["Create", "Erstellen"]), ...text(["Create", "Erstellen"]), ...namedContains("link", ["Erstellen", "Create"]), ...namedContains("button", ["Erstellen", "Create"])] },
      { stepKey: profile.format === "story" ? "SELECT_STORY" : "SELECT_REEL", label: `Select ${profile.format}`, action: "CLICK", required: false, locators: [...named("button", formatNames), ...named("menuitem", formatNames), ...text(formatNames), ...namedContains("button", formatNames), ...namedContains("menuitem", formatNames)] }
    ];
  }
  if (profile.platform === "tiktok") {
    return [{ stepKey: "OPEN_UPLOAD", label: "Open upload flow", action: "CLICK", required: false, locators: [...named("link", ["Upload", "Hochladen"]), ...named("button", ["Upload", "Hochladen"]), ...text(["Upload", "Hochladen"])] }];
  }
  // YouTube Studio needs two steps, not one: the create control opens a menu, and the upload
  // entry inside it is what reaches the dialog. Mixing both into a single step meant the create
  // button always won and the menu entry was never clicked -- the upload input never existed.
  return [
    { stepKey: "OPEN_CREATE", label: "Open create menu", action: "CLICK", required: true, locators: [...named("button", ["Create", "Erstellen"]), ...named("link", ["Create", "Erstellen"]), ...namedContains("button", ["Erstellen", "Create"])] },
    { stepKey: "OPEN_UPLOAD", label: "Choose video upload", action: "CLICK", required: false, locators: [...named("menuitem", ["Video hochladen", "Videos hochladen", "Upload video", "Upload videos"]), ...named("button", ["Video hochladen", "Videos hochladen", "Upload video", "Upload videos"]), ...text(["Video hochladen", "Videos hochladen", "Upload video", "Upload videos"])] }
  ];
}
function uploadStep(): AutonomousStep {
  return { stepKey: "UPLOAD_MEDIA", label: "Upload media", action: "SET_FILE", required: true, timeoutMs: 60_000, locators: [{ kind: "css", value: "input[type=\"file\"]" }] };
}
function uploadRevealStep(): AutonomousStep {
  return { stepKey: "REVEAL_FILE_INPUT", label: "Reveal file input", action: "CLICK", required: false, locators: [...named("button", ["Select from computer", "Vom Computer auswählen", "Select files", "Dateien auswählen", "Upload", "Hochladen"]), ...text(["Select from computer", "Vom Computer auswählen", "Select files", "Dateien auswählen"])] };
}
function captionLocators(): readonly UiLocator[] {
  return unique([
    // "Bildunterschrift verfassen …" is the observed accessible name on the live compose stage
    // (U+2026, preceded by a space); the older guesses stay for other locales/ages of the UI.
    ...named("textbox", ["Bildunterschrift verfassen …", "Bildunterschrift verfassen ...", "Write a caption…", "Write a caption...", "Caption", "Bildunterschrift", "Schreibe eine Bildunterschrift …", "Describe your post", "Beschreibe deinen Beitrag"]),
    { kind: "role", role: "textbox", value: "Bildunterschrift", exact: false },
    { kind: "role", role: "textbox", value: "caption", exact: false },
    { kind: "label", value: "Caption", exact: false },
    { kind: "label", value: "Bildunterschrift", exact: false },
    // TikTok live evidence 2026-08-31: the caption is a DraftJS surface with no accessible name
    // and role="combobox"; only its stable editor class identifies it.
    { kind: "css", value: "div.public-DraftEditor-content[contenteditable=\"true\"]" },
    { kind: "css", value: "textarea[aria-label*=\"caption\" i]" },
    { kind: "css", value: "div[contenteditable=\"true\"][data-e2e*=\"caption\"]" }
  ]);
}
function titleLocators(): readonly UiLocator[] {
  return unique([...named("textbox", ["Title", "Titel"]), { kind: "label", value: "Title", exact: false }, { kind: "label", value: "Titel", exact: false }, { kind: "css", value: "#textbox[contenteditable=\"true\"]" }]);
}
function nextLocators(): readonly UiLocator[] { return unique([...named("button", ["Next", "Weiter", "Continue", "Fortfahren"]), ...text(["Next", "Weiter", "Continue", "Fortfahren"])]); }
/**
 * One-shot informational overlays Instagram lays over the create flow ("Videobeiträge sind jetzt
 * Reels" after the first upload of a fresh profile). They absorb trusted clicks aimed at the
 * dialog underneath, so a NEXT click reports success while the flow never advances.
 *
 * Dismissal is deliberately narrow. Only a [role=dialog] qualifies, only when it carries a
 * confirm button whose exact accessible name is in the allowlist, and never when the dialog
 * contains flow or publish vocabulary, a file input, or a text field -- that excludes the create
 * dialog itself and anything resembling a final action.
 */
export const BENIGN_OVERLAY_CONFIRM_LABELS = ["OK", "Verstanden", "Got it", "Jetzt nicht", "Not now"] as const;
export const OVERLAY_DISMISS_FORBIDDEN_WORDS = ["Weiter", "Next", "Continue", "Fortfahren", "Teilen", "Share", "Post", "Posten", "Publish", "Veröffentlichen"] as const;
/**
 * Cookie-consent banners (TikTok shows one on every fresh profile) are handled by the same
 * narrow mechanism, with one difference: the DECLINE variant is preferred and the only accepted
 * choice -- accept-all vocabulary ("Alle erlauben", "Accept all") is deliberately absent from
 * every allowlist, so the flow can never consent to non-essential cookies on the operator's
 * behalf. When a decline button is present it wins over the generic confirm labels.
 *
 * TIKTOK-LIVE-CALIBRATION: TikTok has historically rendered its banner as a
 * <tiktok-cookie-banner> custom element with a shadow root rather than a [role=dialog]. The
 * scan below therefore also inspects that host's shadow DOM. The exact live structure (labels,
 * shadow vs. light DOM, whether the banner intercepts clicks at all) is unverified until the
 * first live TikTok snapshot; a banner this scan cannot match stays put and the flow fails
 * closed on the next occluded required click, with boundary evidence.
 */
export const COOKIE_CONSENT_DECLINE_LABELS = ["Alle ablehnen", "Decline all", "Reject all", "Decline optional cookies", "Optionale Cookies ablehnen"] as const;

function finalLocators(profile: PostingProfile): readonly UiLocator[] {
  if (profile.platform === "instagram") return unique([...named("button", ["Share", "Teilen", "Publish", "Veröffentlichen"]), ...text(["Share", "Teilen"])]);
  if (profile.platform === "tiktok") return unique([...named("button", ["Post", "Posten", "Publish", "Veröffentlichen"]), ...text(["Post", "Posten"])]);
  // Studio's final control is "Speichern" for a private upload and its accessible name is not
  // always computed from the custom element wrapper -- the button was plainly in the DOM while
  // the name-based candidates missed it. Exact text, never a substring: this is FINAL_ACTION.
  return unique([...named("button", ["Publish", "Veröffentlichen", "Save", "Speichern"]), ...text(["Publish", "Veröffentlichen", "Save", "Speichern"])]);
}

export async function captureSemanticSurfaceSnapshot(session: BrowserPageSessionPort, input: { platform: PublicationIntent["platform"]; format: PublicationIntent["format"]; stepKey: string; capturedAt: string }): Promise<SemanticSurfaceSnapshot> {
  const raw = await session.evaluate<{ currentUrl: string; title: string; elements: SemanticInteractiveElement[] }>(`(() => {
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 180);
    const visible = el => { const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&r.width>0&&r.height>0; };
    const nativeRole = el => { const tag=el.tagName.toLowerCase(),type=(el.getAttribute('type')||'').toLowerCase();if(tag==='button'||(tag==='input'&&['button','submit','reset'].includes(type)))return'button';if(tag==='a'&&el.hasAttribute('href'))return'link';if(tag==='textarea'||(tag==='input'&&!['checkbox','radio','file','hidden'].includes(type))||el.isContentEditable)return'textbox';if(tag==='select')return'combobox';if(tag==='input'&&type==='checkbox')return'checkbox';if(tag==='input'&&type==='radio')return'radio';return undefined; };
    const nodes=Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role],[contenteditable="true"]')).filter(visible).slice(0,250);
    return {currentUrl:location.href,title:document.title,elements:nodes.map((el,index)=>{const role=el.getAttribute('role')||nativeRole(el),name=clean(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')||el.textContent||'');const type=el.getAttribute('type')||undefined,href=el instanceof HTMLAnchorElement?el.getAttribute('href')||undefined:undefined;const checked=el instanceof HTMLInputElement&&(el.type==='checkbox'||el.type==='radio')?el.checked:undefined;const selected=el.getAttribute('aria-selected')==='true'?true:el.getAttribute('aria-selected')==='false'?false:undefined;return{index,tag:el.tagName.toLowerCase(),...(role?{role}:{}),name,...(type?{type}:{}),...(href?{href}:{}),...(checked!==undefined?{checked}:{}),...(selected!==undefined?{selected}:{}),disabled:Boolean(el.disabled||el.getAttribute('aria-disabled')==='true')};})};
  })()`);
  return { capturedAt: new Date(input.capturedAt).toISOString(), platform: input.platform, format: input.format, stepKey: input.stepKey, currentUrl: raw.currentUrl, title: raw.title, elements: raw.elements };
}

export class AutonomousSurfaceExplorer {
  private readonly driver: BrowserDomUiDriver;
  private readonly recorder = new BrowserCalibrationRecorder();
  private readonly now: () => string;
  constructor(
    private readonly session: BrowserPageSessionPort,
    private readonly artifacts: PrepareArtifactSinkPort,
    private readonly agent?: SurfaceAgentPort,
    now: () => string = () => new Date().toISOString()
  ) { this.driver = new BrowserDomUiDriver(session); this.now = now; }

  private async workingLocator(locators: readonly UiLocator[], visibleOnly: boolean, timeoutMs: number): Promise<UiLocator | null> {
    const candidates = unique(locators);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      for (const locator of candidates) {
        try { await this.driver.locate([locator], 150, visibleOnly); return locator; }
        catch (error) { if (!(error instanceof UiTargetNotFoundError)) throw error; }
      }
      await sleep(150);
    }
    return null;
  }

  private async locatorsFor(step: AutonomousStep, intent: PublicationIntent): Promise<readonly UiLocator[]> {
    const builtIn = unique(step.locators);
    if (await this.workingLocator(builtIn, step.action !== "SET_FILE", Math.min(step.timeoutMs ?? 5_000, 3_000))) return builtIn;
    if (!this.agent) return builtIn;
    const snapshot = await captureSemanticSurfaceSnapshot(this.session, { platform: intent.platform, format: intent.format, stepKey: step.stepKey, capturedAt: this.now() });
    const request: SurfaceAgentRequest = {
      schemaVersion: 1,
      objective: "LOCATE_SAFE_UI_STEP",
      stepKey: step.stepKey,
      action: step.action === "SET_FILE" ? "SET_FILE" : step.action === "FILL_CAPTION" || step.action === "FILL_TITLE" ? "FILL" : step.action,
      safety: { finalActionMayBeLocated: true, finalActionMayBeInvoked: false, credentialsIncluded: false, inputValuesIncluded: false },
      builtInCandidates: builtIn,
      snapshot
    };
    const proposed = await this.agent.propose(request);
    return unique([...(proposed?.locators ?? []), ...builtIn]);
  }

  /** Returns true when a benign overlay was dismissed with a trusted click. */
  private async dismissBenignOverlay(journal: AutonomousSurfaceJournalEntry[]): Promise<boolean> {
    const allow = JSON.stringify(BENIGN_OVERLAY_CONFIRM_LABELS);
    const decline = JSON.stringify(COOKIE_CONSENT_DECLINE_LABELS);
    const forbid = JSON.stringify(OVERLAY_DISMISS_FORBIDDEN_WORDS.map((word) => word.toLocaleLowerCase("en-US")));
    const center = await this.session.evaluate<{ x: number; y: number; title: string } | null>(`(() => {
      const allow = new Set(${allow});
      const decline = new Set(${decline});
      const forbid = ${forbid};
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const containers = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
      const cookieHost = document.querySelector('tiktok-cookie-banner');
      if (cookieHost) containers.push(cookieHost);
      // Product tours render their own opaque page overlay with pointer-events enabled, so an
      // unfinished tour blocks the compose surface exactly like a modal -- TikTok's covered the
      // caption behind an empty presentation layer. Their tooltip carries the same acknowledge
      // control the allowlist already trusts; every guard below still applies to it.
      containers.push(...document.querySelectorAll('.react-joyride__tooltip, [data-test-id="tooltip"]'));
      for (const container of containers) {
        const scope = container.shadowRoot ?? container;
        const text = normalize(scope.textContent || container.textContent).toLocaleLowerCase("en-US");
        if (forbid.some((word) => text.includes(word.toLocaleLowerCase("en-US")))) continue;
        if (scope.querySelector('input[type="file"], textarea, [contenteditable="true"]')) continue;
        // Not every acknowledge control is a semantic button: TikTok's tour renders "Verstanden"
        // as a plain div, so a button-only scan never found it and the tour kept covering the
        // compose surface. Candidates stay exact-name-matched and must be visible; the container
        // has already passed the input and forbidden-word guards above.
        const clickable = (el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
        const buttons = [...scope.querySelectorAll('button, [role="button"], div, span')].filter(clickable);
        // Some widgets carry stylesheet text in aria-label (TikTok's tour tooltip does), so a
        // single name source silently stops matching. Either the label or the visible text may
        // identify the control -- both are compared against the same exact allowlists.
        const names = (el) => [normalize(el.getAttribute("aria-label")), normalize(el.textContent)].filter(Boolean);
        const confirm = buttons.find((el) => names(el).some((value) => decline.has(value))) ?? buttons.find((el) => names(el).some((value) => allow.has(value)));
        if (!confirm) continue;
        confirm.setAttribute("data-flerdvision-overlay", ${JSON.stringify("m")});
        confirm.scrollIntoView({ block: "center", inline: "center" });
        const rect = confirm.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, title: normalize(scope.textContent || container.textContent).slice(0, 80) };
      }
      return null;
    })()`);
    if (!center) return false;
    if (this.session.clickAt) await this.session.clickAt(center.x, center.y);
    else await this.session.evaluate(`(() => {
      const host = document.querySelector('tiktok-cookie-banner');
      const el = document.querySelector('[data-flerdvision-overlay]') || (host && host.shadowRoot && host.shadowRoot.querySelector('[data-flerdvision-overlay]'));
      if (el) el.click();
    })()`);
    journal.push({ at: this.now(), stepKey: "DISMISS_OVERLAY", action: "CLICK", outcome: "PASS", detail: `Dismissed benign overlay: ${center.title}` });
    return true;
  }

  /**
   * Every step goes through here, which makes it the one place that can tell a broken surface
   * from a refusing platform. When a step fails, the page is asked whether the platform has put
   * a refusal on the screen -- an upload quota, a temporary block, a suspended account. If it
   * has, that sentence becomes the error: retrying or repairing selectors cannot lift it, and
   * the operator needs to read the real reason rather than a locator complaint.
   */
  private async executeStep(step: AutonomousStep, intent: PublicationIntent, input: { mediaPath: string; caption?: string; title?: string }, artifactRefs: string[], journal: AutonomousSurfaceJournalEntry[]): Promise<{ locator: UiLocator; fallbacks: readonly UiLocator[] } | null> {
    try {
      return await this.runStep(step, intent, input, artifactRefs, journal);
    } catch (error) {
      if (error instanceof PlatformRefusedError) throw error;
      const refusal = await detectPlatformRefusal(this.session);
      if (!refusal) throw error;
      journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: "FAIL", detail: refusal.message });
      artifactRefs.push(...await this.artifacts.captureBoundary(this.session, intent, { identityId: "surface-explorer", accountId: intent.accountId, platform: intent.platform, profileKey: "surface-explorer", expectedHandle: intent.accountId, enabled: true }, "autonomous-platform-refused", this.now()));
      throw refusal;
    }
  }

  private async runStep(step: AutonomousStep, intent: PublicationIntent, input: { mediaPath: string; caption?: string; title?: string }, artifactRefs: string[], journal: AutonomousSurfaceJournalEntry[]): Promise<{ locator: UiLocator; fallbacks: readonly UiLocator[] } | null> {
    const candidates = await this.locatorsFor(step, intent);
    const visibleOnly = step.action !== "SET_FILE";
    let selected = await this.workingLocator(candidates, visibleOnly, step.timeoutMs ?? 12_000);
    if (!selected) {
      const detail = `No safe locator found for ${step.stepKey}`;
      journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: step.required ? "FAIL" : "SKIPPED", detail });
      if (step.required) {
        // A required step that cannot find its target says nothing about WHY; without a capture
        // of the surface at that instant every investigation starts blind.
        artifactRefs.push(...await this.artifacts.captureBoundary(this.session, intent, { identityId: "surface-explorer", accountId: intent.accountId, platform: intent.platform, profileKey: "surface-explorer", expectedHandle: intent.accountId, enabled: true }, `autonomous-${step.stepKey.toLocaleLowerCase("en-US")}-unfound`, this.now()).catch(() => []));
        artifactRefs.push(await this.artifacts.writeJournal(intent, journal, this.now()).catch(() => ""));
        throw new Error(detail);
      }
      return null;
    }
    const chosen: UiLocator = selected;
    const fallbacks = candidates.filter((locator) => locatorKey(locator) !== locatorKey(chosen)).slice(0, 3);
    // What the contract records can differ from what this page is clicked by: a transient
    // marker is valid here and meaningless in a replay. Recorded stays the durable answer.
    let recorded: UiLocator = selected;
    if (step.action === "CLICK") {
      try {
        // Prefer the element a person sees: name matching alone repeatedly settled on a
        // mounted-but-stacked twin (YouTube's create menu, TikTok's dialogs), and the occlusion
        // guard then refused a control that was plainly on screen. Exact names only.
        const stepNames = step.locators.filter((locator) => locator.kind === "role" || locator.kind === "text").map((locator) => locator.value);
        const visible = stepNames.length > 0 ? await clickExactVisibleByName(this.session, stepNames) : null;
        if (visible) await this.driver.click([{ kind: "css", value: '[data-flerdvision-exact="1"]' }], step.timeoutMs ?? 12_000, []);
        else await this.driver.click([selected], step.timeoutMs ?? 12_000, []);
      } catch (firstError) {
        // A menu that is still animating puts a neighbour under the click point: YouTube's
        // create menu refused "Videos hochladen" as occluded by "Livestream starten". One
        // settle and one retry -- a genuinely covered target still refuses twice.
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        if (!/^Refusing to click/.test(firstMessage)) throw firstError;
        await sleep(1500);
        try {
          const names = step.locators.filter((locator) => locator.kind === "role" || locator.kind === "text").map((locator) => locator.value);
          const exact = names.length > 0 ? await clickExactVisibleByName(this.session, names) : null;
          if (exact) await this.driver.click([{ kind: "css", value: '[data-flerdvision-exact="1"]' }], step.timeoutMs ?? 12_000, []);
          else await this.driver.click([selected], step.timeoutMs ?? 12_000, []);
        } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // An optional step names a control some surface variants simply do not have: the
        // compact-nav create button opens the dialog directly, so the format-picker step found
        // only a stray namedContains match buried under the dialog. A target that stays occluded
        // for the whole click deadline is the same statement as "not present" -- for an OPTIONAL
        // step that means SKIPPED, with evidence. Required steps and every other error still
        // escalate, and the next required step keeps the flow fail-closed if the click mattered.
        if (step.required || !/^Refusing to click/.test(message)) throw error;
        journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: "SKIPPED", locator: selected, detail: message });
        artifactRefs.push(...await this.artifacts.captureBoundary(this.session, intent, { identityId: "surface-explorer", accountId: intent.accountId, platform: intent.platform, profileKey: "surface-explorer", expectedHandle: intent.accountId, enabled: true }, `autonomous-${step.stepKey.toLocaleLowerCase("en-US")}-occluded`, this.now()));
          return null;
        }
      }
    }
    else if (step.action === "SET_FILE") {
      try {
        await this.driver.setFile([selected], input.mediaPath, step.timeoutMs ?? 60_000);
      } catch (error) {
        // The upload is attempted first as an optional probe (some surfaces expose the input
        // only after a reveal click). A failing probe must leave the flow to the required
        // attempt that follows, not end the run.
        if (step.required) throw error;
        const message = error instanceof Error ? error.message : String(error);
        journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: "SKIPPED", locator: selected, detail: message });
        return null;
      }
    }
    else if (step.action === "FILL_CAPTION" || step.action === "FILL_TITLE") {
      const value = step.action === "FILL_CAPTION" ? input.caption : input.title;
      if (value === undefined) throw new Error(`${step.action === "FILL_CAPTION" ? "Caption" : "Title"} payload is missing`);
      // One selector can match several fields -- YouTube gives the title and the description the
      // same id -- and the first match may be an off-screen one, which then reads as "occluded"
      // no matter how long the run waits. Prefer the field a person would type into.
      const cssSelectors = candidates.filter((locator) => locator.kind === "css").map((locator) => locator.value);
      // The marker attribute only exists inside THIS page: it is how the exploration pins the
      // one field a person would type into among identical twins. It must never end up in the
      // recorded contract -- a replay opens a fresh page where nothing carries it, and the route
      // would then depend entirely on its fallbacks. So retarget reports WHICH selector it
      // tagged: the marker drives the typing here, the real selector is what gets recorded.
      const retarget = async (): Promise<string | null> => await this.session.evaluate<string | null>(`(() => {
          const selectors = ${JSON.stringify(cssSelectors)};
          for (const previous of Array.from(document.querySelectorAll('[data-flerdvision-field]'))) previous.removeAttribute('data-flerdvision-field');
          for (const selector of selectors) {
            for (const element of Array.from(document.querySelectorAll(selector))) {
              const style = getComputedStyle(element);
              if (style.display === "none" || style.visibility === "hidden") continue;
              // A field can sit outside the dialog's scroll window: its rect is then off-screen
              // and the point test hits whatever happens to be at those coordinates. Bring it
              // into view first -- exactly what a person does before typing.
              element.scrollIntoView({ block: "center", inline: "center" });
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) continue;
              const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(16, rect.height / 2));
              if (!hit || !(hit === element || element.contains(hit) || hit.contains(element))) continue;
              element.setAttribute('data-flerdvision-field', '1');
              return selector;
            }
          }
          return null;
        })()`).catch(() => null);
      // Overlays surface late and STACK: TikTok raised an info dialog and a feature offer over
      // the caption at once, so dismissing only the first left the field just as covered. Every
      // dismissal runs on each pass -- short-circuiting hid the second dialog entirely -- and
      // the fill is retried while something was actually cleared.
      for (let attempt = 0; ; attempt += 1) {
        try {
          // Re-target on every attempt: which field is reachable changes while the surface
          // settles, so deciding once before the first try fixed the wrong answer in place.
          if (cssSelectors.length > 0) {
            const tagged = await retarget();
            if (tagged !== null) {
              recorded = { kind: "css", value: tagged };
              selected = { kind: "css", value: '[data-flerdvision-field="1"]' };
            }
          }
          await this.driver.fill([selected], value, step.timeoutMs ?? 12_000);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Product tours are multi-step: each acknowledge clears one step and re-renders the
          // same blocking overlay, so a two-attempt budget could never walk one out.
          if (!/^Refusing to click/.test(message) || attempt >= 7) throw error;
          // A dismissal that throws must not end the retry: the next one may be the one that
          // clears the blocking layer. Evidence is captured on every blocked pass, because a
          // bare occlusion message never says which layers were actually up.
          artifactRefs.push(...await this.artifacts.captureBoundary(this.session, intent, { identityId: "surface-explorer", accountId: intent.accountId, platform: intent.platform, profileKey: "surface-explorer", expectedHandle: intent.accountId, enabled: true }, `autonomous-${step.stepKey.toLocaleLowerCase("en-US")}-blocked-${attempt}`, this.now()).catch(() => []));
          const benign = await this.dismissBenignOverlay(journal).catch(() => false);
          const declined = await declineFeatureOptIn(this.session, journal).catch(() => false);
          if (!benign && !declined) {
            // Not every blocking layer is a dialog: a surface mid-animation puts a plain,
            // nameless div over the field for a moment. Nothing to dismiss, everything to wait
            // out -- but only for the first attempts, so a permanent cover still fails loudly.
            if (attempt >= 2) {
              artifactRefs.push(await this.artifacts.writeJournal(intent, journal, this.now()).catch(() => ""));
              throw error;
            }
            await sleep(2500);
            continue;
          }
          // A dismissed modal leaves its backdrop behind for a moment, and that empty layer is
          // just as opaque to a click as the dialog was. Wait for the surface to actually clear.
          for (let clear = false, deadline = Date.now() + 8_000; !clear && Date.now() < deadline; ) {
            clear = await this.session.evaluate<boolean>(`(() => {
              const visible = (el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0; };
              return !Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some(visible);
            })()`).catch(() => true);
            if (!clear) await sleep(500);
          }
          await sleep(1200);
        }
      }
    } else {
      await this.driver.locate([selected], step.timeoutMs ?? 12_000, true);
    }
    const detail = `${recorded.kind}:${recorded.value}`;
    journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: "PASS", locator: recorded, detail });
    artifactRefs.push(...await this.artifacts.captureBoundary(this.session, intent, { identityId: "surface-explorer", accountId: intent.accountId, platform: intent.platform, profileKey: "surface-explorer", expectedHandle: intent.accountId, enabled: true }, `autonomous-${step.stepKey.toLocaleLowerCase("en-US")}`, this.now()));
    if (step.action === "SET_FILE") await sleep(3000); else if (step.action !== "FINAL_BOUNDARY") await sleep(900);
    return { locator: recorded, fallbacks };
  }

  /**
   * Exploration is the leg that most often surprises a human afterwards: it decides, live, what
   * this surface looks like today. An optional screencast of it is written next to the step
   * screenshots and appended to the same artifact list -- fail-open, so nothing about the
   * discovery depends on the recording having worked.
   */
  async discoverAndPrepare(input: {
    intent: PublicationIntent;
    identity: BrowserIdentity;
    postingProfile: PostingProfile;
    mediaPath: string;
    caption?: string;
    title?: string;
  }): Promise<AutonomousSurfaceExplorationResult> {
    const artifactRefs: string[] = [];
    const recording = await beginScreencast(this.session, this.artifacts.recordingDirectory?.(input.intent), `screencast-surface-discovery-${input.intent.platform}`);
    try {
      return await this.discoverAndPrepareInternal(input, artifactRefs);
    } finally {
      // The result already holds this exact array, so appending here still reaches the caller.
      const recorded = await recording?.stop();
      if (recorded) artifactRefs.push(recorded);
    }
  }

  private async discoverAndPrepareInternal(input: {
    intent: PublicationIntent;
    identity: BrowserIdentity;
    postingProfile: PostingProfile;
    mediaPath: string;
    caption?: string;
    title?: string;
  }, artifactRefs: string[]): Promise<AutonomousSurfaceExplorationResult> {
    if (input.identity.accountId !== input.intent.accountId || input.identity.platform !== input.intent.platform) throw new Error("Surface exploration identity does not match intent");
    const journal: AutonomousSurfaceJournalEntry[] = [];
    const steps: SurfaceContractStep[] = [];
    await this.session.navigate(surfaceExecutionBootstrapUrl(input.postingProfile.platform));
    // A fixed settle is a race against the app's own boot: TikTok Studio's document was still a
    // 1.5 KB shell when exploration began, so nothing could be located at all. Wait until the
    // surface actually rendered interactive content, bounded, then settle briefly.
    for (let rendered = false, deadline = Date.now() + 40_000; !rendered && Date.now() < deadline; ) {
      // Links alone are not evidence of a booted app: the TikTok shell rendered its title and
      // navigation while the upload widget did not exist yet. Controls are the real signal.
      rendered = await this.session.evaluate<boolean>(`document.querySelectorAll('button, [role="button"], input, textarea').length > 0`).catch(() => false);
      if (!rendered) await sleep(500);
    }
    await sleep(1500);
    artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, "autonomous-bootstrap", this.now()));
    const environment = await this.recorder.environment(this.session);

    // First-run dialogs (enable-notifications on a fresh account, and friends) sit over the
    // create control before anything has been clicked at all. The post-upload dismissal cannot
    // help there; the TikTok-readiness review flagged exactly this wiring gap.
    await this.dismissBenignOverlay(journal);
    const draftDismissed = await dismissDraftRestore(this.session, journal);
    if (draftDismissed) await sleep(3000);
    // An optional opening step navigates TOWARDS the upload surface; clicking it when the file
    // input is already on the page navigates away from it (TikTok's nav "Hochladen" leaves the
    // studio upload page, and the required upload step then found nothing at all).
    // Bounded, because an instant check races the page's own load: a not-yet-rendered input
    // read as "not the upload surface" and the opening click then navigated away from it.
    let uploadReady = false;
    for (const deadline = Date.now() + 8_000; Date.now() < deadline && !uploadReady; ) {
      uploadReady = await this.session.evaluate<boolean>(`Boolean(document.querySelector('input[type="file"]'))`).catch(() => false);
      if (!uploadReady) await sleep(500);
    }
    for (const step of openingSteps(input.postingProfile)) {
      // Opening steps exist to REACH the upload surface. Standing on it already makes them
      // pointless by definition -- and harmful: YouTube's create control sits behind the very
      // dialog we are in, so clicking it was refused by the dialog's own backdrop.
      if (uploadReady) {
        journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: "SKIPPED", detail: "upload surface already reached" });
        continue;
      }
      const result = await this.executeStep(step, input.intent, input, artifactRefs, journal);
      if (result) steps.push({ stepKey: step.stepKey, label: step.label, actionMode: "OBSERVE_ACTION", locator: result.locator, fallbackLocators: result.fallbacks, observations: 1 });
    }

    const upload = uploadStep();
    let uploadResult = await this.executeStep({ ...upload, required: false, timeoutMs: 2500 }, input.intent, input, artifactRefs, journal);
    if (!uploadResult) {
      const reveal = uploadRevealStep();
      const revealResult = await this.executeStep(reveal, input.intent, input, artifactRefs, journal);
      if (revealResult) steps.push({ stepKey: reveal.stepKey, label: reveal.label, actionMode: "OBSERVE_ACTION", locator: revealResult.locator, fallbackLocators: revealResult.fallbacks, observations: 1 });
      uploadResult = await this.executeStep(upload, input.intent, input, artifactRefs, journal);
    }
    if (!uploadResult) throw new Error("Upload media step unexpectedly remained unresolved");
    steps.push({ stepKey: upload.stepKey, label: upload.label, actionMode: "OBSERVE_ACTION", locator: uploadResult.locator, fallbackLocators: uploadResult.fallbacks, observations: 1 });

    const fieldAction: AutonomousStep = input.postingProfile.platform === "youtube"
      ? { stepKey: "TITLE", label: "Title field", action: "FILL_TITLE", required: true, locators: titleLocators(), timeoutMs: 60_000 }
      : { stepKey: "CAPTION", label: "Caption field", action: "FILL_CAPTION", required: true, locators: captionLocators(), timeoutMs: 60_000 };
    // The first upload on a fresh profile summons the one-shot info overlay right here.
    await this.dismissBenignOverlay(journal);
    let fieldLocators = await this.locatorsFor(fieldAction, input.intent);
    // TikTok has no continue-chain: the editor (and with it the caption) appears only once the
    // upload finished processing, which takes far longer than the short probe used for surfaces
    // that reach the caption through NEXT clicks.
    const firstFieldWaitMs = input.postingProfile.platform === "tiktok" ? 90_000 : 2500;
    let fieldSelected = await this.workingLocator(fieldLocators, true, firstFieldWaitMs);
    for (let nextIndex = 1; !fieldSelected && nextIndex <= 3; nextIndex += 1) {
      await this.dismissBenignOverlay(journal);
      const next: AutonomousStep = { stepKey: `NEXT_${nextIndex}`, label: `Continue ${nextIndex}`, action: "CLICK", required: true, locators: nextLocators(), timeoutMs: 45_000 };
      const result = await this.executeStep(next, input.intent, input, artifactRefs, journal);
      if (!result) throw new Error(`Could not continue platform flow at ${next.stepKey}`);
      steps.push({ stepKey: next.stepKey, label: next.label, actionMode: "OBSERVE_ACTION", locator: result.locator, fallbackLocators: result.fallbacks, observations: 1 });
      fieldLocators = await this.locatorsFor(fieldAction, input.intent);
      fieldSelected = await this.workingLocator(fieldLocators, true, 5000);
    }
    if (!fieldSelected) throw new Error(`Could not reach ${fieldAction.stepKey} after upload`);
    const fieldResult = await this.executeStep({ ...fieldAction, locators: [fieldSelected, ...fieldLocators.filter((locator) => locatorKey(locator) !== locatorKey(fieldSelected))] }, input.intent, input, artifactRefs, journal);
    if (!fieldResult) throw new Error(`${fieldAction.stepKey} unexpectedly remained unresolved`);
    steps.push({ stepKey: fieldAction.stepKey, label: fieldAction.label, actionMode: "OBSERVE_ACTION", locator: fieldResult.locator, fallbackLocators: fieldResult.fallbacks, observations: 1 });

    // YouTube blocks its wizard on a mandatory audience declaration: Continue stays disabled
    // until it is answered, so it has to happen here, before any advance is attempted. It is a
    // legal statement about the content and therefore comes from the operator's spec only.
    if (input.postingProfile.platform === "youtube") {
      const madeForKids = input.postingProfile.madeForKids;
      if (madeForKids === undefined) throw new Error("YouTube requires the made-for-kids declaration: set settings.madeForKids in the canonical spec");
      const audienceNames = madeForKids
        ? ["Ja, es ist speziell für Kinder", "Yes, it's made for kids"]
        : ["Nein, es ist nicht speziell für Kinder", "No, it's not made for kids"];
      // Studio renders the options as custom elements with no usable role, so nothing role-based
      // can even locate them. Tag the visible option carrying the exact declared answer first,
      // then act on that one element -- no guessing, no substring matching.
      // Exact-name matching kept missing this one: Studio splits the answer across the radio and
      // its label, and the visible string carries punctuation the contract text does not. The two
      // answers are still told apart unambiguously -- "nicht"/"not" is the whole discriminator --
      // and the smallest matching element is chosen so a wrapper can never be clicked instead.
      const audienceTagged = await this.session.evaluate<boolean>(`(() => {
        const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
        const negative = ${JSON.stringify(!madeForKids)};
        const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
        const collect = (root, out) => { for (const element of Array.from(root.querySelectorAll('tp-yt-paper-radio-button, [role="radio"], input[type="radio"], label, div, span'))) { out.push(element); if (element.shadowRoot) collect(element.shadowRoot, out); } return out; };
        for (const previous of Array.from(document.querySelectorAll('[data-flerdvision-exact]'))) previous.removeAttribute('data-flerdvision-exact');
        const matches = collect(document, []).filter((element) => {
          if (!visible(element)) return false;
          const text = norm(element.getAttribute("aria-label")) || norm(element.textContent);
          if (text.length === 0 || text.length > 80) return false;
          const kidsGerman = text.includes("speziell für kinder");
          const kidsEnglish = text.includes("made for kids");
          if (!kidsGerman && !kidsEnglish) return false;
          const isNegative = text.includes("nicht") || text.startsWith("no,") || text.includes("not made");
          return isNegative === negative;
        });
        if (matches.length === 0) return false;
        matches.sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);
        matches[0].setAttribute('data-flerdvision-exact', '1');
        return true;
      })()`).catch(() => false);
      const tagged = audienceTagged ? "audience" : await clickExactVisibleByName(this.session, audienceNames);
      const audienceLocators: readonly UiLocator[] = tagged
        ? [{ kind: "css", value: '[data-flerdvision-exact="1"]' }]
        : [...named("radio", audienceNames), ...named("menuitemradio", audienceNames), ...text(audienceNames)];
      const audienceStep: AutonomousStep = { stepKey: "AUDIENCE", label: "Made-for-kids declaration", action: "CLICK", required: true, timeoutMs: 20_000, locators: audienceLocators };
      const audience = await this.executeStep(audienceStep, input.intent, input, artifactRefs, journal);
      if (!audience) throw new Error("Made-for-kids declaration could not be answered");
      // The marker that pinned the option exists only in this page. A replay opens a fresh
      // Studio and must find the answer by its wording, so the contract records the declared
      // sentence, never the marker -- the same rule the caption fields follow.
      const durableAudience: readonly UiLocator[] = [...text(audienceNames), ...named("radio", audienceNames), ...named("menuitemradio", audienceNames)];
      const recordedAudience = tagged ? durableAudience[0]! : audience.locator;
      const recordedFallbacks = tagged ? durableAudience.slice(1) : audience.fallbacks;
      steps.push({ stepKey: audienceStep.stepKey, label: audienceStep.label, actionMode: "OBSERVE_ACTION", locator: recordedAudience, fallbackLocators: recordedFallbacks, observations: 1 });
      await sleep(1200);
    }

    // Wizard surfaces put the final control on a later step: YouTube Studio asks for details,
    // then checks, then visibility, and only the last screen offers Save/Publish. Walking those
    // screens is what a person does; without it the run looked for a control that was three
    // clicks away and reported it missing.
    const finalCandidates = finalLocators(input.postingProfile);
    for (let advance = 1; advance <= 4; advance += 1) {
      if (await this.workingLocator(finalCandidates, true, 2500)) break;
      const wizardStep: AutonomousStep = { stepKey: `ADVANCE_${advance}`, label: `Advance wizard ${advance}`, action: "CLICK", required: false, locators: nextLocators(), timeoutMs: 20_000 };
      const advanced = await this.executeStep(wizardStep, input.intent, input, artifactRefs, journal);
      if (!advanced) break;
      steps.push({ stepKey: wizardStep.stepKey, label: wizardStep.label, actionMode: "OBSERVE_ACTION", locator: advanced.locator, fallbackLocators: advanced.fallbacks, observations: 1 });
      await sleep(1500);
    }

    // A platform keeps its final control disabled while it is still processing the upload
    // (YouTube's Save stays aria-disabled through the checks). Reaching a boundary that cannot
    // yet be pressed is not reaching it, so wait for it to become live -- bounded, read-only.
    const finalNames = JSON.stringify(finalCandidates.filter((locator) => locator.kind === "role" || locator.kind === "text").map((locator) => locator.value.toLocaleLowerCase("en-US")));
    for (let ready = false, deadline = Date.now() + 240_000; !ready && Date.now() < deadline; ) {
      ready = await this.session.evaluate<boolean>(`(() => {
        const wanted = new Set(${finalNames});
        const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
        return Array.from(document.querySelectorAll('button, [role="button"]')).some((element) => {
          const name = norm(element.getAttribute("aria-label")) || norm(element.textContent);
          if (!wanted.has(name)) return false;
          if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      })()`).catch(() => false);
      if (!ready) await sleep(2000);
    }

    const final: AutonomousStep = { stepKey: "FINAL_ACTION", label: "Final publish boundary", action: "FINAL_BOUNDARY", required: true, locators: finalCandidates, timeoutMs: 60_000 };
    const finalResult = await this.executeStep(final, input.intent, input, artifactRefs, journal);
    if (!finalResult) throw new Error("Final boundary unexpectedly remained unresolved");
    steps.push({ stepKey: final.stepKey, label: final.label, actionMode: "BLOCK_ACTION", locator: finalResult.locator, fallbackLocators: finalResult.fallbacks, observations: 1 });
    artifactRefs.push(await this.artifacts.writeJournal(input.intent, journal, this.now()));

    const contractId = `surface:${createHash("sha256").update(`${input.intent.accountId}|${input.postingProfile.postingProfileId}|${environment.fingerprint}|${steps.map((step) => locatorKey(step.locator)).join("|")}`).digest("hex").slice(0, 24)}`;
    return {
      contract: {
        contractId,
        accountId: input.intent.accountId,
        platform: input.intent.platform,
        format: input.intent.format,
        postingProfileId: input.postingProfile.postingProfileId,
        environment,
        steps,
        status: "RECORDED",
        createdAt: new Date(this.now()).toISOString()
      },
      artifactRefs,
      journal
    };
  }
}

/**
 * Best-effort draft hygiene after a PREPARE_ONLY pass (operator decision: qualification must
 * not leave create-dialog drafts on the account). Clicks the dialog close control, then
 * confirms ONLY an exact discard label inside a confirmation dialog. Never runs where a final
 * action could be hit: discard labels and final labels share no vocabulary, both clicks go
 * through the guarded trusted-click path, and any failure is swallowed -- hygiene, not safety.
 */
export const DISCARD_CONFIRM_LABELS = ["Verwerfen", "Discard", "Delete draft", "Entwurf verwerfen"] as const;

/**
 * Feature opt-in prompts (TikTok's "Automatische Inhaltsprüfungen aktivieren?") appear over the
 * compose surface and block it. They offer only "Einschalten" and "Abbrechen" -- neither belongs
 * in the generic benign allowlist: turning a feature on changes the account, and a bare
 * "Abbrechen" elsewhere can mean cancelling the upload itself. Declining is only allowed when
 * the dialog is visibly a feature offer, identified by its own wording.
 */
export const FEATURE_OPT_IN_MARKERS = ["inhaltsprüfungen aktivieren", "content checks", "urheberrechtsverletzungen", "copyright checks", "aktivieren?"] as const;
export const FEATURE_OPT_IN_DECLINE_LABELS = ["Abbrechen", "Cancel", "Nicht jetzt", "Not now", "Später", "Later"] as const;

export async function declineFeatureOptIn(session: BrowserPageSessionPort, journal?: AutonomousSurfaceJournalEntry[]): Promise<boolean> {
  const markers = JSON.stringify(FEATURE_OPT_IN_MARKERS);
  const forbidden = JSON.stringify(OVERLAY_DISMISS_FORBIDDEN_WORDS.map((word) => word.toLocaleLowerCase("en-US")));
  const declineLabels = JSON.stringify(FEATURE_OPT_IN_DECLINE_LABELS.map((label) => label.toLocaleLowerCase("en-US")));
  // Tag the decline control INSIDE the visible offer. Clicking by accessible name alone found a
  // hidden twin in another mounted dialog and the occlusion guard rightly refused it, so the
  // offer stayed up through every retry.
  const present = await session.evaluate<boolean>(`(() => {
    const markers = ${markers}; const forbidden = ${forbidden}; const declines = ${declineLabels};
    const visible = (el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0; };
    for (const previous of Array.from(document.querySelectorAll('[data-flerdvision-decline]'))) previous.removeAttribute('data-flerdvision-decline');
    for (const dialog of Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))) {
      if (!visible(dialog)) continue;
      if (dialog.querySelector('input[type="file"], textarea, [contenteditable="true"]')) continue;
      const text = (dialog.innerText || "").toLocaleLowerCase("en-US");
      // The guard belongs on the CONTROLS, not the prose: a copyright-check offer explains what
      // happens when you publish, and a body-text scan therefore refused to decline it forever.
      const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'));
      const labels = buttons.map((button) => (button.innerText || "").trim().toLocaleLowerCase("en-US"));
      if (labels.some((label) => forbidden.some((word) => label === word))) continue;
      if (!markers.some((marker) => text.includes(marker))) continue;
      const decline = buttons.find((button) => declines.includes((button.innerText || "").trim().toLocaleLowerCase("en-US")) && visible(button));
      if (!decline) continue;
      decline.setAttribute('data-flerdvision-decline', '1');
      return true;
    }
    return false;
  })()`).catch(() => false);
  if (!present) return false;
  try {
    const descriptor = await new BrowserDomUiDriver(session).click([{ kind: "css", value: '[data-flerdvision-decline="1"]' }], 6_000, []);
    journal?.push({ at: new Date().toISOString(), stepKey: "DECLINE_FEATURE_OPT_IN", action: "CLICK", outcome: "PASS", detail: descriptor });
    return true;
  } catch {
    journal?.push({ at: new Date().toISOString(), stepKey: "DECLINE_FEATURE_OPT_IN", action: "CLICK", outcome: "SKIPPED", detail: "feature offer present but no exact decline control" });
    return false;
  }
}

/** Text that identifies a leftover-draft restore prompt (TikTok shows one after any aborted run). */
export const DRAFT_RESTORE_MARKERS = ["wurde nicht gespeichert", "not saved", "unsaved", "entwurf wiederherstellen", "restore draft"] as const;

/**
 * Dismisses a leftover-draft restore prompt by discarding the draft. Narrow by construction:
 * the page must actually show the restore wording, and only an exact discard label is clicked.
 * The generic benign-overlay dismissal cannot do this -- the prompt also offers "Weiter", which
 * is forbidden vocabulary there for good reason. Discarding a stale draft never publishes.
 * Live evidence 2026-08-31: TikTok's upload page silently refuses new uploads while this prompt
 * is up, which stalled the whole qualification at the caption step.
 */

/**
 * Clicks the element a person would click: the one that carries this exact name, is visible, and
 * actually receives clicks at its own centre. Name-based locating can settle on a mounted-but-
 * stacked twin whose centre belongs to a neighbour -- YouTube's create menu refused "Videos
 * hochladen" as occluded by "Livestream starten" while the entry sat plainly visible on screen.
 */
async function clickExactVisibleByName(session: BrowserPageSessionPort, names: readonly string[]): Promise<string | null> {
  const wanted = JSON.stringify(names.map((name) => name.trim().toLocaleLowerCase("en-US")));
  const tagged = await session.evaluate<string | null>(`(() => {
    const wanted = new Set(${wanted});
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
    for (const previous of Array.from(document.querySelectorAll('[data-flerdvision-exact]'))) previous.removeAttribute('data-flerdvision-exact');
    // Studio and TikTok both put controls inside shadow roots, which a plain querySelectorAll
    // cannot see -- the search found nothing and the stacked-twin problem stayed unsolved.
    const collect = (root, out) => {
      for (const element of Array.from(root.querySelectorAll('button, a, [role="menuitem"], [role="button"], [role="option"], [role="radio"], tp-yt-paper-item, tp-yt-paper-radio-button, div, span'))) {
        out.push(element);
        if (element.shadowRoot) collect(element.shadowRoot, out);
      }
      return out;
    };
    const candidates = collect(document, []);
    for (const candidate of candidates) {
      const name = norm(candidate.getAttribute("aria-label")) || norm(candidate.textContent);
      if (!wanted.has(name)) continue;
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !(hit === candidate || candidate.contains(hit) || hit.contains(candidate))) continue;
      candidate.setAttribute('data-flerdvision-exact', '1');
      return name;
    }
    return null;
  })()`).catch(() => null);
  return tagged;
}

export async function dismissDraftRestore(session: BrowserPageSessionPort, journal?: AutonomousSurfaceJournalEntry[]): Promise<boolean> {
  const markers = JSON.stringify(DRAFT_RESTORE_MARKERS);
  // The wording also lives in dialogs the app keeps mounted but hidden. Acting on those clicked
  // discard on a perfectly healthy upload surface and tore the file input out from under the
  // upload step, which then found nothing at all. Only a VISIBLE prompt may be answered.
  const present = await session.evaluate<boolean>(`(() => {
    const markers = ${markers};
    const visible = (el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0; };
    const containers = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    return containers.some((container) => visible(container) && markers.some((marker) => (container.innerText || "").toLocaleLowerCase("en-US").includes(marker)));
  })()`).catch(() => false);
  if (!present) return false;
  try {
    const descriptor = await new BrowserDomUiDriver(session).click(DISCARD_CONFIRM_LABELS.map((label) => ({ kind: "role" as const, value: label })), 6_000, []);
    journal?.push({ at: new Date().toISOString(), stepKey: "DISCARD_STALE_DRAFT", action: "CLICK", outcome: "PASS", detail: descriptor });
    return true;
  } catch {
    journal?.push({ at: new Date().toISOString(), stepKey: "DISCARD_STALE_DRAFT", action: "CLICK", outcome: "SKIPPED", detail: "restore prompt present but no exact discard control" });
    return false;
  }
}

export async function discardPreparedDraft(session: BrowserPageSessionPort, journal?: AutonomousSurfaceJournalEntry[]): Promise<boolean> {
  const driver = new BrowserDomUiDriver(session);
  try {
    await driver.click([
      { kind: "role", value: "Schließen" },
      { kind: "role", value: "Close" },
      { kind: "css", value: '[role="dialog"] svg[aria-label="Schließen"]' },
      { kind: "css", value: '[role="dialog"] svg[aria-label="Close"]' }
    ], 4_000, []);
  } catch { return false; }
  try {
    const descriptor = await driver.click(DISCARD_CONFIRM_LABELS.map((label) => ({ kind: "role" as const, value: label })), 5_000, []);
    journal?.push({ at: new Date().toISOString(), stepKey: "DISCARD_DRAFT", action: "CLICK", outcome: "PASS", detail: descriptor });
    return true;
  } catch {
    journal?.push({ at: new Date().toISOString(), stepKey: "DISCARD_DRAFT", action: "CLICK", outcome: "SKIPPED", detail: "no discard confirmation appeared" });
    return false;
  }
}
