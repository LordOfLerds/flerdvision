import { bootstrapHeadlessWorkspace } from "../application/headless-bootstrap.js";
import { ScheduleCommandService, type ScheduleCommandApplyPort, type ScheduleMutationResult, type ScheduleTargetView } from "../application/schedule-commands.js";

export interface ScheduleCliDependencies {
  applier?: ScheduleCommandApplyPort;
  output?: (line: string) => void;
}

function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--spec") { index += 1; continue; }
    if (argv[index]?.startsWith("--")) throw new Error(`Unknown schedule option ${argv[index]}`);
    out.push(argv[index]!);
  }
  return out;
}

function renderView(item: ScheduleTargetView): string {
  return `${item.customerName} · ${item.channelName} · ${item.format} · ${item.times.join(", ")} · ${item.capacity} Slot${item.capacity === 1 ? "" : "s"}/Tag`;
}

function renderMutation(result: ScheduleMutationResult): readonly string[] {
  if (!result.changed) return [`Keine Änderung: ${renderView(result)}`];
  return [
    `Zeitplan aktualisiert: ${renderView(result)}`,
    `Vorher: ${result.beforeTimes.join(", ")}`,
    "Hinweis: Bereits materialisierte heutige Posts bleiben aus Sicherheitsgründen bestehen. /pause stoppt fällige Posts sofort."
  ];
}

/** Thin CLI adapter. All validation, mutation and rollback semantics live in ScheduleCommandService. */
export async function runScheduleCli(
  command: "schedule" | "capacity",
  argv: readonly string[],
  specPath: string,
  dependencies: ScheduleCliDependencies = {}
): Promise<void> {
  const output = dependencies.output ?? console.log;
  const applier = dependencies.applier ?? {
    async apply(path: string) { await bootstrapHeadlessWorkspace({ specPath: path }); }
  };
  const service = new ScheduleCommandService(specPath, applier);
  const args = positionals(argv);

  if (command === "capacity") {
    if (args.length !== 2) throw new Error("Usage: capacity <kanal[/format]> <anzahl>");
    const desired = Number(args[1]);
    const result = await service.capacity(args[0]!, desired);
    for (const line of renderMutation(result)) output(line);
    return;
  }

  const action = (args[0] ?? "").toLocaleLowerCase("en-US");
  if (action === "show") {
    if (args.length !== 1) throw new Error("Usage: schedule show");
    output("Zeitplan:");
    for (const item of service.show()) output(`- ${renderView(item)}`);
    return;
  }
  if (action === "add" || action === "remove") {
    if (args.length !== 3) throw new Error(`Usage: schedule ${action} <kanal[/format]> <HH:mm>`);
    const result = action === "add"
      ? await service.add(args[1]!, args[2]!)
      : await service.remove(args[1]!, args[2]!);
    for (const line of renderMutation(result)) output(line);
    return;
  }
  if (action === "set") {
    if (args.length < 3) throw new Error("Usage: schedule set <kanal[/format]> <HH:mm> [HH:mm ...]");
    const result = await service.set(args[1]!, args.slice(2));
    for (const line of renderMutation(result)) output(line);
    return;
  }
  throw new Error("Usage: schedule show | schedule add/remove/set ...");
}
