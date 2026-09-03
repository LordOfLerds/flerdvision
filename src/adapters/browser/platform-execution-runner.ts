import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { PlatformExecutionAction, PlatformExecutionPlan } from "../../domain/platform-execution.js";
import type { PrepareArtifactSinkPort } from "../../domain/platform-ui-ports.js";
import type { UiLocator } from "../../domain/platform-ui.js";
import { DEFAULT_AUDIO_INTEGRITY_POLICY, type AudioIntegrityDecision, type AudioIntegrityPolicy } from "../../domain/audio-integrity.js";
import { assertOriginalAudio, AudioIntegrityViolationError } from "./audio-integrity-probe.js";
import { BrowserCalibrationRecorder } from "./calibration-recorder.js";
import { BrowserDomUiDriver, UiActionExecutionError } from "./dom-ui-driver.js";
import { humanPacing, type HumanPacing } from "./human-pacing.js";
import { beginScreencast } from "./screencast-recorder.js";
import { visibilityLabels } from "./autonomous-surface-settings.js";
import { surfaceExecutionBootstrapUrl } from "./surface-bootstrap.js";

export interface SafePlatformExecutionInput {
  mediaPath:string;
  caption?:string;
  title?:string;
}
interface SafeExecutionJournalEntry {stepKey:string;operation:string;outcome:"PASS"|"FAIL";detail:string;}
export interface SafePlatformExecutionResult {
  reachedFinalActionBoundary:true;
  finalActionInvoked:false;
  environmentFingerprint:string;
  artifactRefs:readonly string[];
  journal:readonly SafeExecutionJournalEntry[];
}

function normalized(value:unknown):string{return String(value??"").trim().toLocaleLowerCase("en-US").replace(/[_-]+/g," ").replace(/\s+/g," ");}
function selectorFor(token:string):string{return`[data-flerdvision-node=${JSON.stringify(token)}]`;}

/** Executes a SurfaceContract-derived plan and physically stops before the irreversible action. */
export class SafePlatformExecutionRunner {
  private readonly driver:BrowserDomUiDriver;
  private readonly recorder=new BrowserCalibrationRecorder();
  private readonly now:()=>string;
  private pacing:HumanPacing|undefined;
  constructor(
    private readonly session:BrowserPageSessionPort,
    private readonly artifacts:PrepareArtifactSinkPort,
    now:()=>string=()=>new Date().toISOString(),
    private readonly audioPolicy:AudioIntegrityPolicy=DEFAULT_AUDIO_INTEGRITY_POLICY
  ){this.driver=new BrowserDomUiDriver(session);this.now=now;}

  /**
   * Original-audio integrity at the last point before anything irreversible can be invoked: the
   * retained prepared session a live publish reuses is exactly the session that stops here. The
   * probe is read-only; a sound that is not the video's own throws with the boundary evidence and
   * the journal already written, and is never clicked away automatically.
   */
  private async guardOriginalAudio(plan:PlatformExecutionPlan,identity:BrowserIdentity,journal:SafeExecutionJournalEntry[],artifactRefs:string[]):Promise<AudioIntegrityDecision>{
    try{
      return await assertOriginalAudio(this.session,plan.intent.platform,this.now(),this.audioPolicy);
    }catch(error){
      if(!(error instanceof AudioIntegrityViolationError))throw error;
      journal.push({stepKey:"AUDIO_INTEGRITY",operation:"OBSERVE",outcome:"FAIL",detail:`${error.decision.code}: ${error.decision.message}`});
      artifactRefs.push(...await this.artifacts.captureBoundary(this.session,plan.intent,identity,"surface-execution-audio-integrity-violation",this.now()).catch(()=>[]));
      artifactRefs.push(await this.artifacts.writeJournal(plan.intent,journal,this.now()).catch(()=>""));
      throw error;
    }
  }
  private pause():Promise<void>{const ms=this.pacing?.stepPauseMs()??0;return ms>0?new Promise((resolvePause)=>setTimeout(resolvePause,ms)):Promise.resolve();}

