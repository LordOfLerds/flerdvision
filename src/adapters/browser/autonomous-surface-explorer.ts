import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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
import { surfaceExecutionBootstrapUrl } from "./surface-bootstrap.js";

export type AutonomousStepAction = "CLICK" | "SET_FILE" | "FILL_CAPTION" | "FILL_TITLE" | "FINAL_BOUNDARY";
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
  action: AutonomousStepAction;
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
  return [{ stepKey: "OPEN_UPLOAD", label: "Open upload flow", action: "CLICK", required: true, locators: [...named("button", ["Create", "Erstellen"]), ...named("button", ["Upload videos", "Videos hochladen"]), ...text(["Upload videos", "Videos hochladen"])] }];
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
  return unique([...named("button", ["Publish", "Veröffentlichen", "Save", "Speichern"]), ...text(["Publish", "Veröffentlichen"])]);
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
      const containers = [...document.querySelectorAll('[role="dialog"]')];
      const cookieHost = document.querySelector('tiktok-cookie-banner');
      if (cookieHost) containers.push(cookieHost);
      for (const container of containers) {
        const scope = container.shadowRoot ?? container;
        const text = normalize(scope.textContent || container.textContent).toLocaleLowerCase("en-US");
        if (forbid.some((word) => text.includes(word.toLocaleLowerCase("en-US")))) continue;
        if (scope.querySelector('input[type="file"], textarea, [contenteditable="true"]')) continue;
        const buttons = [...scope.querySelectorAll('button, [role="button"]')];
        const name = (el) => normalize(el.getAttribute("aria-label") || el.textContent);
        const confirm = buttons.find((el) => decline.has(name(el))) ?? buttons.find((el) => allow.has(name(el)));
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

  private async executeStep(step: AutonomousStep, intent: PublicationIntent, input: { mediaPath: string; caption?: string; title?: string }, artifactRefs: string[], journal: AutonomousSurfaceJournalEntry[]): Promise<{ locator: UiLocator; fallbacks: readonly UiLocator[] } | null> {
    const candidates = await this.locatorsFor(step, intent);
    const visibleOnly = step.action !== "SET_FILE";
    const selected = await this.workingLocator(candidates, visibleOnly, step.timeoutMs ?? 12_000);
    if (!selected) {
      const detail = `No safe locator found for ${step.stepKey}`;
      journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: step.required ? "FAIL" : "SKIPPED", detail });
      if (step.required) throw new Error(detail);
      return null;
    }
    const fallbacks = candidates.filter((locator) => locatorKey(locator) !== locatorKey(selected)).slice(0, 3);
    if (step.action === "CLICK") {
      try {
        await this.driver.click([selected], step.timeoutMs ?? 12_000, []);
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
    else if (step.action === "FILL_CAPTION") {
      if (input.caption === undefined) throw new Error("Caption payload is missing");
      await this.driver.fill([selected], input.caption, step.timeoutMs ?? 12_000);
    } else if (step.action === "FILL_TITLE") {
      if (input.title === undefined) throw new Error("Title payload is missing");
      await this.driver.fill([selected], input.title, step.timeoutMs ?? 12_000);
    } else {
      await this.driver.locate([selected], step.timeoutMs ?? 12_000, true);
    }
    const detail = `${selected.kind}:${selected.value}`;
    journal.push({ at: this.now(), stepKey: step.stepKey, action: step.action, outcome: "PASS", locator: selected, detail });
    artifactRefs.push(...await this.artifacts.captureBoundary(this.session, intent, { identityId: "surface-explorer", accountId: intent.accountId, platform: intent.platform, profileKey: "surface-explorer", expectedHandle: intent.accountId, enabled: true }, `autonomous-${step.stepKey.toLocaleLowerCase("en-US")}`, this.now()));
    if (step.action === "SET_FILE") await sleep(3000); else if (step.action !== "FINAL_BOUNDARY") await sleep(900);
    return { locator: selected, fallbacks };
  }

  async discoverAndPrepare(input: {
    intent: PublicationIntent;
    identity: BrowserIdentity;
    postingProfile: PostingProfile;
    mediaPath: string;
    caption?: string;
    title?: string;
  }): Promise<AutonomousSurfaceExplorationResult> {
    if (input.identity.accountId !== input.intent.accountId || input.identity.platform !== input.intent.platform) throw new Error("Surface exploration identity does not match intent");
    const journal: AutonomousSurfaceJournalEntry[] = [];
    const artifactRefs: string[] = [];
    const steps: SurfaceContractStep[] = [];
    await this.session.navigate(surfaceExecutionBootstrapUrl(input.postingProfile.platform));
    // A fixed settle is a race against the app's own boot: TikTok Studio's document was still a
    // 1.5 KB shell when exploration began, so nothing could be located at all. Wait until the
    // surface actually rendered interactive content, bounded, then settle briefly.
    for (let rendered = false, deadline = Date.now() + 25_000; !rendered && Date.now() < deadline; ) {
      rendered = await this.session.evaluate<boolean>(`document.querySelectorAll('button, [role="button"], input, a[href]').length > 3`).catch(() => false);
      if (!rendered) await sleep(500);
    }
    await sleep(1500);
    artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, "autonomous-bootstrap", this.now()));
    const environment = await this.recorder.environment(this.session);

    // First-run dialogs (enable-notifications on a fresh account, and friends) sit over the
    // create control before anything has been clicked at all. The post-upload dismissal cannot
    // help there; the TikTok-readiness review flagged exactly this wiring gap.
    await this.dismissBenignOverlay(journal);
    await dismissDraftRestore(this.session, journal);
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
      if (uploadReady && !step.required) {
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

    const final: AutonomousStep = { stepKey: "FINAL_ACTION", label: "Final publish boundary", action: "FINAL_BOUNDARY", required: true, locators: finalLocators(input.postingProfile), timeoutMs: 60_000 };
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
export async function dismissDraftRestore(session: BrowserPageSessionPort, journal?: AutonomousSurfaceJournalEntry[]): Promise<boolean> {
  const markers = JSON.stringify(DRAFT_RESTORE_MARKERS);
  const present = await session.evaluate<boolean>(`(() => { const text = (document.body && document.body.innerText || "").toLocaleLowerCase("en-US"); return ${markers}.some((marker) => text.includes(marker)); })()`).catch(() => false);
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
