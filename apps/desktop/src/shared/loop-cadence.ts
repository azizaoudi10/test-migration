/** Loop-carrier cadence derivation. The poll interval ("loops hunger") is
 *  the user-facing knob and the ONLY live field: while a goal is armed and
 *  the loop is idle, the carrier wakes the model on every hunger tick —
 *  permanent polling with no backstop and no stall stand-down.
 *  Presets (settings UI): lazy 90s, calm 45s, standard 15s; the stored
 *  value is one number (reviewer.pollSeconds, unset = 15). */
export const RECHECK_WALL_MS = 90_000;
export const STALE_WALL_MS = 45_000;

export const POLL_SECONDS_MIN = 2;
export const POLL_SECONDS_MAX = 600;

export type LoopCadence = {
  pollIntervalMs: number;
  /** @deprecated unused since permanent polling — frozen at 1, kept for type compat. */
  recheckPolls: number;
  /** @deprecated unused since permanent polling — frozen at 2, kept for type compat. */
  staleWakeLimit: number;
};

export function deriveLoopCadence(pollSeconds?: number): LoopCadence {
  const p = Math.min(POLL_SECONDS_MAX, Math.max(POLL_SECONDS_MIN, Math.round(pollSeconds ?? 15))) * 1000;
  return {
    pollIntervalMs: p,
    recheckPolls: 1,
    staleWakeLimit: 2,
  };
}
