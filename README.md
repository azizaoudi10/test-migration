# Fraktole

> **A cross-platform (Windows 10/11 + Linux) tiling command center for orchestrating autonomous AI coding agents — real PTY tiles, a supervising Reviewer model, and one-click premade loops (Auto Compose).**

Fraktole pairs terminal multiplexing with a supervising **Reviewer model** that has the role of an autonomous general: it dispatches substantive work to an agent workforce running in live PTY tiles, verifies code and runtime state itself, and manages goals through to completion.

The monorepo contains the desktop workstation (`apps/desktop`) and the Flutter Android remote companion (`apps/mobile`) with its local TLS pairing bridge.

---

## Highlights

```
┌────────────────────────────────────────┬───────────────────────────────────────┐
│              WORKSPACE                 │               REVIEWER                │
│  ┌─────────────────┬─────────────────┐ │  ┌─────────────────────────────────┐  │
│  │ Build Agent 1   │ Build Agent 2   │ │  │ Goal: Implement TLS remote      │  │
│  │ (opencode / pty)│ (opencode / pty)│ │  │ [x] Generate RSA cert           │  │
│  ├─────────────────┴─────────────────┤ │  │ [ ] Wire WSS handshake          │  │
│  │ Fixes Agent / Test Runner         │ │  │                                 │  │
│  │ (shell / vitest)                  │ │  │ Model: claude-3-7-sonnet        │  │
│  └───────────────────────────────────┘ │  │ Context: 42k / 200k (compacted) │  │
│                                        │  └─────────────────────────────────┘  │
└────────────────────────────────────────┴───────────────────────────────────────┘
```

- **Tiling Matrix**: Split-pane workspace of real PTY terminals with drag dividers, keyboard focus cycle, swap, and instant zoom.
- **Delegation Doctrine**: The Reviewer model is pushed to review and orchestrate, rather than edits blindly. It should be able to inspect files, search the codebase, monitor terminal output, and delegates implementation to worker agents.
- **Autonomous Auto Compose**: Dedicated autonomous loops (*Bugs*, *Feature*, *Cyber*, *Frontend*, *Tests*, *Readability*, *Custom*) that operate inside project forks.
- **Goal Loop Carrier & Sub-Goals**: Break large initiatives into tracked sub-goals with self-healing loop carrier re-checks and automated progression upon reaching `GOAL-MET:`.
- **Integrated Browser Testing**: Embedded webview Test tab that the AI can navigate, capture console errors from, screenshot, and verify after fixes.
- **Mobile Remote Companion**: Flutter Android client connecting over end-to-end local TLS/WSS to monitor agents, stream tiles, and review tasks on the go.
- **Settings Center**: A dedicated full-window settings ledger (also under a native **Settings** menu, `Ctrl+,`) — model, sampling knobs, launchers, Auto Compose, editor prefs, shortcuts, and token-usage graphs in one themed surface.
- **Vibrant Chrome**: A regional color architecture — every chrome region (explorer, editor, reviewer, palette, settings) carries its own perceptually-derived hue family per theme, derived at runtime and contrast-tested; terminal tiles stay calm and text-first.
- **Semantic Explorer**: No icons — files and folders are color-coded by kind (folder / code / doc / config / style / data) with a leading tick and name tint, plus git change dots.
- **Bespoke Popups**: Every modal, menu and dropdown has its own layout with personality — the tile launcher's card grid, the session namer's serif preview plate, the command codex, tri-state save/discard rows, the resume-vs-fresh fork card — and a custom keyboard-first listbox replaces every native `<select>`.
- **Command Palette & Project Search**: `Ctrl+P` files, `Ctrl+Shift+P` commands — every tab, theme, setting and reviewer action reachable from one ranked palette; `Ctrl+Shift+F` searches the whole project.
- **Prompt Library**: A global prompt store in Settings (and the palette, `/prompt <name>`, and the Android client) — save/re-find prompts with tags, fuzzy search and usage counts; `{{cwd}}`, `{{project}}`, `{{goal}}` and `{{selection}}` expand at use time.
- **Adaptive Shell**: Below ~1120px the reviewer collapses into a rail + overlay drawer; pixel-clamped panes, min-size tiles with spill refusal, viewport-clamped popovers and truncating bars keep the 960x600 minimum clip-free.
- **Git Awareness & Desktop Notifications**: Live branch + change markers in the Explorer and status bar; OS notifications when the reviewer needs input, a goal is met, or a run errors — click one to jump straight to the session.

---

## Core Capabilities

