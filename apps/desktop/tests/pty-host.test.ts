import { afterEach, describe, expect, it } from 'vitest';
import { PtyHost } from '../electron/pty-host.js';

const hosts: PtyHost[] = [];

function makeHost(): PtyHost {
  const host = new PtyHost({ send: () => undefined });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.killAllAndWait(2_000);
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// bash/process-group semantics: the Windows (ConPTY + taskkill) path is
// covered by tests/pty-host-win.test.ts
describe.skipIf(process.platform === 'win32')('PtyHost process lifecycle (audit D2)', () => {
  it('awaits the SIGKILL escalation for a TERM-ignoring child', async () => {
    const host = makeHost();
    // bash ignores TERM and keeps respawning its sleeping child: only the
    // SIGKILL escalation can end it, so a fast return would be a bug
    const { pid } = host.spawn('t1', {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      command: 'bash',
      args: ['-c', 'trap "" TERM; while true; do sleep 0.2; done'],
    });
    // let the child install its trap before the kill lands
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await host.killAllAndWait(4_000);
    const elapsed = Date.now() - started;
    expect(host.has('t1')).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_000);
    expect(pidAlive(pid)).toBe(false);
  });

  it('never leaves the old process group alive when a tileId is reused', async () => {
    const host = makeHost();
    const first = host.spawn('t1', { cwd: '/tmp', cols: 80, rows: 24, command: 'bash', args: ['-c', 'sleep 30'] });
    const second = host.spawn('t1', { cwd: '/tmp', cols: 80, rows: 24, command: 'bash', args: ['-c', 'sleep 30'] });
    expect(host.has('t1')).toBe(true);
    expect(second.pid).not.toBe(first.pid);
    // SIGKILL is immediate but the exit event/reap lands on a later tick
    let gone = false;
    for (let i = 0; i < 50 && !gone; i += 1) {
      if (!pidAlive(first.pid)) gone = true;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(gone).toBe(true);
  });

  it('falls back to /bin/bash when SHELL is empty', async () => {
    const saved = process.env.SHELL;
    process.env.SHELL = '';
    try {
      const host = makeHost();
      expect(() => host.spawn('t1', { cwd: '/tmp', cols: 80, rows: 24 })).not.toThrow();
      expect(host.has('t1')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
  });
});
