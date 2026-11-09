import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { PtyHost } from '../electron/pty-host.js';

// Windows counterpart of pty-host.test.ts: ConPTY spawn of the default
// shell and taskkill-based tree teardown.
const hosts: PtyHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.killAllAndWait(2_000);
});

describe.skipIf(process.platform !== 'win32')('PtyHost on Windows (ConPTY)', () => {
  it('spawns the default shell and echoes typed input', async () => {
    let out = '';
    const host = new PtyHost({
      send: (_ch, _id, data) => {
        if (typeof data === 'string') out += data;
      },
    });
    hosts.push(host);
    host.spawn('w1', { cwd: tmpdir(), cols: 120, rows: 30 });
    host.write('w1', 'echo fraktole-win-ok\r');
    const deadline = Date.now() + 15_000;
    while (!out.includes('fraktole-win-ok') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(out).toContain('fraktole-win-ok');
  });

  it('kill() tears down the shell and resolves', async () => {
    const host = new PtyHost({ send: () => undefined });
    hosts.push(host);
    host.spawn('w2', {
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      command: 'ping',
      args: ['-n', '60', '127.0.0.1'],
    });
    const started = Date.now();
    await host.kill('w2');
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(host.has('w2')).toBe(false);
  });
});
