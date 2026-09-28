# Code Reuse Thinking Guide

> Search before you write. In this repository the expensive mistake is not duplicated code — it is a **policy edited in one of its representations**.

---

## Rule 0: Search Before Changing A Value

```bash
grep -rn "DEFAULT_ALLOWED_PATHS\|HARD_DENY_PATTERNS\|SYNCABLE_SENSITIVE_FILES" src test
```

Every list in this codebase has at least two representations (runtime logic and a git-level or documentation form). Changing one without the other is the single most common defect class here.

## The Multi-Site Change Map

| You are changing | Update all of these |
| :--- | :--- |
| A syncable path | `src/security.ts:DEFAULT_ALLOWED_PATHS`; consumers in `src/config.ts` (allowlist comparison) and `README.md`; `test/security.test.ts` (ignore rules) |
| A denied pattern | `src/security.ts:HARD_DENY_PATTERNS` (gitignore form) **and** `isDenied` (runtime form) **and** `README.md`; tests in `test/security.test.ts` + `test/cross-platform.test.ts` |
| A machine-local key | `src/config.ts` defaults; the matching sidecar in `src/filter.ts:refreshMachineSidecar`; the filter script's behaviour is derived, but `README.md` and the filter/mcp tests are not |
| A sensitive credential file | `src/vault.ts:SYNCABLE_SENSITIVE_FILES`; confirm `isDenied` still blocks the name; `README.md` ("What Syncs Encrypted"); `test/vault.test.ts` |
| A slash command or flag | `src/index.ts` routing + `getArgumentCompletions` + usage string; orchestrator in `src/sync.ts`; `README.md` command table; `test/extension.test.ts` for registration |
| A config key | `src/config.ts` (field + normalization); its consumer; `README.md` `omp-sync.jsonc` block; `test/config.test.ts` |
| A new git attribute / format driver | `src/filter.ts` (`ensureAttributes` rules, `generateFilterScript` format branch, `ensureFilter` config keys); `refreshMachineSidecar` capture; a test |
| Vault file format | `src/vault.ts` encrypt/decrypt **and** the `version` gate; `README.md`; `test/vault.test.ts` round-trip + tamper cases |

## The Local Reuse Inventory

Before writing a helper, check whether one of these already does it:

| Need | Use | Do not |
| :--- | :--- | :--- |
| Run git | `git()` / `gitRaw()` in `src/git.ts` | spawn `git` in another module (you would lose `gitEnv`, timeouts, stale-lock cleanup) |
| Where is the agent dir | `dirOf(deps?)` | read `process.env` directly |
| Tell the user something | `notify(ctx, text, level, deps?)` | `console.log` / `ctx.ui.notify` inline |
| Show progress | `updateSyncProgress` / `clearSyncProgress` + `STATUS_KEY` | a second status key |
| Write a file that must not be half-written | `atomicWriteFile` from `src/vault.ts` | `fs.writeFile` for state that another process may read |
| Mutually exclude sync runs | `withLock(ctx, fn, deps?)` | a bespoke lock flag |
| Access machine-local key lists | `machineJsonKeys` / `machineYamlKeys` / `mcpFields` / `mcpLocalServers` in `src/filter.ts` | reading `config.machineLocal*` directly (you would skip the defaults) |
| Validate a user-supplied path | `isValidExtraPath` in `src/config.ts` | a second `..`/absolute check |
| Warn once about a config problem | `warnConfigIssue` | an ad-hoc `stderr.write` |
| Instantiate a test machine | `createMachineFixture` / `createBareRemote` | new temp-dir boilerplate |

## Where Duplication Is Accepted

- `HARD_DENY_PATTERNS` vs `isDenied`: two shapes of one policy, kept in sync by hand. A shared generator was rejected — the gitignore form is a pattern list and the runtime form is segment/basename logic, and the mapping is not mechanical.
- `src/sync.ts` re-states vault status text for `showStatus`. It is presentation, not policy.
- `utils`-style modules: none exist and none should be created. Helpers live next to their single concern (`git.ts` for processes, `vault.ts` for file integrity, `filter.ts` for machine-local data).

## Checklist Before Commit

- [ ] Grepped each constant/list I touched for other representations.
- [ ] No new module duplicates a git spawn, a lock, or a path-resolution helper.
- [ ] Machine-local keys flow from `src/config.ts` defaults through the `machineJsonKeys`/`mcpFields` accessors — no literal key arrays introduced elsewhere.
- [ ] Docs (`README.md`) and the relevant test list both reflect the change.
- [ ] If the change ships in `dist/`, it was rebuilt.
