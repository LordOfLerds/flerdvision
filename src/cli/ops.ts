import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { WebhookNotificationAdapter } from "../adapters/notify/webhook.js";
import { OpsHttpServer } from "../adapters/ops/http-server.js";
import { NotificationDispatcher } from "../application/notifications.js";
import {
  DailyOperationsService,
  IncidentNotificationService,
  OperationsCycleService,
  KillSwitchService,
  OperationsIncidentProjector
} from "../application/operations.js";

function usage(): never {
  console.error("Usage: node dist/cli/ops.js <cycle|project|incidents|actions|kill-switches|kill-switch SCOPE KEY on|off REASON|readiness YYYY-MM-DD|completion YYYY-MM-DD|dispatch|serve> [--db PATH]");
  process.exitCode = 2;
  throw new Error("invalid arguments");
}

function databasePath(args: readonly string[]): string {
  const index = args.indexOf("--db");
  if (index >= 0) {
    const value = args[index + 1];
    if (!value) usage();
    return value;
  }
  return process.env.FLERDVISION_DB_PATH ?? "runtime/flerdvision.sqlite";
}

function webhookAdapter(): WebhookNotificationAdapter | null {
  const url = process.env.FLERDVISION_NOTIFICATION_WEBHOOK_URL;
  if (!url) return null;
  const options: ConstructorParameters<typeof WebhookNotificationAdapter>[0] = { channelKey: "current-bot", url };
  if (process.env.FLERDVISION_NOTIFICATION_WEBHOOK_TOKEN) Object.assign(options, { bearerToken: process.env.FLERDVISION_NOTIFICATION_WEBHOOK_TOKEN });
  return new WebhookNotificationAdapter(options);
}

const args = process.argv.slice(2);
const command = args[0];
if (!command) usage();
const store = new SqliteControlPlaneStore(databasePath(args));
const actor = { type: "system", id: "ops-cli" } as const;
const now = new Date().toISOString();

async function dispatchIfConfigured(): Promise<void> {
  const adapter = webhookAdapter();
  if (!adapter) return;
  console.log(JSON.stringify(await new NotificationDispatcher(store, [adapter]).dispatchPending(new Date().toISOString(), actor), null, 2));
}

try {
  if (command === "cycle") {
    const adapter = webhookAdapter();
    const channelKeys = adapter ? [adapter.channelKey] : ["current-bot"];
    const report = new OperationsCycleService(store, { channelKeys }).run(now, actor);
    if (adapter) await dispatchIfConfigured();
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "project") {
    const report = new OperationsIncidentProjector(store).project(now, actor);
    const adapter = webhookAdapter();
    if (adapter) {
      const notify = new IncidentNotificationService(store, [adapter.channelKey]);
      for (const incidentId of report.alertIncidentIds) {
        const incident = store.getIncident(incidentId);
        if (incident) notify.enqueueNewIncident(incident, actor);
      }
      await dispatchIfConfigured();
    }
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "incidents") {
    console.log(JSON.stringify(store.listIncidents(), null, 2));
  } else if (command === "actions") {
    console.log(JSON.stringify(store.listHumanActions(), null, 2));
  } else if (command === "kill-switches") {
    console.log(JSON.stringify(store.listKillSwitches(), null, 2));
  } else if (command === "kill-switch") {
    const scopeType = args[1];
    const scopeKey = args[2];
    const state = args[3];
    const reason = args.slice(4).filter((item) => item !== "--db" && item !== databasePath(args)).join(" ").trim();
    if ((scopeType !== "GLOBAL" && scopeType !== "ACCOUNT" && scopeType !== "PLATFORM") || !scopeKey || (state !== "on" && state !== "off") || !reason) usage();
    console.log(JSON.stringify(new KillSwitchService(store).set(scopeType, scopeKey, state === "on", reason, now, "ops-cli"), null, 2));
  } else if (command === "readiness" || command === "completion") {
    const date = args[1];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) usage();
    const service = new DailyOperationsService(store);
    const message = command === "readiness" ? service.readinessMessage(date, now) : service.completionMessage(date, now);
    const adapter = webhookAdapter();
    const channels = adapter ? [adapter.channelKey] : ["current-bot"];
    store.enqueueNotification(message, channels, actor);
    if (adapter) await dispatchIfConfigured();
    console.log(JSON.stringify(message, null, 2));
  } else if (command === "dispatch") {
    const adapter = webhookAdapter();
    if (!adapter) throw new Error("FLERDVISION_NOTIFICATION_WEBHOOK_URL is required for dispatch");
    console.log(JSON.stringify(await new NotificationDispatcher(store, [adapter]).dispatchPending(now, actor), null, 2));
  } else if (command === "serve") {
    const password = process.env.FLERDVISION_OPS_PASSWORD;
    if (!password) throw new Error("FLERDVISION_OPS_PASSWORD is required");
    const port = Number(process.env.FLERDVISION_OPS_PORT ?? "8787");
    const server = new OpsHttpServer(store, {
      host: process.env.FLERDVISION_OPS_HOST ?? "127.0.0.1",
      port,
      username: process.env.FLERDVISION_OPS_USER ?? "flerdvision",
      password,
      ...(process.env.FLERDVISION_OPERATOR_SESSION_BASE_URL ? { operatorSessionBaseUrl: process.env.FLERDVISION_OPERATOR_SESSION_BASE_URL } : {})
    });
    const bound = await server.start();
    console.log(`Flerdvision Ops listening on http://${bound.host}:${bound.port}`);
    await new Promise<void>((resolve) => {
      const stop = () => { void server.stop().then(resolve); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } else usage();
} finally {
  store.close();
}
