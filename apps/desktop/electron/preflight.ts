import { app, dialog } from 'electron';

/** The node-pty module shape (type-only re-export so the native addon is
 *  never imported at bundle top level). */
export type PtyModule = typeof import('node-pty');

let cached: PtyModule | null = null;
let failed = false;

/** Loads the native PTY addon on first use.
 *
 *  The packaged pty.node is built against the Electron ABI but inherits the
 *  glibc of its build host (2.34+ here). On an older distro the dynamic load
 *  fails; instead of a raw startup crash the user gets an actionable dialog.
 *  Returns null after showing the dialog and quitting. */
export function loadPty(): PtyModule | null {
  if (cached) return cached;
  if (failed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('node-pty') as PtyModule;
    return cached;
  } catch (err) {
    failed = true;
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const glibc = report?.header?.glibcVersionRuntime ?? 'unknown';
    const detail = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      'Fraktole cannot start',
      `The bundled terminal module (node-pty) could not be loaded.\n\n` +
        `This build requires glibc 2.34 or newer (found: ${glibc}).\n` +
        `Use Ubuntu 22.04+/Debian 12+/Fedora 36+, or install an older Fraktole build.\n\n` +
        `Details: ${detail}`,
    );
    app.quit();
    return null;
  }
}
