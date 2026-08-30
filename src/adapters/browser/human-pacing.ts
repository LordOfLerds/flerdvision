/**
 * Deterministic human pacing. Every delay derives from a seed (intent id, text), never from
 * wall-clock randomness: identical runs replay identically, tests stay exact, and no two
 * intents share a rhythm. Operator decision 2026-08-30: posts should read like a person —
 * scattered minutes around the slot, typing at human speed, a breath before the final click.
 */

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32 — tiny deterministic PRNG over a string seed. */
export function seededRandom(seed: string): () => number {
  let state = fnv1a(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Launch offset after the slot target, deterministic per intent: 0..maxSeconds. */
export function jitterSeconds(intentId: string, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0;
  return fnv1a(intentId) % (maxSeconds + 1);
}

export interface HumanPacing {
  /** Pause between surface steps: ~1.2–3.5 s. */
  stepPauseMs(): number;
  /** Per-character typing delays for a text: ~55–160 ms each, occasional longer thought-pause. */
  typingDelaysMs(text: string): readonly number[];
  /** One breath before the irreversible click: ~1.5–4 s. */
  preFinalPauseMs(): number;
}

export function humanPacing(seed: string): HumanPacing {
  const random = seededRandom(seed);
  return {
    stepPauseMs: () => Math.round(1200 + random() * 2300),
    typingDelaysMs: (text: string) => {
      const delays: number[] = [];
      for (let index = 0; index < text.length; index += 1) {
        const thoughtPause = random() < 0.03 ? 400 + random() * 700 : 0;
        delays.push(Math.round(55 + random() * 105 + thoughtPause));
      }
      return delays;
    },
    preFinalPauseMs: () => Math.round(1500 + random() * 2500)
  };
}
