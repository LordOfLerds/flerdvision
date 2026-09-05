import { HeadlessOnboardingService, type HeadlessOnboardingStatus } from "../application/headless-onboarding.js";

export interface SetupCliDependencies {
  env?: Record<string, string | undefined>;
  output?: (line: string) => void;
}

function badge(value: boolean): string { return value ? "✅" : "⬜"; }

function renderStatus(status: HeadlessOnboardingStatus): readonly string[] {
  const lines = [
    `Setup · ${status.workspaceName}`,
    `Stage: ${status.stage}`,
    `${badge(status.driveConnected)} Source verbunden · ${status.sourceRoot}`,
    `${badge(status.rootConfirmed)} Root bestätigt`,
    `${badge(status.topologyConfirmed)} Ordnerzuordnung bestätigt`,
    `${badge(status.activationConfirmed)} Aktivierung ${status.activationMode} bestätigt`,
    `${badge(status.accountsLoggedIn)} Social-Accounts angemeldet`,
    `${badge(status.telegramTested)} Telegram getestet`
  ];
  if (status.streams.length > 0) {
    lines.push("", "Ordnerzuordnung:");
    for (const stream of status.streams) {
      lines.push(`• ${stream.customerName} · ${stream.channelName} · ${stream.format} → ${stream.folderPath} · ${stream.videoCount} Videos · ${stream.matchedBy}`);
    }
  }
  if (status.warnings.length > 0) {
    lines.push("", "Warnungen:");
    for (const warning of status.warnings) lines.push(`⚠️ ${warning}`);
  }
  if (status.ready) lines.push("", "✅ Setup READY");
  else if (status.nextAction) lines.push("", `Nächster Schritt: ${status.nextAction}`);
  return lines;
}

export async function runSetupCli(
  argv: readonly string[],
  specPath: string,
  releaseSha: string,
  dependencies: SetupCliDependencies = {}
): Promise<void> {
  const output = dependencies.output ?? console.log;
  const env = dependencies.env ?? process.env;
  const action = (argv[0] ?? "status").trim().toLocaleLowerCase("en-US");
  const service = new HeadlessOnboardingService({ specPath, releaseSha, env });
  let status: HeadlessOnboardingStatus;
  if (action === "status") status = await service.status();
  else if (action === "confirm-root") status = await service.confirmRoot();
  else if (action === "confirm-topology") status = await service.confirmTopology();
  else if (action === "activate") status = await service.activate();
  else throw new Error("Usage: setup status | setup confirm-root | setup confirm-topology | setup activate");
  for (const line of renderStatus(status)) output(line);
}
