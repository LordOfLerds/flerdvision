import { createHash } from "node:crypto";
import type { BrowserIdentityStorePort } from "../domain/browser-identity-ports.js";
import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionRoute } from "../domain/distribution.js";
import type { ChannelSourceBindingStorePort } from "../domain/source-binding-ports.js";
import type { LegacyBindingMigrationAnalysis, LegacyBindingMigrationResolverPort, LegacyFolderMigrationGroup, LegacyRouteMigrationChoice } from "../domain/legacy-binding-migration.js";
import { SetupDistributionOnboardingService } from "./setup-distribution-onboarding.js";
import { assertConfigurationReferentialIntegrity } from "./distribution-config.js";

function id(value:string):string{return createHash("sha256").update(value).digest("hex").slice(0,24);}

export class LegacyBindingMigrationService {
  constructor(
    private readonly bindings:ChannelSourceBindingStorePort,
    private readonly config:DistributionConfigurationStorePort,
    private readonly accounts:BrowserIdentityStorePort,
    private readonly resolver:LegacyBindingMigrationResolverPort
  ){}

  analyze():LegacyBindingMigrationAnalysis{
    const records=this.bindings.listChannelSourceBindings().filter(item=>item.binding.enabled);
    const grouped=new Map<string,typeof records>();
    for(const record of records){
      const key=`${record.binding.source}|${record.binding.folderId}`;
      const list=grouped.get(key)??[];list.push(record);grouped.set(key,list);
    }
    const folderGroups:LegacyFolderMigrationGroup[]=[...grouped.entries()].map(([key,items]):LegacyFolderMigrationGroup=>{
      const reasons:string[]=[];
      const paths=[...new Set(items.map(item=>item.binding.folderPath))];
      if(paths.length!==1)reasons.push("same provider folder id has conflicting display paths");
      const interpretations=[...new Set(items.map(item=>item.binding.interpretSubstructure))];
      if(interpretations.length!==1)reasons.push("accounts sharing this folder disagree on substructure interpretation");
      for(const item of items){if(!this.accounts.getSocialAccount(item.binding.accountId))reasons.push(`missing social account ${item.binding.accountId}`);}
      return{
        groupId:`legacy-group:${id(key)}`,
        sourceKind:items[0]!.binding.source,
        folderPath:paths[0]??items[0]!.binding.folderPath,
        bindingIds:items.map(item=>item.binding.bindingId).sort(),
        accountIds:items.map(item=>item.binding.accountId).sort(),
        interpretSubstructure:interpretations.length===1?Boolean(interpretations[0]):false,
        status:reasons.length===0?"READY_FOR_LANE":"MANUAL_REVIEW",
        reasons
      };
    }).sort((a,b)=>a.folderPath.localeCompare(b.folderPath)||a.groupId.localeCompare(b.groupId));
    return{bindings:records.length,folderGroups,manualReviewGroups:folderGroups.filter(group=>group.status==="MANUAL_REVIEW").length,note:"Source lanes can be migrated from explicit legacy folder identity. Posting routes require explicit route choices and are never inferred from account/platform alone."};
  }

  async migrateGroup(params:{groupId:string;routeChoices?:readonly LegacyRouteMigrationChoice[];now:string}):Promise<{laneId:string;createdRoutes:readonly string[];manualReview:readonly string[]}>{
    const analysis=this.analyze(),group=analysis.folderGroups.find(item=>item.groupId===params.groupId);
    if(!group)throw new Error(`Unknown legacy migration group ${params.groupId}`);
    if(group.status!=="READY_FOR_LANE")throw new Error(`Legacy group ${group.groupId} requires manual review: ${group.reasons.join(", ")}`);
    const sourceRecords=this.bindings.listChannelSourceBindings().filter(item=>group.bindingIds.includes(item.binding.bindingId));
    const representative=sourceRecords[0]?.binding;if(!representative)throw new Error(`Legacy group ${group.groupId} has no binding records`);
    const resolved=await this.resolver.resolve(representative);
    const onboarding=new SetupDistributionOnboardingService(this.config).registerLane({provider:resolved.provider,folderRef:resolved.folderRef,folderPath:group.folderPath,interpretSubstructure:group.interpretSubstructure,activationMode:"NEW_ONLY",now:params.now});

    const choices=params.routeChoices??[];
    const choiceByAccount=new Map(choices.map(choice=>[choice.accountId,choice]));
    const manualReview:string[]=[];
    const routes:DistributionRoute[]=[];
    const current=this.config.load();
    for(const accountId of group.accountIds){
      const choice=choiceByAccount.get(accountId);
      if(!choice){manualReview.push(`${accountId}: posting profile/copy/rhythm choice required`);continue;}
      const account=this.accounts.getSocialAccount(accountId)?.account;if(!account){manualReview.push(`${accountId}: account missing`);continue;}
      const posting=current.config.postingProfiles.find(item=>item.postingProfileId===choice.postingProfileId);
      const copy=current.config.copyProfiles.find(item=>item.copyProfileId===choice.copyProfileId);
      const calendar=choice.operatingCalendarId?(current.operatingCalendars??[]).find(item=>item.calendarId===choice.operatingCalendarId):undefined;
      if(!posting||!posting.enabled){manualReview.push(`${accountId}: posting profile ${choice.postingProfileId} missing/disabled`);continue;}
      if(posting.platform!==account.platform){manualReview.push(`${accountId}: posting profile platform mismatch`);continue;}
      if(!copy||!copy.enabled){manualReview.push(`${accountId}: copy profile ${choice.copyProfileId} missing/disabled`);continue;}
      if(!current.schedulePolicies[choice.schedulePolicyId]){manualReview.push(`${accountId}: schedule ${choice.schedulePolicyId} missing`);continue;}
      if(choice.operatingCalendarId&&!calendar){manualReview.push(`${accountId}: calendar ${choice.operatingCalendarId} missing`);continue;}
      routes.push({
        routeId:`route:${id(`${onboarding.lane.laneId}|${accountId}|${choice.postingProfileId}|${choice.schedulePolicyId}|${choice.operatingCalendarId??""}`)}`,
        displayName:`${onboarding.lane.displayName} → ${account.platform} @${account.expectedHandle}`,
        laneId:onboarding.lane.laneId,
        accountId,
        platform:account.platform,
        postingProfileId:choice.postingProfileId,
        copyProfileId:choice.copyProfileId,
        schedulePolicyId:choice.schedulePolicyId,
        ...(choice.operatingCalendarId?{operatingCalendarId:choice.operatingCalendarId}:{}),
        requirement:choice.requirement,
        enabled:true
      });
    }
    if(routes.length>0){
      const before=this.config.load(),map=new Map(before.config.routes.map(route=>[route.routeId,route]));
      for(const route of routes)map.set(route.routeId,route);
      const nextConfig={...before.config,routes:[...map.values()]};assertConfigurationReferentialIntegrity(nextConfig);
      this.config.save({updatedAt:new Date(params.now).toISOString(),config:nextConfig,schedulePolicies:before.schedulePolicies,...(before.operatingCalendars ? { operatingCalendars: before.operatingCalendars } : {}),planningPolicy:before.planningPolicy,...(before.runtimePolicy?{runtimePolicy:before.runtimePolicy}:{})},before.revision);
    }
    return{laneId:onboarding.lane.laneId,createdRoutes:routes.map(route=>route.routeId),manualReview};
  }
}
