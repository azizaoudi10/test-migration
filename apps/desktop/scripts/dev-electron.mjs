// Cross-platform dev launcher for `pnpm dev`.
//
// Linux keeps the curated-environment launcher (scripts/launcher.sh: GTK
// module sanitization + sandbox probe). Windows and macOS have no such
// problem and start the local Electron binary directly.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
/** The electron package exports the absolute path of its binary. */
const electronBin = require('electron');

const [cmd, args] =
  process.platform === 'linux'
    ? ['bash', [join(root, 'scripts', 'launcher.sh'), electronBin, '.']]
    : [electronBin, ['.']];

const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: false });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
