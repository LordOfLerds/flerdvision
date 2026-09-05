import { resolve } from "node:path";
import { findLatestRecording } from "../adapters/browser/prepare-artifacts.js";
import { SqliteOperatorStateStore } from "../adapters/storage/sqlite-operator-state.js";
import { AuthorizedRuntimeDueExecutionAdapter } from "../adapters/runtime/authorized-due-execution.js";
import { WorkspaceDistributionRuntime } from "../adapters/runtime/workspace-distribution-runtime.js";
import { WorkspaceSurfacePublisher } from "../adapters/runtime/workspace-surface-publisher.js";
import { telegramAdapterFromEnv } from "../adapters/notify/telegram.js";
import { filenameParts } from "../adapters/publish/workspace-payload-resolver.js";
import type { PublicationIntent } from "../domain/model.js";
import type { KillSwitch, OperationalGateDecision } from "../domain/operations.js";
import type { OperationalPublishGatePort } from "../domain/operations-ports.js";
import type { PublishContext } from "../domain/ports.js";
import { AcceptanceCandidateService } from "./acceptance-candidate.js";
import { AcceptanceTestNowService, type FlerdvisionRuntimeRole, type TestNowResult } from "./acceptance-test-now.js";
import { loadWorkspaceSpecFile } from "./headless-bootstrap.js";
import { KillSwitchGate, OperationalKillSwitchError } from "./operations.js";
import { CompositeOperationalPublishGate, SchedulePauseGate } from "./schedule-pause.js";
import { accountIdForChannel } from "./workspace-spec-compiler.js";

export interface AcceptanceTestNowCommandOptions {
  specPath: string;
  releaseSha: string;
  customer: string;
  platform: "instagram" | "tiktok" | "youtube";
  env?: Record<string, string | undefined>;
  headless?: boolean;
  confirmed: boolean;
  now?: string;
}

function runtimeRole(env: Record<string, string | undefined>): FlerdvisionRuntimeRole {
  const raw = (env.FLERDVISION_WORKSPACE_ROLE ?? "production").trim().toLocaleLowerCase("en-US");
  if (raw !== "acceptance" && raw !== "production") throw new Error("FLERDVISION_WORKSPACE_ROLE must be acceptance or production");
  return raw;
}

/** Non-persistent allowlist: the ordinary due worker can claim exactly the one-shot intent only. */
class ExactIntentGate implements OperationalPublishGatePort {
  constructor(private readonly targetIntentId: string, private readonly inner: OperationalPublishGatePort, private readonly clock: () => string) {}

  evaluate(intent: PublicationIntent): OperationalGateDecision {
    if (intent.intentId === this.targetIntentId) return this.inner.evaluate(intent);
    const synthetic: KillSwitch = {
      scopeType: "ACCOUNT",
      scopeKey: intent.accountId,
      enabled: true,
      reason: "acceptance_test_now_exact_intent_filter",
      updatedAt: this.clock(),
      updatedBy: "acceptance-test-now"
    };
    return { allowed: false, blockingSwitches: [synthetic] };
  }

  assertAllowed(intent: PublicationIntent): void {
    const decision = this.evaluate(intent);
    if (!decision.allowed) throw new OperationalKillSwitchError(decision);
  }
}

/**
 * Product command composition for an out-of-slot acceptance post. It uses the same publisher,
 * final-action service, reconciliation collectors, operational gates and notification adapter as
 * autonomous due execution. The only extra gate narrows claiming to the one materialized intent.
 */
