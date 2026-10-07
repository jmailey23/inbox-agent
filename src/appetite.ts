/**
 * The spam appetite dial.
 *
 * One number per user, from Picky (0.7) to Ravenous (0.3). It does not change
 * what any layer measures. It moves three lines on the same 0 to 1 score:
 *
 *   unsubscribe  at or above the dial           Gary acts
 *   flag         at or above the dial - 0.2     a person decides
 *   stale        at or above the dial - 0.1     a flag nobody reviewed in 30
 *                                               days is treated as a Block
 *
 * Everything below the flag line is kept. The keep list, the block list and
 * Gmail's own Promotions category are not on this scale at all, so the dial
 * never overrides a decision the user made by hand.
 */

export const APPETITE = {
  picky: 0.7,
  careful: 0.6,
  balanced: 0.5,
  hungry: 0.4,
  ravenous: 0.3,
} as const;

export type AppetiteName = keyof typeof APPETITE;

/** New accounts start here. */
export const DEFAULT_APPETITE = APPETITE.balanced;

export interface Thresholds {
  unsubscribe: number;
  flag: number;
  staleAutoBlock: number;
}

// Rounded so 0.7 - 0.2 is 0.5 and not 0.49999999999999994.
const r2 = (n: number) => Math.round(n * 100) / 100;

export function thresholds(dial: number): Thresholds {
  // The settings API refuses anything outside 0.3 to 0.7; clamp anyway, so a
  // bad row can never produce a dial that eats everything.
  const t = Math.min(0.7, Math.max(0.3, dial));
  return {
    unsubscribe: r2(t),
    flag: r2(Math.max(0.1, t - 0.2)),
    staleAutoBlock: r2(Math.max(0, t - 0.1)),
  };
}

export function appetiteName(dial: number): AppetiteName {
  const t = thresholds(dial).unsubscribe;
  return (Object.keys(APPETITE) as AppetiteName[]).reduce((best, name) =>
    Math.abs(APPETITE[name] - t) < Math.abs(APPETITE[best] - t) ? name : best,
  );
}
