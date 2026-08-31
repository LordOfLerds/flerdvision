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
  return unique([...role("combobox", names), ...role("button", names), ...role("combobox", currentValues), ...role("button", currentValues), { kind: "css", value: "select[name*=\"privacy\" i],select[name*=\"visibility\" i]" }, ...label(names), ...text(names)]);
}
function visibilityLabels(value: string): readonly string[] {
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
    private readonly now: () => string = () => new Date().toISOString()
  ) { this.driver = new BrowserDomUiDriver(session); }

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

  private async ensureVisibility(input: {
    intent: PublicationIntent;
    identity: BrowserIdentity;
    expected: string;
    forbidden: readonly UiLocator[];
    artifactRefs: string[];
    journal: AutonomousSurfaceJournalEntry[];
  }): Promise<SurfaceContractStep> {
    let candidates = await this.proposedLocators(input.intent, "VISIBILITY", visibilityControlLocators());
    let selected = await this.firstPresent(candidates, 3000);
    if (!selected) {
      await this.openAdvancedIfNeeded(input.intent, input.forbidden, input.artifactRefs, input.journal);
      selected = await this.firstPresent(candidates, 3000);
    }
    if (!selected) throw new UiActionExecutionError("Could not locate required visibility setting");
    const target = await this.driver.locate([selected], 5000, true);
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
      settings.push(await this.ensureVisibility({ intent: input.intent, identity: input.identity, expected: input.postingProfile.visibility, forbidden, artifactRefs, journal }));
    }
    addAdvancedFromJournal();
    const final = input.contract.steps.at(-1)!;
    const base = input.contract.steps.slice(0, -1).filter((step) => !settings.some((setting) => setting.stepKey === step.stepKey));
    artifactRefs.push(await this.artifacts.writeJournal(input.intent, journal, this.now()));
    const enriched: PlatformSurfaceContract = { ...input.contract, steps: [...base, ...settings, final] };
    return { contract: normalizeAutonomousSurfaceContract(enriched, input.postingProfile), artifactRefs, journal };
  }
}
