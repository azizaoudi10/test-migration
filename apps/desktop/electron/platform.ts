import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Platform seam: every OS-specific decision of the main process lives here
 *  so the rest of the code stays platform-neutral. Fraktole started as a
 *  Linux-only app; Windows (10 1809+ / 11, ConPTY) is now a first-class
 *  target. */

export const IS_WINDOWS = process.platform === 'win32';

/** The keystroke that submits a typed line in a tile. POSIX ttys translate
 *  '\n' fine; ConPTY + PowerShell/PSReadLine only accept a carriage return
 *  as Enter ('\n' would insert a literal newline / Ctrl+J). */
export const LINE_END = IS_WINDOWS ? '\r' : '\n';

/** Finds an executable on PATH (honouring PATHEXT on Windows). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d.length > 0);
  const exts = IS_WINDOWS
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)
    : [''];
  const hasExt = IS_WINDOWS && /\.[a-z0-9]+$/i.test(name);
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let cachedShell: string | null = null;

/** The interactive shell a bare tile runs.
 *  - FRAKTOLE_SHELL always wins (both platforms);
 *  - POSIX: $SHELL, falling back to /bin/bash (app-menu launches may carry
 *    an empty SHELL, and pty.spawn('') fails);
 *  - Windows: PowerShell 7 (pwsh) when installed, else Windows PowerShell,
 *    else %ComSpec% (cmd.exe). */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FRAKTOLE_SHELL) return env.FRAKTOLE_SHELL;
  if (!IS_WINDOWS) return env.SHELL || '/bin/bash';
  if (cachedShell) return cachedShell;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const winPs = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  cachedShell =
    findOnPath('pwsh.exe', env) ??
    (existsSync(winPs) ? winPs : null) ??
    env.ComSpec ??
    env.COMSPEC ??
    'cmd.exe';
  return cachedShell;
}

/** Arguments for the default shell (PowerShell banners are noise in tiles). */
export function defaultShellArgs(shell: string): string[] {
  if (!IS_WINDOWS) return [];
  return /(?:^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shell) ? ['-NoLogo'] : [];
}

/** Resolves a program for node-pty. On Windows CreateProcess neither walks
 *  PATHEXT nor runs .cmd/.bat shims (npm-installed CLIs such as `claude` or
 *  `codex` are .cmd shims), so those are wrapped in `cmd.exe /d /s /c`. */
export function resolvePtyCommand(
  command: string,
  args: string[],
): { file: string; args: string[] } {
  if (!IS_WINDOWS) return { file: command, args };
  const resolved = /[\\/]/.test(command) ? command : (findOnPath(command) ?? command);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', resolved, ...args] };
  }
  return { file: resolved, args };
}

/** Kills a process and every descendant.
 *  - POSIX: node-pty children are session leaders, so the negative pid
 *    addresses the whole process group;
 *  - Windows: there are no process groups — `taskkill /T` walks the tree
 *    (/F: Windows console programs have no SIGTERM equivalent, a graceful
 *    request is never honoured by the agent CLIs anyway).
 *  Throws when the process is already gone (POSIX) so callers can fall back. */
export function killProcessTree(pid: number, signal: 'SIGTERM' | 'SIGKILL', sync = false): void {
  if (!IS_WINDOWS) {
    process.kill(-pid, signal);
    return;
  }
  const args = ['/PID', String(pid), '/T', '/F'];
  if (sync) {
    spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
  } else {
    const child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  }
}

/** The tar binary for session bundles. Windows 10 1803+ ships bsdtar as
 *  %SystemRoot%\System32\tar.exe; it is preferred over whatever `tar` is
 *  first on PATH (Git for Windows' GNU tar reads `C:\…` as a remote host). */
export function tarBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (!IS_WINDOWS) return 'tar';
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const bundled = join(systemRoot, 'System32', 'tar.exe');
  return existsSync(bundled) ? bundled : 'tar';
}

/** Install hint for missing CLI tools, per platform. */
export function installHint(tools: string[]): string {
  if (IS_WINDOWS) {
    const ids = tools.map((t) =>
      t === 'git' ? 'Git.Git' : t === 'rg' ? 'BurntSushi.ripgrep.MSVC' : t,
    );
    return `Install them (e.g. winget install ${ids.join(' ')}) and restart Fraktole. tar ships with Windows 10 1803+.`;
  }
  return `Install them (e.g. apt install ${tools.join(' ')}) and restart Fraktole.`;
}