### 1. Tiling PTY Matrix & Session Daemon
- **Real Terminals**: Powered by `node-pty` and `@xterm/xterm`, running your preferred shell, CLI harnesses, or autonomous agent tools.
- **Flexible Binary Layout**: Split horizontally or vertically, drag dividers, zoom into any tile with `Ctrl+Shift+Enter`, and switch focus with arrow keys or `Ctrl+Shift+1..9`.
- **Keep-Alive Sessions**: Project-bound sessions run in the background. Switching projects or closing windows never kills active processes, streaming PTYs, or reviewer logs.
- **Session Bundles**: Export and import complete session arrangements, histories, and reviewer states.

### 2. The Reviewer Supervising Harness
The built-in Reviewer is an autonomous control loop supporting **OpenAI-compatible endpoints**, **Anthropic** (Claude 3.5/3.7 with extended thinking), **Ollama** (DeepSeek-R1, Qwen2.5-Coder, Llama), **llama.cpp** (`llama-server`, keyless, auth-optional), **DeepSeek**, and **Moonshot/Kimi**.

- **Resilient Execution**: Failed tool calls do not abort the turn; the model reads the error and adjusts. Stalled streams (120s timeout) auto-retry.
- **Token-Aware Compaction**: Compaction preserves system prompts, durable task ledgers, and the latest turns while safely trimming older context to ~80% of model limits.
- **Prompt Preemption**: Send prompts while the model is actively working; prompts queue and execute cleanly at turn boundaries.
- **Live Metrics**: Real-time tracking of input tokens, cache-hit tokens, output tokens, and compaction cycles in the footer.
- **Local Provider Hardening**: Local servers are probed for their real context window and the resolved budget (probed ≤ knob ≤ fallback) is shown live next to the status. The harness waits for server readiness before the first request, auto-heals context-limit errors by compacting and retrying, and detects truncated `finish_reason` responses to re-request cleanly. While a goal is armed, the loop carrier re-checks the run on every hunger tick — permanent polling with no stand-down, in auto-compose and for manual goals alike.
- **Model-Tuning Knobs**: Per-provider context window, output cap, and sampler overrides (temperature, top_p, top_k) for local servers.
- **Provider Catalog**: Searchable catalog of OpenAI-compatible endpoints — keyless local servers included — with config validation.
- **Thinking Replay**: Reasoning traces replay across providers on continuation turns; the system prompt persists across restarts.
- **Usage Graphs**: Per-session token usage (input / cached / output, per turn and cumulative) charted in Settings▸Usage — pure tokens, no cost tracking. A single ambient element — the reviewer column's slow regional breath — keeps the shell alive without ever competing with terminal content.

### 3. Auto Compose (Autonomous Loops in Safe Forks)
Auto Compose runs structured, autonomous development loops. Each run launches inside an **isolated project fork** (`userData/forks/<session>/<variant>`, outside the source repository), leaving the master repository untouched:

| Preset | Mission | Loop Workflow |
|---|---|---|
| **Cyber** | Vulnerability hunting | Spawns research counsel to identify injection, auth flaws, secret leakage, and unsafe dependencies; dispatches fixes; verifies before sign-off. |
| **Frontend** | Visual & UX polish | Audits layout, responsive behavior, typography, and UX flow; tests live rendered pages in the Test tab. |
| **Bugs** | Bug eradication | Discovers crashes, race conditions, edge cases, and unexpected errors; writes reproduction steps and tests. |
| **Feature** | High-value additions | Finds UX gaps and missing affordances, crafts implementation plans, and dispatches build agents. |
| **Tests** | Test suite expansion | Audits test coverage, eliminates flaky tests, and verifies that the suite passes cleanly. |
| **Readability** | Refactoring & clarity | Reorganizes monolithic files, extracts modules, and cleans dead code while strictly preserving existing behavior. |
| **Custom** | User-defined missions | Execute any custom autonomous prompt sequence. |

---

## The 18 Reviewer Tools

The Reviewer has access to a comprehensive suite of inspection, driving, delegation, and verification tools.
Agent progress is judged via `read_scrollback` — the dispatch log is audit-only and never carries results back:

