import { AcceptanceCandidateService, type AcceptanceCandidateStatus } from "../application/acceptance-candidate.js";

export interface AcceptanceCliDependencies {
  env?: Record<string, string | undefined>;
  output?: (line: string) => void;
}

function positionals(argv: readonly string[]): readonly string[] {
  const withValue = new Set(["--spec", "--release-sha"]);
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (withValue.has(token)) { index += 1; continue; }
    if (token.startsWith("--")) throw new Error(`Unknown acceptance option ${token}`);
    result.push(token);
  }
  return result;
}

function badge(ok: boolean): string { return ok ? "✅" : "⬜"; }

function render(status: AcceptanceCandidateStatus): readonly string[] {
  const lines = [
    "Acceptance",
    `Candidate: ${status.releaseSha ?? "keiner"}`,
    `${badge(status.current)} Candidate entspricht aktuellem Code + Spec + Surface`,
    `${badge(status.onboardingReady)} Setup READY`,
    `${badge(status.routesPrepared)} Routen vorbereitet`
  ];
  for (const platform of status.platforms.filter((item) => item.configured)) {
    const platformBadge = platform.uncertain > 0 ? "🛑" : platform.verified > 0 ? "✅" : platform.blocked > 0 ? "⚠️" : "⬜";
    lines.push(`${platformBadge} ${platform.platform}: ${platform.verified} verifiziert · ${platform.uncertain} unsicher · ${platform.blocked} blockiert · ${platform.pending} offen`);
  }
  lines.push("", `Test-now: ${status.readyToRun ? "freigegeben" : "gesperrt"}`);
  if (status.reason) lines.push(`Hinweis: ${status.reason}`);
  if (!status.frozen) lines.push("Nächster Schritt: flerdvision acceptance freeze");
  else if (!status.current) lines.push("Nächster Schritt: Änderungen abschließen und Candidate neu einfrieren.");
  else if (status.platforms.some((item) => item.configured && item.uncertain > 0)) lines.push("Nächster Schritt: unsicheren Post zuerst verifizieren; kein neuer test-now.");
  else {
    const missing = status.platforms.find((item) => item.configured && item.verified === 0);
    if (missing) lines.push(`Nächster Schritt: test-now für ${missing.platform}.`);
  }
  return lines;
}

export async function runAcceptanceCli(
  argv: readonly string[],
  specPath: string,
  releaseSha: string,
  dependencies: AcceptanceCliDependencies = {}
): Promise<void> {
  const output = dependencies.output ?? console.log;
  const env = dependencies.env ?? process.env;
  const args = positionals(argv);
  if (args.length > 1) throw new Error("Usage: acceptance status | acceptance freeze");
  const action = (args[0] ?? "status").trim().toLocaleLowerCase("en-US");
  const service = new AcceptanceCandidateService({ specPath, releaseSha, env });
  const status = action === "status"
    ? await service.status()
    : action === "freeze"
      ? await service.freeze()
      : (() => { throw new Error("Usage: acceptance status | acceptance freeze"); })();
  for (const line of render(status)) output(line);
}
