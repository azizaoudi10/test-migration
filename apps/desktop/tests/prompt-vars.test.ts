import { describe, expect, it } from 'vitest';
import { expandPromptVars } from '../src/shared/prompt-vars.js';

describe('expandPromptVars', () => {
  it('replaces every known variable', () => {
    const out = expandPromptVars('in {{cwd}} for {{project}} goal {{goal}} sel {{selection}}', {
      cwd: '/p',
      project: 'proj',
      goal: 'ship',
      selection: 'code',
    });
    expect(out).toBe('in /p for proj goal ship sel code');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(expandPromptVars('hello {{unknown}}', { cwd: '/p' })).toBe('hello {{unknown}}');
  });

  it('tolerates whitespace inside the braces and missing context', () => {
    expect(expandPromptVars('a {{  cwd  }} b {{goal}}', { cwd: '/x' })).toBe('a /x b ');
  });

  it('replaces repeated occurrences', () => {
    expect(expandPromptVars('{{cwd}}/{{cwd}}', { cwd: '/r' })).toBe('/r//r');
  });
});