export async function runAcceptanceTestNowCommand(options: AcceptanceTestNowCommandOptions): Promise<TestNowResult> {
  const env = options.env ?? process.env;
  if (runtimeRole(env) !== "acceptance") throw new Error("test-now ist auf dieser Installation deaktiviert; FLERDVISION_WORKSPACE_ROLE=acceptance ist erforderlich.");
  if (env.ALLOW_FINAL_PUBLISH !== "true") throw new Error("test-now requires independent environment gate ALLOW_FINAL_PUBLISH=true");
  if (!options.confirmed) throw new Error("test-now requires explicit AUTONOMOUS_FINAL_PUBLISH confirmation");
  if (!options.releaseSha.trim()) throw new Error("test-now requires an exact release SHA");

  // No acceptance run may span changing code/spec. This is checked before any runtime store is
  // opened or one-shot intent is created.
  new AcceptanceCandidateService({ specPath: options.specPath, releaseSha: options.releaseSha, env }).assertCurrent();

  const now = new Date(options.now ?? new Date().toISOString()).toISOString();
  const spec = loadWorkspaceSpecFile(options.specPath);
  const base = new WorkspaceDistributionRuntime({
    runtimeRoot: spec.workspace.runtimeRoot,
    workspaceId: spec.workspace.id,
    env,
    timeZone: spec.workspace.timezone,
    releaseSha: options.releaseSha
  });
  const operatorState = new SqliteOperatorStateStore(base.layout.databasePath);
  let publisher: WorkspaceSurfacePublisher | undefined;

  try {
    const service = new AcceptanceTestNowService({
      spec,
      role: "acceptance",
      config: base.config,
      state: base.state,
      provenance: base.provenance,
      control: base.control,
      materializer: base.intents,
      execution: {
        runIntent: async (intentId, channelKey, executionNow) => {
          const channel = spec.channels.find((item) => item.key === channelKey);
          if (!channel) throw new Error(`test-now channel ${channelKey} disappeared from the canonical spec`);
          const accountId = accountIdForChannel(channel);
          const identities = base.control.listBrowserIdentities().map((item) => item.identity)
            .filter((identity) => identity.enabled && identity.accountId === accountId);
          if (identities.length !== 1) throw new Error(`test-now requires exactly one enabled browser identity for ${channel.name}; found ${identities.length}`);
          const health = base.control.latestSessionHealth(identities[0]!.identityId);
          if (health?.state !== "HEALTHY") throw new Error(`test-now session for ${channel.name} is not HEALTHY`);

          const allowedAccountIds = new Set([accountId]);
          const ordinaryGate = new CompositeOperationalPublishGate([
            new KillSwitchGate(base.control),
            new SchedulePauseGate(operatorState)
          ]);
          const exactGate = new ExactIntentGate(intentId, ordinaryGate, () => executionNow);
          const contextProvider = (intent: PublicationIntent): PublishContext => ({
            mode: "canary",
            allowFinalPublish: true,
            allowedAccountIds,
            releaseSha: options.releaseSha
          });

          publisher ??= new WorkspaceSurfacePublisher({
            runtimeRoot: spec.workspace.runtimeRoot,
            workspaceId: spec.workspace.id,
            releaseSha: options.releaseSha,
            env,
            ownerId: `${spec.workspace.id}:acceptance-test-now`,
            headless: options.headless ?? true,
            now: () => executionNow
          });
          const activePublisher = publisher;
          const telegram = telegramAdapterFromEnv(env);
          const customer = spec.customers.find((item) => item.key === channel.customerKey);
          const channelName = customer ? `${customer.name} · ${channel.name}` : channel.name;
          const describeContent = async (intent: PublicationIntent) => {
            const filename = base.state.listAssets().find((record) => record.asset.contentId === intent.contentId)?.asset.filename;
            const parts = filename ? filenameParts(filename) : undefined;
            let payload: { caption?: string; title?: string } | undefined;
            try { payload = await activePublisher.payloads.resolve(intent); } catch { payload = undefined; }
            return {
              ...(parts?.text ? { videoLabel: parts.text } : {}),
              ...(parts?.hashtags ? { hashtags: parts.hashtags } : {}),
              ...(payload?.caption ? { caption: payload.caption } : {}),
              ...(payload?.title ? { title: payload.title } : {})
            };
          };
          const worker = new AuthorizedRuntimeDueExecutionAdapter(
            base.control,
            activePublisher,
            exactGate,
            contextProvider,
            {
              releaseSha: options.releaseSha,
              ownerId: `${spec.workspace.id}:acceptance-test-now:${intentId}`,
              maxPerCycle: 1,
              launchJitterMaxSeconds: 0,
              timeZone: spec.workspace.timezone,
              channelNames: { [accountId]: channelName },
              ...(telegram ? { notificationAdapters: [telegram] } : {}),
              describeContent,
              findRecording: (intent) => findLatestRecording(resolve(base.layout.evidenceDir, "publisher"), intent.intentId)
            }
          );
          const report = await worker.runDue(executionNow);
          const after = base.control.getIntent(intentId);
          if (!after || after.state === "SCHEDULED") {
            throw new Error(`test-now worker did not claim the exact one-shot intent (claimed=${report.claimed})`);
          }
          return report;
        }
      }
    });
    return await service.run({ customer: options.customer, platform: options.platform, now });
  } finally {
    if (publisher) await publisher.close().catch(() => {});
    operatorState.close();
    base.close();
  }
}
