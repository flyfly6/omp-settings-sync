# Architecture

> The repository layout, the module map, and the rules that keep new code in the right place.

---

## Two Directories Matter

1. **This project** (`omp-settings-sync/`) — the code that ships as `dist/index.js`.
2. **The managed agent directory** — `~/.omp/agent` (or `~/.omp/profiles/<profile>/agent` with `OMP_PROFILE`, or `PI_CODING_AGENT_DIR`). It **is** the git repository: worktree = repository root, so there is no shadow staging copy (`README.md`, `src/config.ts:dirOf`).

Everything the plugin writes lives in one of two places inside the managed directory:

| Path | Committed? | Purpose |
| :--- | :--- | :--- |
| allowlisted files/dirs (`config.yml`, `mcp.json`, `settings.json`, `AGENTS.md`, `vault.enc`, `plugins.json`, `extensions/`, `skills/`, `agents/`, …) | yes | The synced payload (`src/security.ts:DEFAULT_ALLOWED_PATHS`) |
| `.git-sync/` | no — hard-denied | `filter.mjs`, `vault.key`, `sensitive.hash`, `settings.machine.json`, `config.machine.yml`, `mcp.machine.json`, `lock`, `state.json` |
| runtime state (`sessions/`, `state/`, `cache/`, `logs/`, `*.db*`) | no — hard-denied | Owned by omp itself |

`plugins.json` is the one allowlisted file whose *source* lives outside the managed directory: it mirrors the installed-plugin declarations from `<config dir root>/plugins` (a sibling of the agent dir) and carries no git filter, because machine-local entries (linked paths, local specs, `machineLocalPlugins`) are omitted instead of stripped. The plugin root itself is never written — apply actions go through the `omp` CLI.

`.git-sync/` is regenerated/refreshed by the plugin on every `prepareCommit()` call (`src/filter.ts:ensureFilter`, `refreshMachineSidecar`; `src/lock.ts:writeSyncState`).

---

## Module Map and Dependency Direction

```
index.ts        extension boundary: commands + lifecycle hooks
   │
   ├── sync.ts        orchestrators (init / link / sync / reset / status / vault / plugins)
   │      ├── filter.ts   git drivers, filter.mjs, machine sidecars
   │      ├── security.ts allowlist/denylist, ignore block, secret scanners
   │      ├── vault.ts    AES-256-GCM payload, password cache, hashes
   │      ├── remote.ts   remote address parsing
   │      ├── plugins.ts  plugin declaration mirror + `omp` CLI apply path
   │      ├── git.ts      the only git subprocess wrapper
   │      ├── lock.ts     mutex, lock file, state.json, subagent guard
   │      └── config.ts   agent dir + omp-sync.jsonc
   │
   ├── git.ts         (lifecycle hooks call primitives directly, see below)
   └── lock.ts
```

Rules that follow from this shape:

- **Only `git.ts` spawns git.** Every other module calls `git(args, dir, timeout?)`, `gitRaw()`, or a typed helper from `src/git.ts`. Adding an `execFile("git", …)` elsewhere duplicates `gitEnv()` (ceiling directory, prompt suppression, author identity) and breaks the isolation guarantees.
- **Only `plugins.ts` spawns `omp`** (a fixed argv via `execFile`, never a shell), and only for the four mutating plugin actions. `deps.omp` is the test seam; the snapshot path never shells out at all, so a machine without the CLI still syncs its declarations.
- **`vault.ts` is a leaf.** It imports only `node:crypto`, `node:fs/promises`, `node:path`. Keep it that way: it is the module whose correctness matters most, and it must stay testable without git or config.
- **`remote.ts` is pure.** Two functions, no I/O. Parsing rules belong here, not in `sync.ts`.
- **`config.ts` ↔ `security.ts` is a real import cycle.** `config.ts` imports `DEFAULT_ALLOWED_PATHS`/`isDenied`, `security.ts` imports `isValidExtraPath`. It is safe only because both modules reference each other **inside function bodies** (`readConfig`, `isValidExtraPath`, `ensureIgnoreRules`), never during module evaluation. Do not introduce a top-level `const` that reads the other module's binding.
- **`git.ts` imports `vault.ts`** (mid-file, for `hasLocalChanges`) — the low-level layer reaching up for vault status. It works, but treat it as an exception: new git-layer code should take the answer as a parameter rather than importing another module's state check.
- **`index.ts` calls low-level primitives for the shutdown path** (`prepareCommit`, `commitLocalChanges`, `pushOrigin`, `countAheadBehind`) instead of `runSync`, because the host caps `session_shutdown` handlers (~2 s in omp) and the path must be non-interactive. A new *user-visible* workflow belongs in `sync.ts`; only the exit path may shortcut.
- **Zero runtime dependencies.** `package.json` has no `dependencies`; `@oh-my-pi/pi-coding-agent` is a `peerDependency` used for types only (`import type { ExtensionAPI, … }` in `src/index.ts`). Anything that must run inside the managed repository (the filter driver) has to work with a bare Node 22 install.

---

## The Synced Data Flow

```
 worktree file  ──(git clean filter)──▶  index blob  ──(commit)──▶  local repo  ──(push)──▶  remote
      ▲                                     │                                                      │
      │                                     │ machine-local values removed here                   │
      └──(git smudge filter + sidecar)──────┴────────────(fetch/rebase)◀──────────────────────────────┘
```

- **Clean** strips machine-local keys (`DEFAULT_MACHINE_LOCAL_YAML`, `DEFAULT_MACHINE_LOCAL_JSON`, MCP `command`/`args`/`env`) so a shared commit never carries another machine's paths.
- **Smudge** merges the local sidecar back so the worktree copy stays complete for omp.
- Sidecars must be refreshed **before** anything checks out (`prepareCommit` → `refreshMachineSidecar`), otherwise the committed (machine-neutral) copy replaces the local one and the machine-local half is lost. `runLink` and `runReset` call the full prepare sequence after their checkout for exactly this reason.
- Mechanical consequence: a worktree edit that only touches machine-local fields produces **no** staged diff, and `commitLocalChanges` returns `false` for it (guard: `git diff --cached --name-only` empty → no commit).

Details and the per-key plumbing live in [`machine-local-sync.md`](./machine-local-sync.md).

---

## Where New Code Goes

| New thing | Home | Notes |
| :--- | :--- | :--- |
| Slash command or flag | `src/index.ts` (routing) + `src/sync.ts` (orchestrator) | Add to `getArgumentCompletions`, the usage string, and the README command table |
| Sync/commit step | `src/sync.ts` | Reuse `prepareCommit` / `commitLocalChanges`; never re-implement staging |
| Git invocation | `src/git.ts` | Keep it a thin, typed wrapper over `git()` |
| Ignore/deny decision | `src/security.ts` | See the multi-site change map before editing |
| Machine-local filtering | `src/filter.ts` (+ key defaults in `src/config.ts`) | The filter script and the sidecar must agree |
| Credentials handling | `src/vault.ts` | Never let plaintext leave `vault.enc` |
| Plugin declaration / `omp` CLI action | `src/plugins.ts` | Keep the snapshot read-only; never hand-edit `<config root>/plugins` |
| New config key | `src/config.ts` | Plus consumer, README, and a `test/config.test.ts` case |

Avoid new files: all ten modules have an established owner for their concerns, and `src/*.ts` is the shipped surface (`files` in `package.json` includes `src`, but `omp.extensions` points at `dist/index.js`).
