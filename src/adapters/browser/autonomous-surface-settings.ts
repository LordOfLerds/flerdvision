import { setTimeout as sleep } from "node:timers/promises";
import { normalizeAutonomousSurfaceContract } from "../../application/autonomous-surface-contract.js";
import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { PostingProfile } from "../../domain/distribution.js";
import type { PublicationIntent } from "../../domain/model.js";
import type { PlatformSurfaceContract, SurfaceContractStep } from "../../domain/platform-surface.js";
import type { PrepareArtifactSinkPort } from "../../domain/platform-ui-ports.js";
import type { UiLocator } from "../../domain/platform-ui.js";
import type { SurfaceAgentPort, SurfaceAgentRequest } from "../../domain/surface-agent.js";
import { DEFAULT_AUDIO_INTEGRITY_POLICY, type AudioIntegrityPolicy } from "../../domain/audio-integrity.js";
import { assertOriginalAudio, AudioIntegrityViolationError } from "./audio-integrity-probe.js";
import { captureSemanticSurfaceSnapshot, type AutonomousSurfaceJournalEntry } from "./autonomous-surface-explorer.js";
import { BrowserDomUiDriver, UiActionExecutionError, UiTargetNotFoundError } from "./dom-ui-driver.js";

interface BooleanLocatorCandidate { locator: UiLocator; polarity: "DIRECT" | "INVERTED"; }
interface EnrichedContractResult { contract: PlatformSurfaceContract; artifactRefs: readonly string[]; journal: readonly AutonomousSurfaceJournalEntry[]; }

function role(roleName: string, names: readonly string[]): UiLocator[] { return names.map((value) => ({ kind: "role", role: roleName, value, exact: false })); }
function label(names: readonly string[]): UiLocator[] { return names.map((value) => ({ kind: "label", value, exact: false })); }
function text(names: readonly string[]): UiLocator[] { return names.map((value) => ({ kind: "text", value, exact: false })); }
function unique<T extends UiLocator>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => { const key = JSON.stringify(item); if (seen.has(key)) return false; seen.add(key); return true; });
}
function finalLocators(contract: PlatformSurfaceContract): readonly UiLocator[] {
  const final = contract.steps.at(-1);
  if (!final || final.stepKey !== "FINAL_ACTION") throw new Error("Autonomous settings require a contract ending at FINAL_ACTION");
  return [final.locator, ...final.fallbackLocators];
}
function polarityFrom(locator: UiLocator): "DIRECT" | "INVERTED" {
  const value = locator.value.toLocaleLowerCase("en-US");
  return /(?:turn off|disable|deaktiv|ausschalten|nicht erlauben|disallow)/.test(value) ? "INVERTED" : "DIRECT";
}
function booleanCandidates(direct: readonly string[], inverted: readonly string[] = []): BooleanLocatorCandidate[] {
  return [
    ...unique([...role("switch", direct), ...role("checkbox", direct), ...label(direct), ...text(direct)]).map((locator) => ({ locator, polarity: "DIRECT" as const })),
    ...unique([...role("switch", inverted), ...role("checkbox", inverted), ...label(inverted), ...text(inverted)]).map((locator) => ({ locator, polarity: "INVERTED" as const }))
  ];
}
function advancedLocators(): readonly UiLocator[] {
  const names = ["Advanced settings", "More options", "More settings", "Erweiterte Einstellungen", "Weitere Optionen", "Mehr Einstellungen"];
  return unique([...role("button", names), ...role("link", names), ...text(names)]);
}
function visibilityControlLocators(): readonly UiLocator[] {
  const names = ["Who can watch this video", "Who can view this post", "Visibility", "Sichtbarkeit", "Wer kann dieses Video ansehen?", "Wer kann diesen Beitrag sehen?"];
  // Live evidence (TikTok, 2026-08-31): the control is a combobox whose accessible name is its
  // CURRENT VALUE ("Alle"), while the question sits in a separate label element -- so a
  // question-only search could never find it. Its present setting identifies it just as well.
  const currentValues = ["Everyone", "Alle", "Public", "Öffentlich", "Friends", "Freunde", "Followers", "Follower", "Only you", "Nur du", "Private", "Privat", "Unlisted", "Nicht gelistet"];
  // Interactive candidates first: the plain question text is a label element, and clicking it
  // opened nothing at all while consuming the attempt -- the option search then found no list.
  // Structure before names: the value-named candidate answered a short probe and then failed a
  // full locate again and again -- matching by a name this surface rewrites constantly is a race,
  // while the element's role and tag stay put. The value readback still proves the right control.
  return unique([...role("combobox", names), ...role("button", names), { kind: "css", value: "select[name*=\"privacy\" i],select[name*=\"visibility\" i]" }, { kind: "css", value: "button[role=\"combobox\"]" }, ...role("combobox", currentValues), ...role("button", currentValues), ...label(names), ...text(names)]);
}
export function visibilityLabels(value: string): readonly string[] {
  if (value === "everyone" || value === "public") return ["Everyone", "Public", "Alle", "Öffentlich"];
  if (value === "friends") return ["Friends", "Freunde"];
  if (value === "followers") return ["Followers", "Follower"];
  if (value === "only_you" || value === "private") return ["Only you", "Private", "Nur du", "Privat"];
  if (value === "unlisted") return ["Unlisted", "Nicht gelistet"];
  return [value];
}

