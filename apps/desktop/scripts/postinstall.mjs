// postinstall: rebuild node-pty against the bundled Electron ABI.
//
// Windows is skipped on purpose: node-pty ships N-API prebuilds for
// win32-x64/arm64 (prebuilds/win32-*), which are ABI-stable across Node and
// Electron. Building from source there would require Visual Studio with the
// Spectre-mitigated libraries for no gain. Set FRAKTOLE_FORCE_REBUILD=1 to
// rebuild anyway.
import { spawnSync } from 'node:child_process';

if (process.platform === 'win32' && process.env.FRAKTOLE_FORCE_REBUILD !== '1') {
  console.log('postinstall: Windows — using node-pty N-API prebuilds (no rebuild)');
  process.exit(0);
}
const r = spawnSync('electron-rebuild', ['-w', 'node-pty'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
