import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from 'vitest';

// The CDP driver boots a real Electron window plus mock providers; it cannot
// run headless. It also executes builds and binds ports at module top level,
// so it is NEVER imported — it runs as a child process only when opted in
// with a display server or E2E_FORCE=1.
const canRunE2E = !!process.env.DISPLAY || !!process.env.E2E_FORCE;
test.skipIf(!canRunE2E)('desktop E2E driver (CDP)', async () => {
  const code: number = await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['scripts/driver-e2e.mjs'],
      { cwd: process.cwd(), timeout: 280000 },
      (err) => resolve(typeof err?.code === 'number' ? err.code : err ? 1 : 0),
    );
    child.stdout?.on('data', (d) => process.stdout.write(d));
    child.stderr?.on('data', (d) => process.stderr.write(d));
  });
  expect(code).toBe(0);
}, 300000);
test('e2e driver script present', () => {
  expect(existsSync(join(process.cwd(), 'scripts', 'driver-e2e.mjs'))).toBe(true);
});
