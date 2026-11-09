# Migration de Fraktole vers Windows

Ce dépôt est un portage de [Zauberman/Fraktole](https://github.com/Zauberman/Fraktole)
(application Electron conçue « Linux-native ») vers **Windows 10 (1809+) / Windows 11 x64**.
Linux reste pris en charge : toutes les décisions spécifiques à l'OS passent désormais par
un seul module, `apps/desktop/electron/platform.ts`.

## Ce qui a changé

| Domaine | Linux (avant) | Windows (après) | Fichiers |
|---|---|---|---|
| Shell des tuiles | `$SHELL` ou `/bin/bash` | `pwsh.exe` (PowerShell 7) → `powershell.exe` → `%ComSpec%`; `FRAKTOLE_SHELL` force un shell sur les deux OS | `platform.ts`, `pty-host.ts`, `main.ts` |
| Terminal | node-pty (forkpty) | node-pty + **ConPTY** (`useConpty: true`), prébuilds N-API `win32-x64` | `pty-host.ts`, `electron-builder.yml` |
| Arrêt des processus | `kill(-pid)` sur le groupe de processus | `taskkill /PID <pid> /T /F` (arbre complet) + fermeture du pseudoconsole | `platform.ts`, `pty-host.ts` |
| Touche Entrée envoyée aux agents | `\n` | `\r` (PSReadLine/ConPTY n'acceptent que CR) | `main.ts` |
| Lancement de CLI (`claude`, `codex`…) | exécution directe | résolution via `PATH`/`PATHEXT`; shims `.cmd`/`.bat` enveloppés dans `cmd.exe /d /s /c` | `platform.ts` |
| Chemins absolus (outils du Reviewer) | `path.startsWith('/')` | `path.isAbsolute()` (`C:\…`, UNC) | `reviewer-tools.ts` |
| Confinement des chemins (sécurité) | racine `/` | racines `C:\`/UNC, comparaison insensible à la casse; **correction d'un contournement** : la vérification anti-symlink partait de `\` + `C:` et était ignorée | `fs-scope.ts` |
| Racine git | `git rev-parse` | sortie `C:/…` normalisée en `C:\…` | `projects.ts` |
| Noms de fichiers dans l'UI | `split('/')` | `split(/[\\/]/)`, palette normalisée | `file-state.ts`, `Palette.tsx`, `project-files.ts` |
| Bundles de session (tar.gz) | GNU tar | `%SystemRoot%\System32\tar.exe` (bsdtar) prioritaire; parsing de `tar -tv` GNU **et** bsdtar; refus des membres `C:`/`\` | `session-bundle.ts` |
| Signal « ramener la fenêtre » | `SIGUSR2` | non enregistré (l'événement `second-instance` suffit) | `main.ts` |
| Notifications | — | `app.setAppUserModelId('com.fraktole.desktop')` (requis pour les toasts) | `main.ts` |
| Message d'erreur node-pty | glibc 2.34 | Windows 1809+ / VC++ Redistributable | `preflight.ts` |
| Outils manquants | `apt install …` | `winget install Git.Git BurntSushi.ripgrep.MSVC` | `platform.ts`, `main.ts` |
| Fenêtres console parasites | — | `windowsHide: true` sur tous les `execFile`/`spawn` | `fork.ts`, `projects.ts`, `session-bundle.ts`, `main.ts` |

## Build & packaging

- `pnpm install` : sous Windows, `scripts/postinstall.mjs` **ne recompile pas** node-pty —
  les prébuilds N-API de node-pty 1.1 sont compatibles avec l'ABI d'Electron. Aucun
  Visual Studio / bibliothèques Spectre requis (`FRAKTOLE_FORCE_REBUILD=1` pour forcer).
- `pnpm dev` : `scripts/dev-electron.mjs` remplace l'appel direct à `bash launcher.sh`
  (conservé sous Linux pour l'assainissement GTK).
- `pnpm dist:win` → `apps/desktop/release/`
  - `Fraktole-<v>-x64-setup.exe` (NSIS, installation par utilisateur par défaut, choix
    du dossier, raccourcis Bureau/Menu Démarrer),
  - `Fraktole-<v>-x64-portable.exe`.
- `node-pty` est extrait de l'asar (`asarUnpack`) : `winpty-agent.exe`, `conpty.dll`
  et les `.node` ne peuvent pas être chargés depuis une archive asar.
- Icône Windows multi-tailles `build/icon.ico` générée par `scripts/ico.mjs`
  (également appelée par `pnpm icon`).
- `.gitattributes` force les fins de ligne LF (scripts shell, AppRun, prettier).
- Signature de code : définir les secrets `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`
  dans le dépôt GitHub; sans eux, l'exécutable n'est pas signé (avertissement SmartScreen).

## CI (GitHub Actions)

- `test.yml` : le job desktop tourne en matrice `ubuntu-latest` + `windows-latest`.
- `build.yml` : nouveau job **Desktop Build (Windows installer)** sur tag `v*` ou
  lancement manuel (`workflow_dispatch`); les `.exe` sont publiés comme artefacts et
  ajoutés à la release.

## Tests

- `tests/platform.test.ts` : shell par défaut, `PATH`/`PATHEXT`, enveloppe `.cmd`,
  parsing `tar -tv` GNU/bsdtar.
- `tests/pty-host-win.test.ts` : spawn ConPTY + arrêt `taskkill` (exécuté seulement sous Windows).
- Tests POSIX-only marqués `skipIf(win32)` : groupe de processus bash, `launcher.sh`,
  permissions `chmod 0o000`, symlinks (exigent le mode développeur sous Windows).

## Limites connues / à valider sur une vraie machine Windows

- Le portage a été vérifié sous Linux (typecheck, lint, tests); la partie Windows est
  validée par la CI `windows-latest` — lancer la CI avant la première release.
- Les agents CLI (opencode, claude, codex, gemini, aider…) doivent être installés et
  présents dans le `PATH` Windows.
- Les mots-clés de touches envoyés par le Reviewer (`ctrl-c`, flèches…) sont des
  séquences VT standard, comprises par ConPTY.
- L'application mobile (`apps/mobile`, Flutter Android) n'est pas concernée par le
  portage; le pont TLS local fonctionne à l'identique (pare-feu Windows : autoriser
  Fraktole sur le réseau privé lors de la première demande).
