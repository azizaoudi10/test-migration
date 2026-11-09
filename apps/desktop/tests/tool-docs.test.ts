import { describe, expect, it } from 'vitest';
import { ReviewerTools } from '../electron/reviewer-tools.js';

const defs = new ReviewerTools().definitions();
const byName = new Map(defs.map((d) => [d.name, d]));

describe('tool documentation', () => {
  it('every tool has a substantive description with no emoji', () => {
    for (const d of defs) {
      expect(d.description.length, `${d.name} description too short`).toBeGreaterThanOrEqual(60);
      expect(d.description, `${d.name} description has emoji`).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it('every inputSchema property is documented', () => {
    for (const d of defs) {
      const props = (d.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [key, prop] of Object.entries(props)) {
        expect(prop.description, `${d.name}.${key} missing description`).toBeTruthy();
      }
    }
  });

  it('the deleted tools stay deleted', () => {
    expect(byName.has('read_tile')).toBe(false);
    expect(byName.has('type_into_tile')).toBe(false);
    expect(byName.has('launch_agent')).toBe(false);
  });

  it('the tool count is 18 (launch_agent merged into spawn_agent + send_keystroke)', () => {
    expect(defs.length).toBe(18);
  });

  it('send_message is body-only with no wake promise', () => {
    const d = byName.get('send_message')!;
    expect(d.inputSchema.properties).not.toHaveProperty('kind');
    expect(d.description).not.toContain('wake');
    expect(d.description).toContain('read_scrollback');
  });

  it('ask_user is free-form only', () => {
    const d = byName.get('ask_user')!;
    expect(d.description).not.toContain('confirm-kill');
    expect(d.description).not.toContain('agent-kind');
  });

  it('pairs cross-reference each other (selection guidance)', () => {
    const sp = byName.get('spawn_agent')!.description;
    expect(sp).toContain('send_keystroke');

    const rf = byName.get('read_file')!.description;
    const ld = byName.get('list_dir')!.description;
    expect(rf).toContain('list_dir');
    expect(rf).toContain('search_files');
    expect(ld).toContain('search_files');
  });

  it('the monitor doctrine is locked: read_scrollback is canonical, the log is audit-only', () => {
    expect(byName.get('read_scrollback')!.description).toContain('no completion signal');
    expect(byName.get('list_messages')!.description).toContain('Audit-only');
    expect(byName.get('send_keystroke')!.description).toContain('/compact');
  });

  it('spawn_agent is harness-only with no shell escape hatch', () => {
    const d = byName.get('spawn_agent')!;
    expect(d.description).toContain('HARNESS-ONLY');
    expect(d.description).toContain('ask_user');
    expect(d.description).toContain('send_keystroke');
    expect(d.description).not.toContain('launch_agent');
  });

  it('spawn_agent kind is an enum of the effective harness list', () => {
    const custom = new ReviewerTools(['opencode', 'claude']).definitions().find((d) => d.name === 'spawn_agent')!;
    expect((custom.inputSchema.properties as Record<string, { enum?: string[] }>).kind?.enum).toEqual([
      'opencode',
      'claude',
    ]);
    const fallback = byName.get('spawn_agent')!;
    const fallbackEnum = (fallback.inputSchema.properties as Record<string, { enum?: string[] }>).kind?.enum ?? [];
    expect(fallbackEnum).toHaveLength(5);
    expect(fallbackEnum).not.toContain('shell');
  });

  it('send_message documents the bare-shell refusal', () => {
    expect(byName.get('send_message')!.description).toContain('refused');
  });

  it('update_task disambiguates tasks from sub-goals', () => {
    const d = byName.get('update_task')!.description;
    expect(d).toContain('set_goal');
  });

  it('kill_agent documents the direct-kill contract', () => {
    const d = byName.get('kill_agent')!.description;
    expect(d).toContain('Always allowed');
    expect(d).toContain('Never target the orchestrator');
  });
});
