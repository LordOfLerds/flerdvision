import { SqliteControlPlaneStore } from "../adapters/storage/sqlite.js";
import { ControlPlaneAdminReadModel, IngressAdminReadModel } from "../application/read-model.js";
import { RestartRecoveryService } from "../application/recovery.js";

function usage(): never {
  console.error("Usage: node dist/cli/admin.js <summary|intents|events INTENT_ID|sources|content|dispositions|source-events OBSERVATION_ID|recover> [--db PATH]");
  process.exitCode = 2;
  throw new Error("invalid arguments");
}

function databasePath(args: readonly string[]): string {
  const dbFlag = args.indexOf("--db");
  if (dbFlag >= 0) {
    const path = args[dbFlag + 1];
    if (!path) usage();
    return path;
  }
  return process.env.FLERDVISION_DB_PATH ?? "runtime/flerdvision.sqlite";
}

const args = process.argv.slice(2);
const command = args[0];
if (!command) usage();
const store = new SqliteControlPlaneStore(databasePath(args));
const read = new ControlPlaneAdminReadModel(store);
const ingressRead = new IngressAdminReadModel(store);

try {
  const now = new Date().toISOString();
  if (command === "summary") {
    console.log(JSON.stringify(read.summary(now), null, 2));
  } else if (command === "intents") {
    console.log(JSON.stringify(read.intents(), null, 2));
  } else if (command === "events") {
    const intentId = args[1];
    if (!intentId || intentId === "--db") usage();
    console.log(JSON.stringify(read.events(intentId), null, 2));
  } else if (command === "sources") {
    console.log(JSON.stringify(ingressRead.sources(), null, 2));
  } else if (command === "content") {
    console.log(JSON.stringify(ingressRead.content(), null, 2));
  } else if (command === "dispositions") {
    console.log(JSON.stringify(ingressRead.dispositions(), null, 2));
  } else if (command === "source-events") {
    const observationId = args[1];
    if (!observationId || observationId === "--db") usage();
    console.log(JSON.stringify(store.listEvents("source_observation", observationId), null, 2));
  } else if (command === "recover") {
    console.log(JSON.stringify(new RestartRecoveryService(store).recover(now), null, 2));
  } else {
    usage();
  }
} finally {
  store.close();
}