export class AutonomousSurfaceSettings {
  private readonly driver: BrowserDomUiDriver;
  private advancedOpened = false;
  constructor(
    private readonly session: BrowserPageSessionPort,
    private readonly artifacts: PrepareArtifactSinkPort,
    private readonly agent?: SurfaceAgentPort,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly audioPolicy: AudioIntegrityPolicy = DEFAULT_AUDIO_INTEGRITY_POLICY
  ) { this.driver = new BrowserDomUiDriver(session); }

  /**
   * Operator rule: an automatically published video keeps ITS OWN audio. This is the last moment
   * the qualification can read that state -- the compose surface is still live and still shows the
   * preview card that names the attached sound. Read-only and fail-closed: a sound that is not the
   * video's own ends the run with evidence for a human, and is never clicked away automatically.
   */
  private async guardOriginalAudio(input: { intent: PublicationIntent; identity: BrowserIdentity }, artifactRefs: string[], journal: AutonomousSurfaceJournalEntry[]): Promise<void> {
    try {
      const decision = await assertOriginalAudio(this.session, input.intent.platform, this.now(), this.audioPolicy);
      journal.push({ at: this.now(), stepKey: "AUDIO_INTEGRITY", action: "OBSERVE", outcome: decision.code === "CALIBRATION_GAP_RECORDED" ? "SKIPPED" : "PASS", detail: `${decision.code}: ${decision.message}` });
    } catch (error) {
      if (!(error instanceof AudioIntegrityViolationError)) throw error;
      journal.push({ at: this.now(), stepKey: "AUDIO_INTEGRITY", action: "OBSERVE", outcome: "FAIL", detail: `${error.decision.code}: ${error.decision.message}` });
      artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, "autonomous-audio-integrity-violation", this.now()).catch(() => []));
      artifactRefs.push(await this.artifacts.writeJournal(input.intent, journal, this.now()).catch(() => ""));
      throw error;
    }
  }

  private async firstPresent(locators: readonly UiLocator[], timeoutMs = 3000, visibleOnly = true): Promise<UiLocator | null> {
    const deadline = Date.now() + timeoutMs;
    const candidates = unique(locators);
    while (Date.now() <= deadline) {
      for (const locator of candidates) {
        try { await this.driver.locate([locator], 120, visibleOnly); return locator; }
        catch (error) { if (!(error instanceof UiTargetNotFoundError)) throw error; }
      }
      await sleep(120);
    }
    return null;
  }

  private async proposedLocators(intent: PublicationIntent, stepKey: string, builtIn: readonly UiLocator[]): Promise<readonly UiLocator[]> {
    if (!this.agent) return builtIn;
    const snapshot = await captureSemanticSurfaceSnapshot(this.session, { platform: intent.platform, format: intent.format, stepKey, capturedAt: this.now() });
    const request: SurfaceAgentRequest = {
      schemaVersion: 1,
      objective: "LOCATE_SAFE_UI_STEP",
      stepKey,
      action: "CLICK",
      safety: { finalActionMayBeLocated: true, finalActionMayBeInvoked: false, credentialsIncluded: false, inputValuesIncluded: false },
      builtInCandidates: [...builtIn],
      snapshot
    };
    const proposed = await this.agent.propose(request);
    return unique([...(proposed?.locators ?? []), ...builtIn]);
  }

  private async openAdvancedIfNeeded(intent: PublicationIntent, forbidden: readonly UiLocator[], artifactRefs: string[], journal: AutonomousSurfaceJournalEntry[]): Promise<SurfaceContractStep | null> {
    if (this.advancedOpened) return null;
    const candidates = await this.proposedLocators(intent, "ADVANCED_SETTINGS", advancedLocators());
    const selected = await this.firstPresent(candidates, 2000);
    if (!selected) return null;
    await this.driver.click([selected], 3000, forbidden);
    this.advancedOpened = true;
    journal.push({ at: this.now(), stepKey: "ADVANCED_SETTINGS", action: "CLICK", outcome: "PASS", locator: selected, detail: `${selected.kind}:${selected.value}` });
    return { stepKey: "ADVANCED_SETTINGS", label: "Open advanced settings", actionMode: "OBSERVE_ACTION", locator: selected, fallbackLocators: candidates.filter((item) => JSON.stringify(item) !== JSON.stringify(selected)).slice(0, 3), observations: 1 };
  }

  private async readBoolean(locator: UiLocator): Promise<boolean | null> {
    const target = await this.driver.locate([locator], 5000, true);
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;
    return await this.session.evaluate<boolean | null>(`(() => {
      let el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;
      if(el instanceof HTMLLabelElement){el=el.control||el.querySelector('input,[role="switch"],[role="checkbox"]')||el;}
      const nested=el.querySelector?.('input[type="checkbox"],input[type="radio"],[role="switch"],[role="checkbox"]');if(nested)el=nested;
      if(el instanceof HTMLInputElement&&(el.type==='checkbox'||el.type==='radio'))return el.checked;
      for(const name of ['aria-checked','aria-pressed','aria-selected']){const raw=el.getAttribute(name);if(raw==='true')return true;if(raw==='false')return false;}
      const state=(el.getAttribute('data-state')||'').toLocaleLowerCase('en-US');
      if(['checked','on','selected','active','enabled'].includes(state))return true;
      if(['unchecked','off','unselected','inactive','disabled'].includes(state))return false;
      return null;
    })()`);
  }

  private async ensureBoolean(input: {
    intent: PublicationIntent;
    identity: BrowserIdentity;
    stepKey: string;
    label: string;
    desired: boolean;
    candidates: readonly BooleanLocatorCandidate[];
    forbidden: readonly UiLocator[];
    artifactRefs: string[];
    journal: AutonomousSurfaceJournalEntry[];
    /**
     * True when the operator never wrote this setting in the spec and the desired value is only
     * a compiler default. The platform keeps removing choices from its compose surface; a control
     * that is absent there may be tolerated for a defaulted setting, but an explicit operator
     * demand for a control the surface cannot offer must keep failing.
     */
    optionalWhenAbsent?: boolean;
  }): Promise<SurfaceContractStep | null> {
    let candidates = input.candidates;
    let selectedEntry: BooleanLocatorCandidate | undefined;
    for (const entry of candidates) if (await this.firstPresent([entry.locator], 220)) { selectedEntry = entry; break; }
    if (!selectedEntry) {
      const proposed = await this.proposedLocators(input.intent, input.stepKey, candidates.map((entry) => entry.locator));
      candidates = proposed.map((locator) => ({ locator, polarity: polarityFrom(locator) }));
      for (const entry of candidates) if (await this.firstPresent([entry.locator], 220)) { selectedEntry = entry; break; }
    }
    if (!selectedEntry) {
      const advanced = await this.openAdvancedIfNeeded(input.intent, input.forbidden, input.artifactRefs, input.journal);
      if (advanced) {
        for (const entry of candidates) if (await this.firstPresent([entry.locator], 350)) { selectedEntry = entry; break; }
      }
    }
    if (!selectedEntry) {
      // A missing setting used to fail without a trace of what the page actually offered, which
      // made every such failure a guessing game. Capture the surface as it stood, then decide.
      input.artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, `autonomous-setting-${input.stepKey.toLocaleLowerCase("en-US")}-missing`, this.now()));
      if (input.optionalWhenAbsent) {
        input.journal.push({ at: this.now(), stepKey: input.stepKey, action: "CLICK", outcome: "SKIPPED", detail: `Control absent on the surface; setting was not operator-demanded, platform default applies` });
        return null;
      }
      throw new UiActionExecutionError(`Could not locate required setting ${input.stepKey}`);
    }
    const requestedControlState = selectedEntry.polarity === "INVERTED" ? !input.desired : input.desired;
    const before = await this.readBoolean(selectedEntry.locator);
    if (before === null) throw new UiActionExecutionError(`Cannot prove boolean state for ${input.stepKey}`);
    if (before !== requestedControlState) await this.driver.click([selectedEntry.locator], 5000, input.forbidden);
    const after = await this.readBoolean(selectedEntry.locator);
    if (after !== requestedControlState) throw new UiActionExecutionError(`Boolean readback failed for ${input.stepKey}: expected ${requestedControlState}, observed ${String(after)}`);
    const detail = `${input.stepKey}=${String(input.desired)} (${selectedEntry.polarity.toLocaleLowerCase("en-US")} control=${String(after)})`;
    input.journal.push({ at: this.now(), stepKey: input.stepKey, action: "CLICK", outcome: "PASS", locator: selectedEntry.locator, detail });
    input.artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, `autonomous-setting-${input.stepKey.toLocaleLowerCase("en-US")}`, this.now()));
    return {
      stepKey: input.stepKey,
      label: input.label,
      actionMode: "OBSERVE_ACTION",
      locator: selectedEntry.locator,
      fallbackLocators: candidates.map((entry) => entry.locator).filter((locator) => JSON.stringify(locator) !== JSON.stringify(selectedEntry!.locator)).slice(0, 3),
      observations: 1,
      booleanPolarity: selectedEntry.polarity
    };
  }

  private async readEnum(locator: UiLocator): Promise<string | null> {
    const target = await this.driver.locate([locator], 5000, true);
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;
    return await this.session.evaluate<string | null>(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;
      if(el instanceof HTMLSelectElement){const option=el.options[el.selectedIndex];return option?(option.value||option.textContent||'').trim():null;}
      for(const name of ['data-value','aria-valuetext','value']){const raw=el.getAttribute(name);if(raw&&raw.trim())return raw.trim();}
      const selected=el.querySelector('[aria-selected="true"],[data-state="checked"],[data-state="selected"]');
      if(selected&&selected.textContent?.trim())return selected.textContent.trim();
      return el.textContent?.trim()||null;
    })()`);
  }

  private normalized(value: unknown): string { return String(value ?? "").trim().toLocaleLowerCase("en-US").replace(/[_-]+/g, " ").replace(/\s+/g, " "); }

  /** Answers YouTube's mandatory audience question exactly as the operator declared it. */
  private async ensureAudience(input: {
    intent: PublicationIntent;
    identity: BrowserIdentity;
    madeForKids: boolean;
    forbidden: readonly UiLocator[];
    artifactRefs: string[];
    journal: AutonomousSurfaceJournalEntry[];
  }): Promise<SurfaceContractStep> {
    const names = input.madeForKids
      ? ["Ja, es ist speziell für Kinder", "Yes, it's made for kids"]
      : ["Nein, es ist nicht speziell für Kinder", "No, it's not made for kids"];
    const candidates = unique([...role("radio", names), ...role("menuitemradio", names), ...text(names)]);
    const selected = await this.firstPresent(candidates, 8000);
    if (!selected) throw new UiActionExecutionError(`Could not locate the made-for-kids option "${names[0]}"`);
    await this.driver.click([selected], 8000, input.forbidden);
    await sleep(600);
    const confirmed = await this.session.evaluate<boolean>(`(() => {
      const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
      const wanted = new Set(${JSON.stringify(names.map((name) => name.toLocaleLowerCase("en-US")))});
      return Array.from(document.querySelectorAll('[role="radio"], input[type="radio"]')).some((element) => {
        const label = norm(element.getAttribute("aria-label")) || norm(element.closest("label")?.textContent) || norm(element.parentElement?.textContent);
        if (!wanted.has(label)) return false;
        return element.getAttribute("aria-checked") === "true" || element.checked === true;
      });
    })()`).catch(() => false);
    if (!confirmed) throw new UiActionExecutionError(`Made-for-kids declaration did not take: expected "${names[0]}"`);
    input.journal.push({ at: this.now(), stepKey: "AUDIENCE", action: "CLICK", outcome: "PASS", locator: selected, detail: `madeForKids=${String(input.madeForKids)}` });
    input.artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, "autonomous-setting-audience", this.now()));
    return { stepKey: "AUDIENCE", label: "Made-for-kids declaration", actionMode: "OBSERVE_ACTION", locator: selected, fallbackLocators: candidates.filter((locator) => JSON.stringify(locator) !== JSON.stringify(selected)).slice(0, 3), observations: 1 };
  }

  private async ensureVisibility(input: {
    intent: PublicationIntent;
    identity: BrowserIdentity;
    expected: string;
    forbidden: readonly UiLocator[];
    artifactRefs: string[];
    journal: AutonomousSurfaceJournalEntry[];
  }): Promise<SurfaceContractStep> {
    // Some surfaces expose visibility as radio buttons rather than a select: YouTube's last
    // wizard screen lists Öffentlich / Nicht gelistet / Privat, and the combobox search settled
    // on the section heading, whose text ("Sichtbarkeit") then failed the value readback.
    const wantedForRadio = visibilityLabels(input.expected);
    const radioCandidates = unique([...role("radio", wantedForRadio), ...role("menuitemradio", wantedForRadio)]);
    let recordedRadio: UiLocator | null = null;
    let radio = await this.firstPresent(radioCandidates, 2500);
    if (!radio) {
      // Studio renders its options as custom elements (tp-yt-paper-radio-button), which carry no
      // usable role: the role search found nothing and the combobox fallback then read the
      // section heading as the value. Tag the visible option that carries the exact label.
      const tagged = await this.session.evaluate<string | null>(`(() => {
        const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
        const wanted = new Set(${JSON.stringify(wantedForRadio.map((label) => label.toLocaleLowerCase("en-US")))});
        for (const previous of Array.from(document.querySelectorAll('[data-flerdvision-visibility]'))) previous.removeAttribute('data-flerdvision-visibility');
        const candidates = Array.from(document.querySelectorAll('tp-yt-paper-radio-button, [role="radio"], input[type="radio"], label, div'));
        for (const candidate of candidates) {
          // The label a person reads is the rendered text; aria-label and the element's name
          // attribute ("PRIVATE") only decide the match when no visible wording exists.
          const shown = (candidate.textContent || "").replace(/\\s+/g, " ").trim();
          const attr = (candidate.getAttribute("aria-label") || candidate.getAttribute("name") || "").replace(/\\s+/g, " ").trim();
          const raw = wanted.has(norm(shown)) ? shown : attr;
          const name = norm(raw);
          if (!wanted.has(name)) continue;
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
          candidate.setAttribute('data-flerdvision-visibility', '1');
          return raw;
        }
        return null;
      })()`).catch(() => null);
      if (tagged !== null) {
        radio = { kind: "css", value: '[data-flerdvision-visibility="1"]' };
        // The marker pins the option in THIS page only; a replay opens a fresh dialog and must
        // find the option by its label -- the label as the page renders it ("Privat"), not the
        // first entry of the candidate list ("Only you"), which once sent a replay looking for a
        // word Studio never shows.
        recordedRadio = { kind: "text", value: tagged, exact: true };
      }
    }
    if (radio) {
      await this.driver.click([radio], 5000, input.forbidden);
      await sleep(600);
      const checked = await this.session.evaluate<boolean>(`(() => {
        const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
        const wanted = new Set(${JSON.stringify(wantedForRadio.map((label) => label.toLocaleLowerCase("en-US")))});
        return Array.from(document.querySelectorAll('tp-yt-paper-radio-button, [role="radio"], input[type="radio"]')).some((element) => {
          const label = norm(element.getAttribute("aria-label")) || norm(element.getAttribute("name")) || norm(element.closest("label")?.textContent) || norm(element.textContent) || norm(element.parentElement?.textContent);
          if (!wanted.has(label)) return false;
          return element.getAttribute("aria-checked") === "true" || element.getAttribute("checked") !== null || element.checked === true;
        });
      })()`).catch(() => false);
      if (!checked) throw new UiActionExecutionError(`Visibility readback failed: expected ${input.expected} to be selected`);
      input.journal.push({ at: this.now(), stepKey: "VISIBILITY", action: "CLICK", outcome: "PASS", locator: radio, detail: `visibility=${input.expected}` });
      input.artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, "autonomous-setting-visibility", this.now()));
      return { stepKey: "VISIBILITY", label: "Visibility setting", actionMode: "OBSERVE_ACTION", locator: recordedRadio ?? radio, fallbackLocators: unique([...text(wantedForRadio), ...radioCandidates]).filter((locator) => JSON.stringify(locator) !== JSON.stringify(recordedRadio ?? radio)).slice(0, 10), observations: 1 };
    }
    let candidates = await this.proposedLocators(input.intent, "VISIBILITY", visibilityControlLocators());
    let selected = await this.firstPresent(candidates, 3000);
    if (!selected) {
      await this.openAdvancedIfNeeded(input.intent, input.forbidden, input.artifactRefs, input.journal);
      selected = await this.firstPresent(candidates, 3000);
    }
    if (!selected) throw new UiActionExecutionError("Could not locate required visibility setting");
    // The control that answered the probe can be gone a moment later: this surface re-renders
    // its settings section constantly, and a candidate chosen with a short probe then failed a
    // full five-second locate. Re-resolve across the whole candidate list before giving up.
    let target = await this.driver.locate([selected], 5000, true).catch(async (error: unknown) => {
      const refreshed = await this.firstPresent(candidates, 5000);
      if (!refreshed) throw error;
      selected = refreshed;
      return await this.driver.locate([refreshed], 5000, true);
    });
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;
    const native = await this.session.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) instanceof HTMLSelectElement`);
    const wantedLabels = visibilityLabels(input.expected);
    const wanted = new Set([input.expected, ...wantedLabels].map((item) => this.normalized(item)));
    let current = await this.readEnum(selected);
    if (!wanted.has(this.normalized(current))) {
      if (native) {
        const values = [...wanted];
        const changed = await this.session.evaluate<boolean>(`(() => {
          const el=document.querySelector(${JSON.stringify(selector)});if(!(el instanceof HTMLSelectElement))return false;
          const norm=v=>String(v||'').trim().toLocaleLowerCase('en-US').replace(/[_-]+/g,' ').replace(/\\s+/g,' '),wanted=new Set(${JSON.stringify(values)});
          const option=Array.from(el.options).find(o=>wanted.has(norm(o.value))||wanted.has(norm(o.textContent)));if(!option)return false;
          el.value=option.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;
        })()`);
        if (!changed) throw new UiActionExecutionError(`Visibility option ${input.expected} is unavailable`);
      } else {
        await this.driver.click([selected], 5000, input.forbidden);
        const optionLocators = unique([...role("option", wantedLabels), ...role("menuitemradio", wantedLabels), ...role("radio", wantedLabels), ...text(wantedLabels)]);
        const option = await this.firstPresent(optionLocators, 5000);
        if (!option) throw new UiActionExecutionError(`Visibility option ${input.expected} could not be located`);
        await this.driver.click([option], 5000, input.forbidden);
      }
      await sleep(500);
      current = await this.readEnum(selected);
    }
    if (!wanted.has(this.normalized(current))) throw new UiActionExecutionError(`Visibility readback failed: expected ${input.expected}, observed ${String(current)}`);
    input.journal.push({ at: this.now(), stepKey: "VISIBILITY", action: "CLICK", outcome: "PASS", locator: selected, detail: `visibility=${input.expected}` });
    input.artifactRefs.push(...await this.artifacts.captureBoundary(this.session, input.intent, input.identity, "autonomous-setting-visibility", this.now()));
    return { stepKey: "VISIBILITY", label: "Visibility setting", actionMode: "OBSERVE_ACTION", locator: selected, fallbackLocators: candidates.filter((locator) => JSON.stringify(locator) !== JSON.stringify(selected)).slice(0, 3), observations: 1 };
  }

  async enrich(input: { contract: PlatformSurfaceContract; intent: PublicationIntent; identity: BrowserIdentity; postingProfile: PostingProfile }): Promise<EnrichedContractResult> {
    const forbidden = finalLocators(input.contract);
    const artifactRefs: string[] = [];
    const journal: AutonomousSurfaceJournalEntry[] = [];
    const settings: SurfaceContractStep[] = [];
    const addAdvancedFromJournal = () => {
      if (!this.advancedOpened || settings.some((step) => step.stepKey === "ADVANCED_SETTINGS")) return;
      const entry = journal.find((item) => item.stepKey === "ADVANCED_SETTINGS" && item.locator);
      if (entry?.locator) settings.push({ stepKey: "ADVANCED_SETTINGS", label: "Open advanced settings", actionMode: "OBSERVE_ACTION", locator: entry.locator, fallbackLocators: [], observations: 1 });
    };

    // Absent explicitSettings (older compiled configs) means unknown, treated as explicit.
    const explicit = (key: string): boolean => input.postingProfile.explicitSettings === undefined || input.postingProfile.explicitSettings.includes(key);
    const push = (step: SurfaceContractStep | null) => { if (step) settings.push(step); };
    if (input.postingProfile.platform === "instagram" && input.postingProfile.format !== "story") {
      if (input.postingProfile.format === "trial_reel") push(await this.ensureBoolean({ intent: input.intent, identity: input.identity, stepKey: "TRIAL_MODE", label: "Trial Reel mode", desired: true, candidates: booleanCandidates(["Trial reel", "Trial", "Test-Reel", "Test reel"]), forbidden, artifactRefs, journal }));
      push(await this.ensureBoolean({ intent: input.intent, identity: input.identity, stepKey: "SHARE_TO_FEED", label: "Share to feed setting", desired: input.postingProfile.shareToFeed, candidates: booleanCandidates(["Also share to feed", "Share to feed", "Im Feed teilen", "Auch im Feed teilen"]), forbidden, artifactRefs, journal , optionalWhenAbsent: !explicit("shareToFeed") }));
      push(await this.ensureBoolean({ intent: input.intent, identity: input.identity, stepKey: "CROSSPOST_FACEBOOK", label: "Facebook cross-post setting", desired: input.postingProfile.crosspostFacebook, candidates: booleanCandidates(["Share to Facebook", "Recommend on Facebook", "Auf Facebook teilen", "Auf Facebook empfehlen"]), forbidden, artifactRefs, journal , optionalWhenAbsent: !explicit("crosspostFacebook") }));
      push(await this.ensureBoolean({ intent: input.intent, identity: input.identity, stepKey: "COMMENTS", label: "Comments setting", desired: input.postingProfile.commentsEnabled, candidates: booleanCandidates(["Allow comments", "Kommentare erlauben"], ["Turn off commenting", "Disable comments", "Kommentare deaktivieren"]), forbidden, artifactRefs, journal , optionalWhenAbsent: !explicit("commentsEnabled") }));
    } else if (input.postingProfile.platform === "tiktok") {
      settings.push(await this.ensureVisibility({ intent: input.intent, identity: input.identity, expected: input.postingProfile.visibility, forbidden, artifactRefs, journal }));
      push(await this.ensureBoolean({ intent: input.intent, identity: input.identity, stepKey: "COMMENTS", label: "Comments setting", desired: input.postingProfile.commentsEnabled, candidates: booleanCandidates(["Allow comments", "Comments", "Kommentare erlauben", "Kommentare"]), forbidden, artifactRefs, journal , optionalWhenAbsent: !explicit("commentsEnabled") }));
      push(await this.ensureBoolean({ intent: input.intent, identity: input.identity, stepKey: "DUET", label: "Duet setting", desired: input.postingProfile.duetEnabled, candidates: booleanCandidates(["Allow Duet", "Duet", "Duett erlauben", "Duett"]), forbidden, artifactRefs, journal , optionalWhenAbsent: !explicit("duetEnabled") }));
      push(await this.ensureBoolean({ intent: input.intent, identity: input.identity, stepKey: "STITCH", label: "Stitch setting", desired: input.postingProfile.stitchEnabled, candidates: booleanCandidates(["Allow Stitch", "Stitch", "Stitch erlauben"]), forbidden, artifactRefs, journal , optionalWhenAbsent: !explicit("stitchEnabled") }));
    } else if (input.postingProfile.platform === "youtube") {
      // Studio's mandatory audience question blocks the entire wizard until it is answered, and
      // it is a legal statement about the content -- so it comes from the operator's spec or the
      // run stops here instead of quietly declaring something on their behalf.
      // The declaration is answered during exploration -- the wizard cannot be walked without it
      // -- so here it is only re-asserted when the surface still offers it unanswered.
      const madeForKids = input.postingProfile.madeForKids;
      if (madeForKids === undefined) throw new UiActionExecutionError("YouTube requires the made-for-kids declaration: set settings.madeForKids in the canonical spec");
      if (!input.contract.steps.some((step) => step.stepKey === "AUDIENCE")) {
        settings.push(await this.ensureAudience({ intent: input.intent, identity: input.identity, madeForKids, forbidden, artifactRefs, journal }));
      }
      settings.push(await this.ensureVisibility({ intent: input.intent, identity: input.identity, expected: input.postingProfile.visibility, forbidden, artifactRefs, journal }));
    }
    addAdvancedFromJournal();
    // Runs after every setting has been applied, so the audio state observed here is the state the
    // sealed contract will be replayed towards.
    await this.guardOriginalAudio(input, artifactRefs, journal);
    const final = input.contract.steps.at(-1)!;
    const base = input.contract.steps.slice(0, -1).filter((step) => !settings.some((setting) => setting.stepKey === step.stepKey));
    artifactRefs.push(await this.artifacts.writeJournal(input.intent, journal, this.now()));
    const enriched: PlatformSurfaceContract = { ...input.contract, steps: [...base, ...settings, final] };
    return { contract: normalizeAutonomousSurfaceContract(enriched, input.postingProfile), artifactRefs, journal };
  }
}
