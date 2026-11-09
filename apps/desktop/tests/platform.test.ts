import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultShell,
  defaultShellArgs,
  findOnPath,
  IS_WINDOWS,
  LINE_END,
  resolvePtyCommand,
  tarBinary,
} from '../electron/platform.js';
import { tarVerboseSize } from '../electron/session-bundle.js';

describe('platform seam', () => {
  it('FRAKTOLE_SHELL overrides the default shell on every platform', () => {
    expect(defaultShell({ FRAKTOLE_SHELL: 'C:\\tools\\nu.exe' })).toBe('C:\\tools\\nu.exe');
  });

  it.skipIf(IS_WINDOWS)('POSIX: $SHELL, falling back to /bin/bash when empty', () => {
    expect(defaultShell({ SHELL: '/usr/bin/zsh' })).toBe('/usr/bin/zsh');
    expect(defaultShell({ SHELL: '' })).toBe('/bin/bash');
    expect(defaultShellArgs('/bin/bash')).toEqual([]);
    expect(LINE_END).toBe('\n');
    expect(tarBinary()).toBe('tar');
  });

  it.skipIf(!IS_WINDOWS)(
    'Windows: a PowerShell or cmd.exe shell, CR line ends, System32 tar',
    () => {
      expect(defaultShell()).toMatch(/(pwsh|powershell|cmd)\.exe$/i);
      expect(defaultShellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual(['-NoLogo']);
      expect(defaultShellArgs('C:\\Windows\\System32\\cmd.exe')).toEqual([]);
      expect(LINE_END).toBe('\r');
      expect(tarBinary()).toMatch(/tar(\.exe)?$/i);
    },
  );

  it('findOnPath finds an executable in PATH and returns null otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-path-'));
    try {
      const name = IS_WINDOWS ? 'fake-agent.cmd' : 'fake-agent';
      await writeFile(join(dir, name), IS_WINDOWS ? '@echo off\r\n' : '#!/bin/sh\n');
      if (!IS_WINDOWS) await chmod(join(dir, name), 0o755);
      const env = { PATH: [dir, process.env.PATH ?? ''].join(delimiter), PATHEXT: '.EXE;.CMD' };
      expect(findOnPath('fake-agent', env)).toBe(join(dir, name));
      expect(findOnPath('definitely-not-a-real-binary-xyz', env)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(IS_WINDOWS)('POSIX: commands pass through to node-pty unchanged', () => {
    expect(resolvePtyCommand('claude', ['--help'])).toEqual({ file: 'claude', args: ['--help'] });
  });

  it.skipIf(!IS_WINDOWS)('Windows: .cmd shims are wrapped in cmd.exe /c', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-shim-'));
    const prev = process.env.PATH;
    try {
      await writeFile(join(dir, 'fake-agent.cmd'), '@echo off\r\n');
      process.env.PATH = [dir, prev ?? ''].join(delimiter);
      const r = resolvePtyCommand('fake-agent', ['--x']);
      expect(r.file).toMatch(/cmd(\.exe)?$/i);
      expect(r.args).toEqual(['/d', '/s', '/c', join(dir, 'fake-agent.cmd'), '--x']);
    } finally {
      process.env.PATH = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tar -tv size column', () => {
  it('parses GNU tar rows', () => {
    expect(tarVerboseSize('-rw-r--r-- root/root      1234 2026-11-09 12:24 s-a/f')).toBe(1234);
    expect(tarVerboseSize('drwxr-xr-x 1000/1000         0 2026-11-09 12:24 s-a/')).toBe(0);
  });

  it('parses bsdtar rows (Windows System32\\tar.exe, macOS)', () => {
    expect(tarVerboseSize('-rw-rw-rw-  0 0      0        5678 Nov 09 12:24 s-a/f')).toBe(5678);
    expect(tarVerboseSize('-rw-r--r--  0 alice  staff      42 Nov  9 12:24 s-a/session.json')).toBe(
      42,
    );
  });

  it('returns null for non-entry rows', () => {
    expect(tarVerboseSize('')).toBeNull();
    expect(tarVerboseSize('tar: warning')).toBeNull();
  });
});
