import { describe, expect, it } from 'vitest';
import { deriveLoopCadence } from '../src/shared/loop-cadence.js';

describe('deriveLoopCadence', () => {
  it('derives the poll interval from hunger (the only live field)', () => {
    // standard 15s (also the unset default)
    expect(deriveLoopCadence(15)).toEqual({ pollIntervalMs: 15_000, recheckPolls: 1, staleWakeLimit: 2 });
    expect(deriveLoopCadence(undefined)).toEqual(deriveLoopCadence(15));
    // presets: the interval is the re-check rate — no backstop, no stand-down
    expect(deriveLoopCadence(90)).toEqual({ pollIntervalMs: 90_000, recheckPolls: 1, staleWakeLimit: 2 });
    expect(deriveLoopCadence(45)).toEqual({ pollIntervalMs: 45_000, recheckPolls: 1, staleWakeLimit: 2 });
    expect(deriveLoopCadence(3)).toEqual({ pollIntervalMs: 3_000, recheckPolls: 1, staleWakeLimit: 2 });
    // bounds clamp
    expect(deriveLoopCadence(1).pollIntervalMs).toBe(2_000);
    expect(deriveLoopCadence(10_000).pollIntervalMs).toBe(600_000);
    expect(deriveLoopCadence(0)).toEqual(deriveLoopCadence(2));
    expect(deriveLoopCadence(-5)).toEqual(deriveLoopCadence(2));
    // fractional seconds round to whole seconds
    expect(deriveLoopCadence(7.6).pollIntervalMs).toBe(8_000);
  });

  it('freezes the deprecated guard fields (permanent polling never reads them)', () => {
    for (const s of [2, 3, 5, 7, 15, 30, 45, 60, 90, 120, 300, 600]) {
      const c = deriveLoopCadence(s);
      expect(c.recheckPolls).toBe(1);
      expect(c.staleWakeLimit).toBe(2);
    }
  });
});
