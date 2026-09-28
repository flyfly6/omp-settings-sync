# Sync Engine

> `src/sync.ts` (orchestrators) and `src/git.ts` (the only git process layer).

---

## The Commit Pipeline

Every committed state passes through the same three steps, in this order:

1. **`prepareCommit(deps?, ctx?)`** — regenerates everything derived: `.gitignore` block + `.git/info/exclude` (`src/security.ts`), `.gitattributes` + filter config + `.git-sync/filter.mjs` (`src/filter.ts:ensureAttributes/ensureFilter`), the three machine-local sidecars (`refreshMachineSidecar`), and re-encrypts `vault.enc` **only when** the vault is unlocked and `hasSensitiveChanges()` is true.
2. **`commitLocalChanges(deps?, commitMessage?, ctx?)`** — calls `prepareCommit` itself, so callers never have to; returns `false` (no commit) when the worktree is clean.
3. **push** — `pushOrigin(first, dir)` returns a boolean; failures are surfaced by the caller, not thrown.

Ordering invariants:

- Nothing may checkout, rebase, or reset before `prepareCommit` runs: the sidecars snapshot machine-local values from the **current** worktree, and once the committed copy lands those values are gone.
- `commitLocalChanges` guards staging with `stagedSecretFiles(dir)`; a hit triggers `git reset` and a thrown `REFUSED to commit sensitive paths: …`. Never downgrade that to a warning, and never `git add` outside this function.
- The machine-local filter can make a worktree edit produce an empty staged diff; the `git diff --cached --name-only` check exists to avoid empty commits. Deleting it would resurrect "nothing to commit" failures.
- Commit messages: `<message>` or `omp config: auto-sync from <hostname>`; the hostname suffix is skipped when `includeHostname === false`.

## Orchestrators

| Function | Contract |
| :--- | :--- |
| `runInit(arg, ctx?, deps?, options?)` | Resolves the remote **first** (a URL-less run must not leave a committed repo with no `origin`); re-init only when the remote is unreachable or `--force` was passed (then old `origin` is removed); optional interactive vault setup; `git init -b main`; refuses when `trackedSecretFiles` is non-empty; initial commit (skipped if the tracked-secret check failed); `remote add origin`; throws when the first push fails. |
| `runLink(arg, ctx?, deps?, options?)` | Refuses when already linked to a reachable remote unless `--force`; keeps commits that have no `origin` on an `omp-local-<timestamp>` branch; `fetch` → `defaultBranch()` (from `ls-remote --symref origin HEAD`, default `main`) → backs up locally differing files as `<file>.local-backup` → `checkout -B <branch> origin/<branch>` (retries once after backing up files git refused to overwrite, skipping denied paths) → sets upstream → optional vault decrypt → warns about tracked secrets → tells the user to `/reload`. |
| `runSync(ctx, {auto, push, skipPull?, discardLocal?}, deps?)` | The full loop; see below. |
| `runReset(ctx, deps?)` | `fetch` → `reset --hard origin/<branch>` → `clean -fd` → re-run prepare steps → restore the vault when unlocked → `/reload` hint. Used by `/ompsync reset`, `--discard-local`, and `config.preferRemote`. |
| `showStatus(ctx, deps?)` | Reads divergence, dirty state, tracked secrets, vault status, conflict state; prints the conflict block, including `vault.enc`-specific `checkout --theirs/--ours` guidance. |
| `checkAndBackgroundSync(ctx, deps?)` | Returns without work for subagent children / non-repo dirs; syncs only when local changes exist **or** the remote-check interval (`shouldCheckRemote`, default 5 min) elapsed; records `lastRemoteCheckAt` / `lastAutoSyncAt`; runs inside `withLock` and returns `false` when the lock is busy. |

### `runSync` sequence

```
prepareCommit + tracked-secret warning
  → commitLocalChanges            (records "committed local changes")
  → fetchOrigin; unreachable remote → notify + return (auto runs stay silent)
  → behind > 0 → integrateUpstream
        success → "pulled updates"
                  → mcpServersMissingLocalValues warning
                  → vault.enc refresh when unlocked + password cached
        failure → config.discardLocalOnConflict ? runReset() : throw (rebase already aborted)
  → push when ahead > 0 (or when no upstream: push -u origin HEAD)
        push rejected → fetch → integrate → push once more   ("race" recovery)
  → progress 100 + summary notify ("Run /reload to apply pulled config.")
```

Divergence handling lives in `src/git.ts:integrateUpstream`: try `merge --ff-only <upstream>`, else `rebase <upstream>`, else `rebase --abort` and return `false`. Callers decide whether `false` means "reset" or "throw" — keep that decision in `runSync`, not in the helper.

## Git Process Layer Rules

- `git(args, dir, timeout = 15_000)` and `gitRaw()` (buffer output, 64 MB) are the only executors. Mutating verbs (`add`, `commit`, `rebase`, `merge`, `reset`, `checkout`, `pull`, `push`) first run `cleanStaleIndexLock()` which removes a `index.lock` older than 15 s.
- `gitEnv(dir)` is mandatory for isolation: `GIT_CEILING_DIRECTORIES` = parent of the agent dir (with backslashes normalized to `/`) so git cannot walk up into the user's home; `GIT_TERMINAL_PROMPT=0` so a credential prompt can never hang the agent; fixed author/committer identity so tests and CI need no global git config.
- Timeouts are part of the contract: 8 s for `ls-remote --heads` (`isRemoteReachable`), 20 s for `push`, 15 s default. Anything slower must be a deliberate change, not an omission.
- Predicates are cheap and never throw: `hasDotGit`, `hasCommits`, `isSyncableRepo` (dot-git **and** an `origin` remote), `hasLocalChanges` (worktree dirty or, when the vault is unlocked, sensitive files changed), `hasRemoteChanges` (fetch + ahead/behind), `hasAnyChanges`.
- `isSyncableRepo` gates every public entry point. A directory that is not a repo with `origin` is "not initialized", never an error.
- `countAheadBehind` uses `rev-list --left-right --count <upstream>...HEAD`; `getConflictState` detects `.git/rebase-merge` / `.git/rebase-apply` / `MERGE_HEAD` plus `U*` status codes; `getSyncDivergence` bundles branch + upstream + ahead/behind for `showStatus`.

## Concurrency

- `withLock(ctx, fn, deps?)` (`src/lock.ts`) is the only mutual exclusion: an in-process mutex acquired **before** any filesystem await (so same-process callers queue in call order), then a `.git-sync/lock` file holding `{pid, startedAt}` — held only for the duration of `fn`, released in `finally`, and stolen when the recorded pid is dead or the lock is older than 10 minutes.
- A busy lock returns `undefined` rather than queueing. Callers must treat `undefined` as "another sync is running": `checkAndBackgroundSync` returns `false`, the command handler just does nothing.
- Never take the lock by hand; never nest `withLock` (the in-process mutex is not re-entrant).

## Error Policy

| Situation | Behaviour |
| :--- | :--- |
| User must act (no URL, already linked, tracked secrets, push failed, conflicts) | `throw new Error("<actionable message>")` → handler notifies as error |
| Remote unreachable during an auto/background run | notify warning, return |
| `fetch` fails but the remote answers `ls-remote` | notify warning, skip pull/push |
| Exit-path sync (`session_shutdown`) | errors swallowed entirely |
| Cleanup (`rebase --abort`, `reset` of the index, lock removal, stale lock delete) | best-effort `.catch(() => {})` |

Anti-patterns seen in review: adding a `throw` to a best-effort cleanup, swallowing an error that the user must know about, and reporting sync problems with `console.log` instead of `notify()`.
