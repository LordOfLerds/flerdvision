import { loadPlatformUiSpecFile } from "../adapters/publish/platform-spec-config.js";

function usage(): never {
  throw new Error("Usage: platform-ui validate <config.json> [--require-calibrated]");
}

async function main(): Promise<void> {
  const [, , command, path, ...flags] = process.argv;
  if (command !== "validate" || !path) usage();
  const requireCalibrated = flags.includes("--require-calibrated");
  const config = loadPlatformUiSpecFile(path, requireCalibrated);
  for (const entry of config.specs) {
    console.log(`${entry.specId}\t${entry.platform}\t${entry.calibrationStatus}\tformats=${entry.spec.supportedFormats.join(",")}`);
  }
  if (config.specs.length === 0) throw new Error("No platform UI specs configured");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