  private finalLocators(plan:PlatformExecutionPlan):readonly UiLocator[]{
    const final=plan.actions.at(-1);
    if(!final||final.operation!=="FINAL_BOUNDARY")throw new UiActionExecutionError("Execution plan does not terminate at FINAL_BOUNDARY");
    return final.locators;
  }

  private async readBoolean(locators:readonly UiLocator[]):Promise<boolean|null>{
    const target=await this.driver.locate(locators,10_000,true),selector=selectorFor(target.token);
    return await this.session.evaluate<boolean|null>(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;
      if(el instanceof HTMLInputElement&&(el.type==='checkbox'||el.type==='radio'))return el.checked;
      for(const name of ['aria-checked','aria-pressed']){const raw=el.getAttribute(name);if(raw==='true')return true;if(raw==='false')return false;}
      const state=(el.getAttribute('data-state')||'').toLowerCase();
      if(['checked','on','selected','active','enabled'].includes(state))return true;
      if(['unchecked','off','unselected','inactive','disabled'].includes(state))return false;
      return null;
    })()`);
  }

  private async ensureBoolean(action:PlatformExecutionAction,expected:boolean,finalLocators:readonly UiLocator[]):Promise<string>{
    // Operator provenance, same rule the exploration follows: a setting the canonical spec never
    // asked for carries the platform's default, so a control that cannot be proven is not a
    // failure. A demanded setting still fails loudly -- that is the whole point of demanding it.
    const optional=action.operatorDemanded===false;
    const before=await this.readBoolean(action.locators).catch((error:unknown)=>{ if(optional)return null; throw error; });
    if(before===null){
      if(optional)return`${action.stepKey}=platform-default`;
      throw new UiActionExecutionError(`Cannot prove boolean state for ${action.stepKey}`);
    }
    if(before!==expected)await this.driver.click(action.locators,10_000,finalLocators);
    const after=await this.readBoolean(action.locators);
    if(after!==expected){
      if(optional)return`${action.stepKey}=platform-default`;
      throw new UiActionExecutionError(`Boolean readback failed for ${action.stepKey}: expected ${expected}, observed ${String(after)}`);
    }
    return`${action.stepKey}=${String(after)}`;
  }

  private async readEnum(locators:readonly UiLocator[]):Promise<string|null>{
    const target=await this.driver.locate(locators,10_000,true),selector=selectorFor(target.token);
    return await this.session.evaluate<string|null>(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;
      if(el instanceof HTMLSelectElement){const option=el.options[el.selectedIndex];return option?(option.value||option.textContent||'').trim():null;}
      for(const name of ['data-value','aria-valuetext','value']){const raw=el.getAttribute(name);if(raw&&raw.trim())return raw.trim();}
      const selected=el.querySelector('[aria-selected="true"],[data-state="checked"],[data-state="selected"]');
      if(selected&&selected.textContent?.trim())return selected.textContent.trim();
      // Last resort: the control shows its current value as plain text, which is how a person
      // reads it. TikTok's visibility button does exactly that -- every attribute-based read
      // returned nothing and the readback failed on a setting that had in fact been applied.
      const own=(el.textContent||'').trim();
      if(own&&own.length<=40)return own;
      return null;
    })()`);
  }

  private async selectEnum(action:PlatformExecutionAction,expected:string,finalLocators:readonly UiLocator[]):Promise<string>{
    const wanted=normalized(expected),target=await this.driver.locate(action.locators,10_000,true),selector=selectorFor(target.token);
    const native=await this.session.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) instanceof HTMLSelectElement`);
    if(native){
      const changed=await this.session.evaluate<boolean>(`(() => {
        const el=document.querySelector(${JSON.stringify(selector)});if(!(el instanceof HTMLSelectElement))return false;
        const norm=v=>String(v||'').trim().toLocaleLowerCase('en-US').replace(/[_-]+/g,' ').replace(/\\s+/g,' ');
        const wanted=${JSON.stringify(wanted)};const option=Array.from(el.options).find(o=>norm(o.value)===wanted||norm(o.textContent)===wanted);if(!option)return false;
        el.value=option.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;
      })()`);
      if(!changed)throw new UiActionExecutionError(`Enum option ${expected} is not available for ${action.stepKey}`);
    }else{
      // A platform shows the option in ITS language ("Nur du" for only_you) and renders the list
      // only after the click: comparing against the raw contract value with one immediate look
      // could never succeed, so replays failed on a setting exploration had just applied.
      const accepted=[wanted,...visibilityLabels(String(expected)).map(normalized)];
      const current=await this.readEnum(action.locators);
      if(!accepted.includes(normalized(current))){
        await this.driver.click(action.locators,10_000,finalLocators);
        const pick=async():Promise<boolean>=>await this.session.evaluate<boolean>(`(() => {
          const norm=v=>String(v||'').trim().toLocaleLowerCase('en-US').replace(/[_-]+/g,' ').replace(/\\s+/g,' '),wanted=new Set(${JSON.stringify(accepted)});
          const candidates=Array.from(document.querySelectorAll('[role="option"],option,[data-value]'));
          const option=candidates.find(el=>wanted.has(norm(el.getAttribute('data-value')))||wanted.has(norm(el.getAttribute('value')))||wanted.has(norm(el.textContent)));
          if(!option)return false;option.click();return true;
        })()`);
        let selected=false;
        for(const deadline=Date.now()+8_000;!selected&&Date.now()<deadline;){
          selected=await pick();
          if(!selected)await new Promise((resolvePoll)=>setTimeout(resolvePoll,400));
        }
        if(!selected)throw new UiActionExecutionError(`Cannot safely locate enum option ${expected} for ${action.stepKey}`);
      }
    }
    const after=await this.readEnum(action.locators);
    // The readback sees the localized label too, so it must accept the same set the selection did.
    const acceptedAfter=new Set([wanted,...visibilityLabels(String(expected)).map(normalized)]);
    if(!acceptedAfter.has(normalized(after)))throw new UiActionExecutionError(`Enum readback failed for ${action.stepKey}: expected ${expected}, observed ${after??"UNKNOWN"}`);
    return`${action.stepKey}=${after}`;
  }

  /**
   * A replay is the leg a human later has to judge -- did the surface behave the way the
   * contract says? An optional screencast of it lands next to this run's screenshots and in the
   * same artifact list. It is recorded fail-open and can never affect the execution itself.
   */
  async execute(plan:PlatformExecutionPlan,identity:BrowserIdentity,input:SafePlatformExecutionInput):Promise<SafePlatformExecutionResult>{
    const artifactRefs:string[]=[];
    const recording=await beginScreencast(this.session,this.artifacts.recordingDirectory?.(plan.intent),`screencast-surface-replay-${plan.intent.platform}`);
    try{
      return await this.executeInternal(plan,identity,input,artifactRefs);
    }finally{
      // The returned result holds this very array, so a late push still reaches the caller.
      const recorded=await recording?.stop();
      if(recorded)artifactRefs.push(recorded);
    }
  }

  private async executeInternal(plan:PlatformExecutionPlan,identity:BrowserIdentity,input:SafePlatformExecutionInput,artifactRefs:string[]):Promise<SafePlatformExecutionResult>{
    if(identity.accountId!==plan.intent.accountId||identity.platform!==plan.intent.platform)throw new UiActionExecutionError("Execution identity does not match plan account/platform");
    const finalLocators=this.finalLocators(plan),journal:SafeExecutionJournalEntry[]=[];
    // The replay must start on the exact page the exploration recorded its contract from; see
    // surfaceExecutionBootstrapUrl for why a divergent bootstrap can never replay on TikTok.
    await this.session.navigate(surfaceExecutionBootstrapUrl(plan.intent.platform));
    // The fingerprint pins layout-affecting metrics (viewport, scale) alongside language, time
    // zone and browser major. Window size and target display are not deterministic across
    // launches (the live prepare leg drifted against its own qualification minutes earlier), so
    // the executor establishes the contract's recorded metrics via emulation before judging.
    // Language/timezone/browser drift still fails: those cannot and must not be emulated away.
    if(plan.environment&&this.session.setViewport)await this.session.setViewport({width:plan.environment.viewportWidth,height:plan.environment.viewportHeight,deviceScaleFactor:plan.environment.deviceScaleFactor});
    const environment=await this.recorder.environment(this.session);
    if(environment.fingerprint!==plan.environmentFingerprint)throw new UiActionExecutionError(`Surface environment drift before execution: expected ${plan.environmentFingerprint}, observed ${environment.fingerprint}`);
    artifactRefs.push(...await this.artifacts.captureBoundary(this.session,plan.intent,identity,"surface-execution-bootstrap",this.now()));
    // Human pacing, seeded per intent: fake sessions (no trusted input channel) keep the old
    // instant behaviour so unit fixtures stay fast and exact.
    const pacing=this.session.insertText?humanPacing(plan.intent.intentId):undefined;
    if(pacing)this.pacing=pacing;
    (this.driver as unknown as {pacing:HumanPacing|undefined}).pacing=pacing;
    for(const action of plan.actions){
      let detail:string;
      await this.pause();
      if(action.operation==="FINAL_BOUNDARY"){
        const breath=this.pacing;
        if(breath)await new Promise((resolveBreath)=>setTimeout(resolveBreath,breath.preFinalPauseMs()));
        detail=(await this.driver.locate(action.locators,10_000,true)).descriptor;
        journal.push({stepKey:action.stepKey,operation:action.operation,outcome:"PASS",detail});
        artifactRefs.push(...await this.artifacts.captureBoundary(this.session,plan.intent,identity,"surface-execution-final-boundary",this.now()));
        const audio=await this.guardOriginalAudio(plan,identity,journal,artifactRefs);
        journal.push({stepKey:"AUDIO_INTEGRITY",operation:"OBSERVE",outcome:"PASS",detail:`${audio.code}: ${audio.message}`});
        artifactRefs.push(await this.artifacts.writeJournal(plan.intent,journal,this.now()));
        return{reachedFinalActionBoundary:true,finalActionInvoked:false,environmentFingerprint:environment.fingerprint,artifactRefs,journal};
      }
      if(action.operation==="CLICK")detail=await this.driver.click(action.locators,10_000,finalLocators);
      else if(action.operation==="SET_MEDIA")detail=await this.driver.setFile(action.locators,input.mediaPath,10_000);
      else if(action.operation==="FILL_CAPTION"){
        if(input.caption===undefined)throw new UiActionExecutionError(`Caption is required for ${action.stepKey}`);
        detail=await this.driver.fill(action.locators,input.caption,10_000);
      }else if(action.operation==="FILL_TITLE"){
        if(input.title===undefined)throw new UiActionExecutionError(`Title is required for ${action.stepKey}`);
        detail=await this.driver.fill(action.locators,input.title,10_000);
      }else if(action.operation==="ENSURE_BOOLEAN"){
        if(typeof action.expectedValue!=="boolean")throw new UiActionExecutionError(`Boolean action ${action.stepKey} has no boolean expectedValue`);
        detail=await this.ensureBoolean(action,action.expectedValue,finalLocators);
      }else if(action.operation==="SELECT_ENUM"){
        if(typeof action.expectedValue!=="string")throw new UiActionExecutionError(`Enum action ${action.stepKey} has no string expectedValue`);
        detail=await this.selectEnum(action,action.expectedValue,finalLocators);
      }else throw new UiActionExecutionError(`Unsupported execution operation: ${action.operation}`);
      journal.push({stepKey:action.stepKey,operation:action.operation,outcome:"PASS",detail});
    }
    throw new UiActionExecutionError("Execution plan ended without FINAL_BOUNDARY");
  }
}
