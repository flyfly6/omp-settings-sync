# Cross-Layer Thinking Guide

> Five boundaries decide whether this plugin is correct. Map them before you change data flow.

---

## The Boundaries

```
 omp process ──worktree──▶ [clean filter] ──index──▶ local repo ──push──▶ remote (git host)
     ▲                          ▲                        │                    │
     │                          │ .git-sync/ sidecars    │   rebase/fetch     │
     └──[smudge filter]─────────┴────────checkout────────┴────────────────────┘
```

| # | Boundary | What can go wrong |
| :--- | :--- | :--- |
| 1 | worktree ↔ index (filters) | `clean` removes more than `smudge` restores; sidecar captured after the checkout it was meant to protect; `.gitattributes` rule stale from an older release |
| 2 | index ↔ local repo | secrets staged (tier-3 scanner must catch it); empty commit when only machine-local fields changed; `vault.enc` re-encrypted needlessly |
| 3 | local repo ↔ remote | ff-only/rebase failure leaves a half-applied history; push rejected by a concurrent push; remote deleted or unreachable; `vault.enc` conflict |
| 4 | repository ↔ `.git-sync/` | local state (passphrase key, hashes, sidecars, lock) must never be committed and must survive a `reset --hard` + `clean -fd` |
| 5 | `src/` ↔ shipped artifact | `dist/` is what omp loads; an uncommitted build means a fixed bug that users cannot get |
| 6 | extension ↔ host | `session_shutdown` has a ~2 s budget; UI methods are optional; after a pull the host still holds the old config until `/reload` |

## Per-Boundary Checklist

**1. Filters**

- [ ] Every key `clean` drops is captured by `refreshMachineSidecar` before any checkout.
- [ ] `clean` and `smudge` are symmetric for each of `yaml`, `json`, `mcp`.
- [ ] Changing the filter's JSON payload/keys means re-normalizing tracked files (`git add --renormalize`).
- [ ] Existing installs with an older `.gitattributes` rule still migrate (the stale `mcp.json filter=` rule is dropped and re-added by `ensureAttributes`).

**2. Index and commits**

- [ ] Staging happens only in `commitLocalChanges` (so tier-3 runs).
- [ ] A worktree edit that changes only machine-local fields must not create a commit.
- [ ] Vault re-encryption is gated by `hasSensitiveChanges`.

**3. Remote integration**

- [ ] `integrateUpstream` returns `false` only after aborting; the caller decides reset-vs-throw.
- [ ] Push retry on rejection is exactly one fetch+integrate+push.
- [ ] A remote update to `vault.enc` is decrypted with the cached passphrase when the vault is unlocked.
- [ ] After a pull, `mcp.json` stubs are reported (`mcpServersMissingLocalValues`) so the user knows to add local launcher values.

**4. Machine state**

- [ ] New state files go into `.git-sync/` and are covered by the hard denylist.
- [ ] State survives (or is deliberately rebuilt after) `reset --hard`, `clean -fd`, and a `checkout -B` from `origin/<branch>`.
- [ ] Anything placed in `.git-sync/` is reproducible from the worktree — the next `prepareCommit` should recreate it.

**5. Build and release**

- [ ] `npm run build` was run and `dist/` committed when shipped behaviour changed.
- [ ] `npm run check` passes (the only gate; the `prepare` script runs the build for git/npm installs).
- [ ] `package.json` `version` bumped for a publishable change; `omp.extensions` still points at `./dist/index.js`.

**6. Host contract**

- [ ] User-visible workflows live in `src/sync.ts`; only the exit path shortcuts to primitives.
- [ ] Non-interactive paths still complete when `ctx.ui.input`/`confirm` are absent.
- [ ] The user is told to run `/reload` when pulled config should take effect.

## Real Examples From This Repository

- **Stale filter rule (boundary 1):** releases before MCP-aware syncing routed `mcp.json` through the JSON driver, so upgraded installs kept committing launcher commands. Fix: `ensureAttributes` drops `filter=` rules it owns and re-normalizes. Regression test: `test/mcp-sync.test.ts` → "a stale mcp.json filter rule from an older release is retargeted".
- **Shutdown budget (boundary 6):** awaiting the exit sync inside `session_shutdown` timed out against omp's 2 s cap. Fix: detached IIFE that lets the pending git child keep the process alive; anything unflushed is retried on the next start or interval tick.
- **Empty-commit guard (boundary 2):** machine-local-only edits produced "nothing to commit" failures until the `git diff --cached` check was added.
- **Backup rename failures (boundary 4/1):** DLP filter drivers refused `.local-backup` renames with `EXDEV`; the copy fallback exists for that.

## When To Write A New Boundary Doc

Only when a boundary gains a second consumer (for example, a second format driver, or another host event that writes state). Until then, keep the rule in `plugin/` and this guide.