| Category | Tool | Description |
|---|---|---|
| **Tiles & PTY** | `list_tiles` | List active agent tiles, PTY IDs, working directories, line counts, and activity timestamps. |
| | `read_scrollback` | Inspect up to 5,000 lines of live-or-persisted zero-lag terminal scrollback history. |
| | `spawn_agent` | Spawn a new agent tile — harness-only (one of the 5 settings slots); the launcher boots at spawn by construction. |
| | `kill_agent` | Terminate an agent tile and its child process tree. |
| | `send_keystroke` | Send control keystrokes (`shift-tab`, `enter`, `escape`, `ctrl-c`, arrows) into a tile; also runs slash-commands in a harness (`/compact` + enter). |
| **Delegation** | `send_message` | Dispatch instructions to worker agents (logged; monitor via `read_scrollback`). Refuses bare shell tiles. |
| | `list_messages` | Audit the session dispatch log. |
| **Filesystem** | `read_file` | Read up to 8 project files simultaneously (up to 4 MiB each). |
| | `list_dir` | Tree-walk directories up to 3 levels deep with smart exclusion of build directories. |
| | `search_files` | Search code for patterns or regular expressions with glob filters and line caps. |
| **Test Browser** | `open_test_page` | Open a local or remote URL inside the embedded Test tab webview. |
| | `read_test_page` | Inspect page title, loading state, console logs, and JavaScript errors. |
| | `reload_test_page`| Reload the active test page to verify hot-reload and bug fixes. |
| | `screenshot_test_page` | Capture a PNG screenshot of the webview for user verification. |
| **Ledger & Goals** | `read_state` | Read durable loop carrier goals and the task assignment ledger. |
| | `update_task` | Upsert task ledger status (`pending`, `active`, `done`, `failed`). |
| | `set_goal` | Arm, modify, or subdivide top-level loop carrier goals into actionable sub-goals. |
| | `ask_user` | Suspend execution and present an interactive free-form prompt to the user. |

---

## Workspace Navigation & Tabs

Fraktole organizes workflow into 4 synchronized views:

- **File Editor**: Multi-tab code editor powered by CodeMirror 6 with syntax highlighting for TypeScript, JavaScript, Python, HTML, CSS, JSON, and Markdown.
- **Node Matrix**: The central hub displaying the active PTY tile tree alongside the Reviewer dialogue and state ledger.
- **Test Browser**: An embedded webview allowing real-time preview of frontend applications.
- **Remote Bridge**: TLS certificate status, active remote connections, and pairing for the mobile client.

---


### Reviewer Prompt Commands

Enter these commands directly in the Reviewer input box:
- `/goal <text>` — Arm or update the loop carrier goal (bare `/goal` clears it).
- `/compact` — Trigger an immediate context compaction.
- `/summarize` — Generate a session recap and compact older turns.
- `/kill <id>` — Terminate running agent tile `<id>`.

---

## Mobile Remote Client (`apps/mobile`)

The companion Android application connects securely to your desktop workstation over local Wi-Fi:

1. Open the **Remote** tab in Fraktole.
2. Launch **Fraktole Remote** on Android and enter the 6-character pairing code.
3. The desktop generates a local self-signed TLS certificate and authenticates the client via an exchange token.
4. Tokens are stored in Android Keystore / Flutter Secure Storage for instant reconnection.
5. Monitor live tile outputs, view goal progression, and send commands from your phone.

---

## Download

### Windows

Every version tag (`v*`) also publishes Windows x64 builds:

- `Fraktole-<version>-x64-setup.exe` — installer (per-user by default, no admin rights needed; Start-menu and desktop shortcuts);
- `Fraktole-<version>-x64-portable.exe` — single executable, nothing installed.

Requirements: **Windows 10 version 1809 or newer** (ConPTY) or Windows 11, x64. Tiles open **PowerShell 7** (`pwsh`) when installed, otherwise Windows PowerShell, otherwise `cmd.exe`; set `FRAKTOLE_SHELL` to force another shell (e.g. `C:\Program Files\Git\bin\bash.exe`). Optional tools: `winget install Git.Git BurntSushi.ripgrep.MSVC` (tar ships with Windows). Unsigned builds show a SmartScreen prompt on first launch (*More info → Run anyway*).

See [MIGRATION-WINDOWS.md](MIGRATION-WINDOWS.md) for what changed in the Windows port.

### Linux

