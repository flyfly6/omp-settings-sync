# omp-settings-sync Plugin Guidelines

> Conventions for every module under `src/`, plus the tests that exercise them.

---

## Overview

One package, one runtime layer: an omp extension written in TypeScript (ESM, `NodeNext`) that runs inside the omp process. There is no server, no UI framework, and no database — the "backend" is the git command line and the user's own `~/.omp/agent` directory.

Verified shape of the codebase:

| Module | Lines | Responsibility |
| :--- | ---: | :--- |
| `src/sync.ts` | 806 | Orchestrators (`runInit`, `runLink`, `runSync`, `runReset`, `showStatus`, vault commands), commit pipeline, progress/notify helpers |
| `src/filter.ts` | 409 | Git clean/smudge drivers, generated `.git-sync/filter.mjs`, machine-local sidecars, MCP field handling |
| `src/vault.ts` | 297 | AES-256-GCM credentials vault, password cache, sensitive-file hashing |
| `src/config.ts` | 242 | Agent-dir resolution, `omp-sync.jsonc` parsing, machine-local key defaults, UI/deps types |
| `src/git.ts` | 237 | The only place that spawns `git`; environment, timeouts, divergence and conflict helpers |
| `src/security.ts` | 204 | Allowlist, hard denylist, managed `.gitignore` block, staged/tracked secret scanners |
| `src/index.ts` | 175 | Extension boundary: command registration, lifecycle hooks, background tick |
| `src/lock.ts` | 152 | In-process mutex + cross-process lock file, sync state, subagent detection |
| `src/remote.ts` | 47 | Remote address parsing (`owner/repo`, HTTPS, scp-style SSH, local paths) |

Tests: `test/*.test.ts` (1 164 lines, `node:test`), fixtures in `test/helpers.ts`.

---

## Pre-Development Checklist

Before writing code, read the topic file(s) for the area you are changing:

- [ ] [`architecture.md`](./architecture.md) — module boundaries, dependency direction, where new code belongs.
- [ ] [`extension-api.md`](./extension-api.md) — anything touching `src/index.ts`: commands, events, `ctx`, notifications, progress, lifecycle timing.
- [ ] [`sync-engine.md`](./sync-engine.md) — anything touching `src/sync.ts` or `src/git.ts`: commit/fetch/integrate/push order, error policy, push races.
- [ ] [`machine-local-sync.md`](./machine-local-sync.md) — allowlisted files whose contents partially stay local: `.gitattributes` filters, `filter.mjs`, sidecars, `mcp.json`, `config.yml`, `settings.json`.
- [ ] [`security-guards.md`](./security-guards.md) — anything that can change what gets committed: allowlist, denylist, ignore block, scanners.
- [ ] [`credentials-vault.md`](./credentials-vault.md) — `vault.enc` format, passphrase cache, sensitive-file set.
- [ ] [`configuration.md`](./configuration.md) — `omp-sync.jsonc` keys, defaults, lenient parsing, agent-dir resolution.
- [ ] [`platform-compat.md`](./platform-compat.md) — any path, line-ending, rename, or subprocess change (Windows/macOS/Linux all supported).
- [ ] [`testing.md`](./testing.md) — before adding or changing tests.
- [ ] [`../guides/index.md`](../guides/index.md) — always; the multi-site change map prevents most incomplete changes.

State the change boundary before coding when the change touches more than one module, crosses the workspace boundary (local ↔ committed copy), or changes a public command. Say which files change and why.

---

## Quality Check

Before handing off a change:

- [ ] `npm run typecheck` passes (covers `src/` and `test/`).
- [ ] `npm test` passes (`tsc` build + `node --test dist-test/test/*.test.js`).
- [ ] No new runtime dependency was added; only `node:` builtins and the existing `src/` modules are imported.
- [ ] No `console.log` in `src/` — user-visible output goes through `notify()` / `ctx.ui` (see `extension-api.md`).
- [ ] Any multi-site change (allowlist entry, denied pattern, machine-local key, sensitive file, command) updated **every** site listed in `../guides/code-reuse-thinking-guide.md`.
- [ ] `dist/` was rebuilt and included when the change affects shipped behaviour (`npm run build`).
- [ ] README sections that document the touched behaviour were updated (`README.md`).
- [ ] No secrets, absolute machine paths, or hostnames were added to any file under `src/` or `test/`.

---

## Quick Commands

```bash
npm run typecheck    # tsc --noEmit for src and test
npm test             # build + run the node:test suite
npm run check        # typecheck + test (same gate CI uses)
npm run build        # regenerate dist/ (committed build output)
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run check` on Node 22.x and 23.x with a pre-set global git identity; `publish.yml` runs the same check before `npm publish` on `v*` tags.
