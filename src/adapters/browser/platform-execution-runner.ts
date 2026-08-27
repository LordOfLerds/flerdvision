import type { BrowserIdentity } from "../../domain/browser-identity.js";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { PlatformExecutionAction, PlatformExecutionPlan } from "../../domain/platform-execution.js";
import type { PrepareArtifactSinkPort } from "../../domain/platform-ui-ports.js";
import type { UiLocator } from "../../domain/platform-ui.js";
import { BrowserCalibrationRecorder } from "./calibration-recorder.js";
import { BrowserDomUiDriver, UiActionExecutionError } from "./dom-ui-driver.js";

export interface SafePlatformExecutionInput {
  mediaPath:string;
  caption?:string;
  title?:string;
}
interface SafeExecutionJournalEntry {stepKey:string;operation:string;outcome:"PASS";detail:string;}
export interface SafePlatformExecutionResult {
  reachedFinalActionBoundary:true;
  finalActionInvoked:false;
  environmentFingerprint:string;
  artifactRefs:readonly string[];
  journal:readonly SafeExecutionJournalEntry[];
}

function bootstrapUrl(platform:PlatformExecutionPlan["intent"]["platform"]):string{
  if(platform==="instagram")return"https://www.instagram.com/";
  if(platform==="tiktok")return"https://www.tiktok.com/";
  return"https://studio.youtube.com/";
}
function normalized(value:unknown):string{return String(value??"").trim().toLocaleLowerCase("en-US").replace(/[_-]+/g," ").replace(/\s+/g," ");}
function selectorFor(token:string):string{return`[data-flerdvision-node=${JSON.stringify(token)}]`;}

/** Executes a SurfaceContract-derived plan and physically stops before the irreversible action. */
export class SafePlatformExecutionRunner {
  private readonly driver:BrowserDomUiDriver;
  private readonly recorder=new BrowserCalibrationRecorder();
  private readonly now:()=>string;
  constructor(
    private readonly session:BrowserPageSessionPort,
    private readonly artifacts:PrepareArtifactSinkPort,
    now:()=>string=()=>new Date().toISOString()
  ){this.driver=new BrowserDomUiDriver(session);this.now=now;}

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
    const before=await this.readBoolean(action.locators);
    if(before===null)throw new UiActionExecutionError(`Cannot prove boolean state for ${action.stepKey}`);
    if(before!==expected)await this.driver.click(action.locators,10_000,finalLocators);
    const after=await this.readBoolean(action.locators);
    if(after!==expected)throw new UiActionExecutionError(`Boolean readback failed for ${action.stepKey}: expected ${expected}, observed ${String(after)}`);
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
      const current=await this.readEnum(action.locators);
      if(normalized(current)!==wanted){
        await this.driver.click(action.locators,10_000,finalLocators);
        const selected=await this.session.evaluate<boolean>(`(() => {
          const norm=v=>String(v||'').trim().toLocaleLowerCase('en-US').replace(/[_-]+/g,' ').replace(/\\s+/g,' '),wanted=${JSON.stringify(wanted)};
          const candidates=Array.from(document.querySelectorAll('[role="option"],option,[data-value]'));
          const option=candidates.find(el=>norm(el.getAttribute('data-value'))===wanted||norm(el.getAttribute('value'))===wanted||norm(el.textContent)===wanted);
          if(!option)return false;option.click();return true;
        })()`);
        if(!selected)throw new UiActionExecutionError(`Cannot safely locate enum option ${expected} for ${action.stepKey}`);
      }
    }
    const after=await this.readEnum(action.locators);
    if(normalized(after)!==wanted)throw new UiActionExecutionError(`Enum readback failed for ${action.stepKey}: expected ${expected}, observed ${after??"UNKNOWN"}`);
    return`${action.stepKey}=${after}`;
  }

  async execute(plan:PlatformExecutionPlan,identity:BrowserIdentity,input:SafePlatformExecutionInput):Promise<SafePlatformExecutionResult>{
    if(identity.accountId!==plan.intent.accountId||identity.platform!==plan.intent.platform)throw new UiActionExecutionError("Execution identity does not match plan account/platform");
    const finalLocators=this.finalLocators(plan),artifactRefs:string[]=[],journal:SafeExecutionJournalEntry[]=[];
    await this.session.navigate(bootstrapUrl(plan.intent.platform));
    const environment=await this.recorder.environment(this.session);
    if(environment.fingerprint!==plan.environmentFingerprint)throw new UiActionExecutionError(`Surface environment drift before execution: expected ${plan.environmentFingerprint}, observed ${environment.fingerprint}`);
    artifactRefs.push(...await this.artifacts.captureBoundary(this.session,plan.intent,identity,"surface-execution-bootstrap",this.now()));
    for(const action of plan.actions){
      let detail:string;
      if(action.operation==="FINAL_BOUNDARY"){
        detail=(await this.driver.locate(action.locators,10_000,true)).descriptor;
        journal.push({stepKey:action.stepKey,operation:action.operation,outcome:"PASS",detail});
        artifactRefs.push(...await this.artifacts.captureBoundary(this.session,plan.intent,identity,"surface-execution-final-boundary",this.now()));
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
