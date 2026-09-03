/**
 * How many real PREPARE_ONLY replays a qualification performs, and therefore how many
 * prepare-only passes a readiness record must carry.
 *
 * Three replays were a fixed cost per requalification round without adding evidence the first
 * replay had not already produced: the same plan, the same contract, the same boundary. The
 * operator decision is one replay by default; the number stays configurable so a suspicious
 * surface can be replayed more often without touching code.
 */
export const DEFAULT_QUALIFICATION_REPLAYS = 1;
export const QUALIFICATION_REPLAYS_ENV = "FLERDVISION_QUALIFICATION_REPLAYS";
const MAX_QUALIFICATION_REPLAYS = 10;

/** Reads the configured replay count; an unusable override is an operator error, not a default. */
export function resolveQualificationReplays(
  env: Record<string, string | undefined> = process.env,
  fallback: number = DEFAULT_QUALIFICATION_REPLAYS
): number {
  const raw = env[QUALIFICATION_REPLAYS_ENV];
  if (raw === undefined || raw.trim() === "") return assertReplayCount(fallback, "default");
  const parsed = Number(raw.trim());
  return assertReplayCount(parsed, QUALIFICATION_REPLAYS_ENV);
}

export function assertReplayCount(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUALIFICATION_REPLAYS) {
    throw new Error(`${source} must be an integer from 1 to ${MAX_QUALIFICATION_REPLAYS}; got ${value}`);
  }
  return value;
}

/** Operator wording, e.g. "1/1 Trockenlauf" / "2/3 Trockenläufe". */
export function germanReplayProgress(passes: number, required: number): string {
  return `${passes}/${required} ${required === 1 ? "Trockenlauf" : "Trockenläufe"}`;
}