Prebuilt **AppImage** (x86_64, Linux) binaries are published automatically to [GitHub Releases](https://github.com/Zauberman/Fraktole/releases) whenever a version tag (`v*`) is pushed. Download the latest `Fraktole-*.AppImage`, make it executable, and run it — no installation required:

```bash
chmod +x Fraktole-*.AppImage
./Fraktole-*.AppImage
```

> The AppImage requires [FUSE](https://github.com/AppImage/AppImageKit/wiki/FUSE) (`libfuse2`) on the host system.

To build the AppImage yourself, see [Build Portable AppImage](#build-portable-appimage) below.

---

## Quickstart & Installation

### Prerequisites
- **OS**: Windows 10 1809+/11 (x64), or Linux (x86_64), glibc **>= 2.34** (Ubuntu 22.04+/Debian 12+/Fedora 36+); the AppImage uses the static runtime and needs no separate libfuse package
- **Node.js**: `>= 22`
- **pnpm**: `>= 10`
- Optional: `git` (projects/fork/status), `tar` (session bundles), `rg` (fast search; the JS walk is the fallback)

### Build the Windows installer (on Windows)
```powershell
git clone <this repository>
cd Fraktole
pnpm install            # node-pty uses its N-API win32 prebuilds: no Visual Studio needed
pnpm dist:win           # → apps/desktop/release/Fraktole-*-x64-setup.exe and *-portable.exe
```

### Build Self-Contained Installer (Linux)
```bash
# Clone repository
git clone https://github.com/Zauberman/Fraktole.git
cd Fraktole

# Install dependencies
pnpm install

# Build release installer script
pnpm installer

# Run generated installer (installs to ~/.local/bin and desktop entry)
bash apps/desktop/release/fraktole-install-*.sh

# Launch Fraktole
fraktole-desktop
```

### Build Portable AppImage (Linux)
```bash
pnpm appimage
# The AppImage is generated in apps/desktop/release/
./apps/desktop/release/Fraktole-*.AppImage
```

---

## Development

```bash
# Start Vite renderer + Electron main process with hot reload
pnpm dev

# Run unit and integration tests (Vitest)
pnpm test

# Type-check TypeScript sources
pnpm typecheck

# Lint codebase
pnpm lint

# Run end-to-end mock driver test
node apps/desktop/scripts/driver-e2e.mjs
```

---

## Repository Layout

```
Fraktole/
├── apps/
│   ├── desktop/
│   │   ├── electron/             # Main process: PTY host, Reviewer loop, TLS bridge, sessions
│   │   │   ├── remote/           # TLS certificate generation, WSS pairing, remote store
│   │   │   ├── reviewer/         # Provider adapters (OpenAI, Anthropic, Ollama)
  │   │   │   ├── reviewer-tools.ts # 18 Reviewer inspection, driving, and state tools
│   │   │   └── reviewer-plugins.ts # Auto Compose autonomous mission templates
│   │   ├── src/                  # React renderer: tiling tree, CodeMirror editor, themes
│   │   │   ├── components/       # Workspace, Tile, ReviewerTab, TestTab, Explorer, Settings, Palette, Search
│   │   │   └── assets/fonts/     # Curated OFL typography (Space Grotesk, JetBrains Mono, etc.)
│   │   ├── scripts/              # Packaging, installer generation, font fetching, E2E driver
│   │   └── tests/                # Test suite for runtime, mailboxes, recorder, and harness
│   └── mobile/                   # Flutter Android remote client
│       ├── lib/                  # Screens, transport gateway, tile buffer, protocol models
│       └── integration_test/     # On-device pairing and control integration tests
└── package.json                  # Root monorepo workspace manifest
```

---

## License

This project is licensed under the [MIT License](LICENSE).
The bundled fonts in `apps/desktop/src/assets/fonts/` are licensed under the [SIL Open Font License 1.1](http://scripts.sil.org/OFL).

---

## Failure Threads

### Backend
- [2026-09-10 23:39] TYPE ERROR: `electron/reviewer.ts` — `SerialQueue` referenced before import after the write-serialization change. Fixed by importing `./serial-queue.js`.
- [2026-09-10 23:50] TYPE ERROR: `electron/reviewer/providers/anthropic.ts` — budget-aware max_tokens clamp broke the documented clamp-up test. Fixed by constraining the thinking budget only when the user cap exceeds the default floor.
- [2026-09-10 00:35] TYPE ERROR: `electron/remote/bridge.ts` — `sendJson` now returns boolean; `: void` arrows with expression bodies rejected it. Fixed with block bodies.
- [2026-09-11 01:08] TYPE ERROR: `tests/remote-bridge.test.ts` — fake backend missing the new `listPrompts`. Fixed by implementing it.
- [2026-09-11 00:58] TYPE ERROR: `electron/fs-scope.ts` — `let cur = sep` narrowed to the `sep` literal type. Fixed by annotating `string`.
- [2026-09-13 02:10] TYPE ERROR: `tests/remote-bridge.test.ts` — fake backend missing the new `exportPrompts`/`importPrompts` after the RemoteBackend extension. Fixed by stubbing both.
- [2026-09-13 02:10] CONFIG ERROR: `apps/desktop/eslint.config.mjs` — new `files` block used the invalid `includes` key, then `projectService` failed on `scripts/*.mjs` outside tsconfig. Fixed with `projectService: false` + inline Node globals for those paths.

### Frontend
- [2026-09-10 23:42] TEST FAILURE: `tests/token-coverage.test.ts` — raw `rgb()` box-shadow outside tokens.css. Fixed by using `var(--shadow-dialog)`.
- [2026-09-11 00:53] TEST FAILURE: `tests/system-prompt.test.ts` — doctrine edit pushed the prompt over the 650-word bound. Fixed by folding the untrusted-output rule into an existing bullet.

### Testing
- [2026-09-11 00:01] TEST FAILURE: journal rotation kept the whole file when no marker existed in the retention tail. Fixed with a synthetic marker when the found marker predates the tail.
- [2026-09-10 23:17] TEST FAILURE: resize test relied on a floor that skipped the budget window. Fixed the assertion to the actual minimum-tile math.
