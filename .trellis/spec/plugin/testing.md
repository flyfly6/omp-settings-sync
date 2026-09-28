# Testing

> `node:test` + real git + temporary directories. No mocking framework, no test dependencies.

---

## Harness

- Tests live in `test/*.test.ts`, one file per module or concern: `config`, `security`, `vault`, `filter`, `git-ops`, `lock`, `progress`, `extension`, `cross-platform`, `mcp-sync`, `plugins`, `end-to-end`.
- Imports: `node:test`, `node:assert/strict`, and the code under test via relative ESM specifiers that keep the `.js` extension: `import { runInit } from "../src/sync.js"`.
- Execution path: `tsconfig.test.json` compiles `src/**` + `test/**` into `dist-test/` (`rootDir: "."`), then `node --test --test-concurrency=4 dist-test/test/*.test.js` runs the results. `dist-test/` is gitignored.

```bash
npm test                                      # build + build:test + full suite
npm run build:test && node --test dist-test/test/vault.test.js   # single file
npm run typecheck                             # src and test, no emit
```

`npm run check` (typecheck + test) is the whole gate — there is no CI workflow in this repository, so run it before every commit. There is no watch mode, no coverage tooling, and no lint step either; the Quality Check in [`index.md`](./index.md) is the review standard.

## Fixtures

`test/helpers.ts` is the only shared fixture module:

- `createMachineFixture(name)` → `{ root, dir }`: a `mkdtemp` root with `agent/` containing `config.yml` (with `setupVersion`), `mcp.json`, `AGENTS.md`, `extensions/custom.ts`, and `auth.json`.
- `createBareRemote(root, name = "origin.git")` → path to a local **bare** repository, used as `origin` by every end-to-end test.
- On import it sets git author/committer environment variables and **deletes** `PI_SUBAGENT_DEPTH`, `OMP_SUBAGENT_DEPTH`, `OMP_IS_SUBAGENT`, so the subagent guard never suppresses sync in tests. Keep that block at the top of the module; a new helper file would have to repeat it.

`test/plugins.test.ts` adds two file-local conventions: it deletes `XDG_DATA_HOME` (the plugin-root probe consults it) and writes the plugin registry as a *sibling* of the fixture agent dir (`<root>/plugins/{package.json,omp-plugins.lock.json}`) so the default `dirname(agentDir)/plugins` probe resolves naturally. The real `omp` CLI is never spawned in tests — `deps.omp` records argv and returns `{ stdout: "" }`.

Conventions to follow:

- Real git, real filesystem, no mocks. Assertions read files back (`fs.readFile`), inspect git (`gitRaw(["show", "main:config.yml"], dir)`), or check behaviour via returned values / captured notifications.
- Use `deps = { dir, notify }` and pass `ctx = undefined` for non-UI paths; collect notifications into an array (`const warnings: string[] = []`) and assert on their text. UI-only paths get a stub `ctx` with `hasUI: true` and hand-rolled `ui` methods (`test/progress.test.ts`).
- Error contracts: `assert.rejects(() => runInit("", …), /repository URL is required/)` — match on the actionable substring, not the whole message.
- Environment mutation (`PI_CODING_AGENT_DIR`, `OMP_PROFILE`) is always saved and restored in a `try/finally`, as in `test/config.test.ts` and `test/cross-platform.test.ts`.
- Temp directory prefixes name the area and case (`omp-lock-concurrent-`, `omp-vault-hash-`) so a failure leaves identifiable debris in the OS temp dir.

## What To Assert

Assert the observable contract, not the implementation:

- Good: the committed blob has machine-local fields removed while the worktree keeps them (`test/mcp-sync.test.ts`, `test/filter.test.ts`); `auth.json` is restored after linking with the passphrase; vault status transitions `disabled → locked → unlocked`; a denial list entry is refused; a second machine ends up with machine A's file content.
- Bad: counting `git` spawns, checking that a specific function was called, or asserting an internal intermediate file exists without any path through the public API requiring it.

## Adding Tests

1. Pick the file matching the module you changed; only add a new file when a new concern appears (e.g. a new format driver).
2. One behaviour per `test("…")`, named as a sentence describing the behaviour (existing style: `"runSync automatically reconciles and retries push on race condition"`).
3. Prefer a case in an existing file over a new fixture — the e2e helpers already cover init → link → sync round trips.
4. Keep it deterministic: no network, no timers, no host-specific paths, fixed passphrases (`"ResetPass123!"`, `"Pass"`).

Known gaps (do not assume coverage): interactive prompts are only exercised through injected `options.password`, the detached `session_shutdown` sync has no test, and `shouldAutoSync()`/`warnOnPublicRemote` are untested because nothing calls them.
