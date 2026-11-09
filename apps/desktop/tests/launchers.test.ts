import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAUNCHERS,
  HARNESS_PLACEHOLDERS,
  HARNESS_SLOT_COUNT,
  commandIsPlainLaunch,
  effectiveAllowlist,
  launcherFirstToken,
  sanitizeAllowedLaunchers,
  sanitizeHarnessSlots,
} from '../src/shared/launchers.js';

describe('launcherFirstToken', () => {
  it('returns the first whitespace-separated token', () => {
    expect(launcherFirstToken('opencode --yolo')).toBe('opencode');
    expect(launcherFirstToken('  claude ')).toBe('claude');
  });
  it('returns "" for blank input', () => {
    expect(launcherFirstToken('')).toBe('');
    expect(launcherFirstToken('   ')).toBe('');
  });
});

describe('commandIsPlainLaunch', () => {
  it('accepts plain program invocations', () => {
    expect(commandIsPlainLaunch('opencode')).toBe(true);
    expect(commandIsPlainLaunch('agy --plan')).toBe(true);
    expect(commandIsPlainLaunch('/usr/local/bin/opencode')).toBe(true);
  });
  it('rejects empty and oversized commands', () => {
    expect(commandIsPlainLaunch('')).toBe(false);
    expect(commandIsPlainLaunch('   ')).toBe(false);
    expect(commandIsPlainLaunch('x'.repeat(257))).toBe(false);
  });
  it('rejects shell metacharacters', () => {
    for (const bad of [
      'ls; rm -rf /',
      'a | b',
      'a & b',
      'echo $(id)',
      '`id`',
      'a > /etc/passwd',
      'a < x',
      '(subshell)',
      "it's",
      '"quoted"',
      'a\\b',
      '*.txt',
      'a?b',
      '[a-z]',
      '{a,b}',
      'a\nb',
      'a\rb',
    ]) {
      expect(commandIsPlainLaunch(bad), bad).toBe(false);
    }
  });
});

describe('sanitizeAllowedLaunchers', () => {
  it('parses a comma/space separated string', () => {
    expect(sanitizeAllowedLaunchers('cursor, goose  windsurf')).toEqual(['cursor', 'goose', 'windsurf']);
  });
  it('cleans a string array: trim, drop empties, dedupe, bound entries', () => {
    expect(sanitizeAllowedLaunchers([' cursor ', '', 'cursor', 'goose'])).toEqual(['cursor', 'goose']);
  });
  it('returns undefined for junk or empty input', () => {
    expect(sanitizeAllowedLaunchers(undefined)).toBeUndefined();
    expect(sanitizeAllowedLaunchers(42)).toBeUndefined();
    expect(sanitizeAllowedLaunchers('')).toBeUndefined();
    expect(sanitizeAllowedLaunchers([])).toBeUndefined();
    expect(sanitizeAllowedLaunchers([1, null])).toBeUndefined();
  });
});

describe('sanitizeHarnessSlots', () => {
  it('keeps slot order and exposes the slot contract', () => {
    expect(HARNESS_SLOT_COUNT).toBe(5);
    expect(HARNESS_PLACEHOLDERS).toHaveLength(5);
    expect(sanitizeHarnessSlots(['claude', 'opencode'])).toEqual(['claude', 'opencode']);
  });
  it('packs the five slots: drops nulls/empties, keeps priority order', () => {
    expect(sanitizeHarnessSlots(['opencode', null, '', '  ', 'claude'])).toEqual(['opencode', 'claude']);
  });
  it('drops non-plain entries (they would not survive the spawn gate)', () => {
    expect(sanitizeHarnessSlots(['opencode', 'x; rm -rf /', 'claude'])).toEqual(['opencode', 'claude']);
    expect(sanitizeHarnessSlots(['a | b'])).toBeUndefined();
  });
  it('dedupes and caps at five', () => {
    expect(sanitizeHarnessSlots(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(sanitizeHarnessSlots(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('parses a comma/space string and rejects junk', () => {
    expect(sanitizeHarnessSlots('opencode, claude')).toEqual(['opencode', 'claude']);
    expect(sanitizeHarnessSlots(undefined)).toBeUndefined();
    expect(sanitizeHarnessSlots(42)).toBeUndefined();
    expect(sanitizeHarnessSlots([])).toBeUndefined();
    expect(sanitizeHarnessSlots([null, ''])).toBeUndefined();
  });
});

describe('effectiveAllowlist', () => {
  it('always contains the defaults (including shell)', () => {
    const list = effectiveAllowlist(undefined);
    for (const d of DEFAULT_LAUNCHERS) expect(list).toContain(d);
  });
  it('unions the user list without duplicates', () => {
    expect(effectiveAllowlist(['opencode', 'cursor'], undefined)).toContain('cursor');
    expect(effectiveAllowlist(['opencode', 'cursor'], undefined).filter((x) => x === 'opencode').length).toBe(1);
  });
  it('adds the configured agent launcher (first token)', () => {
    expect(effectiveAllowlist(undefined, 'goose --auto')).toContain('goose');
    expect(effectiveAllowlist(undefined)).not.toContain('goose');
  });
});
