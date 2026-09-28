# Security Guards

> The rules that keep plaintext secrets, databases, and runtime state out of the synced repository.

---

## The Four Tiers

| Tier | Where | What it does | Source |
| :--- | :--- | :--- | :--- |
| 1. Inverted allowlist | `.gitignore` managed block in the agent dir | `*` ignores everything, then `!` rules re-include the allowlist entries, then the hard denylist patterns re-ignore what lives inside allowed directories | `src/security.ts:ensureIgnoreRules`, `allowRules` |
| 2. Local exclude | `.git/info/exclude` | Same hard denylist patterns appended to the per-clone exclude file, so they still apply if `.gitignore` is edited or removed | `ensureInfoExclude` |
| 3. Staging blocker | `git diff --cached --name-only -z` before every commit | A denied path in the index → `git reset` + `throw REFUSED to commit sensitive paths: …` | `stagedSecretFiles`, used by `commitLocalChanges` |
| 4. Tracked scanner | `git ls-files -z` | Reports files already in history: `runInit` throws, `runLink`/`runSync` warn, `showStatus` shows a 🚨 block with `git rm --cached` guidance | `trackedSecretFiles` |

Tier 3 is the only *hard* stop on the write path. Never soften it to a warning, and never bypass staging (`git add`, `git commit`) outside `commitLocalChanges`.

## One Policy, Two Representations

`isDenied(file)` is the runtime predicate; `HARD_DENY_PATTERNS` is the gitignore-pattern form of the same policy. They are maintained by hand and **must change together**, along with the README "What NEVER Syncs" list.

`isDenied` normalizes to lowercase with `/` separators (so Windows paths are covered), then:

- **Explicit allow:** a basename of `vault.enc` / `.vault.enc` returns `false` immediately — the encrypted vault is the one file whose name matches the "secret" spirit and is still synced.
- **Denied segments:** any path part in `sessions`, `state`, `blobs`, `terminal-sessions`, `cache`, `natives`, `logs`, `run`, `wt`, `.git-sync`, `node_modules`, `npm`, `git`, `bin`.
- **Denied basenames:** starts with `auth`; contains `token`, `secret`, `credential`, `key`; `.env` / `*.env` / `*.env.*`; `*.local.json`, `*.local.yml`, `*.local.yaml`, `*.local-backup`; `last-changelog-version`; `*.db`, `*.db*`, `*.sqlite*`.

The `key` substring rule deliberately over-blocks names like `keybindings.json`. That is an accepted trade-off (fail closed); if a legitimate file is blocked, add a narrowly-scoped exception rather than removing the substring rule.

## Allowlist and Exclusions

- `DEFAULT_ALLOWED_PATHS` (`src/security.ts`) is the sync set: `.gitignore`, `.gitattributes`, `config.yml|yaml`, `mcp.json`, `settings.json`, `AGENTS.md`/`Agents.md`, `omp-sync.jsonc|json`, `git-sync.jsonc|json`, `vault.enc`, `.vault.enc`, and the directories `extensions`, `skills`, `agents`, `chains`, `prompts`, `themes`, `plugins`.
- `extraPaths` (config) are validated by `isValidExtraPath`: non-empty, no `..`, not absolute, and not denied. Invalid entries are dropped silently; missing this validation would let a user add a path the guards then refuse to commit, producing confusing failures.
- `excludePaths` (config) removes an allowlisted entry from the sync set (both the `.gitignore` rules and the allowlist evaluation). An entry that is *not* syncable produces the warning `excludePaths entry "…" is not a syncable path; ignored`.
- `ensureIgnoreRules` rewrites the managed block in place: everything outside `START_MARKER`/`END_MARKER` is preserved, current and two legacy marker pairs (`pi-config-sync`, `pi-git-sync`) are stripped before re-adding, so repeated runs are idempotent.

## Changing This Area

Adding a new allowlisted path — update together:

1. `src/security.ts:DEFAULT_ALLOWED_PATHS`.
2. Any consumer that reasons about the set: `src/config.ts:readConfig` allowlist comparison, `README.md` allowlist table.
3. A case in `test/security.test.ts` (ignore rules) and, if it is a structured file, `test/filter.test.ts`.

Adding a new denied category — update together:

1. `src/security.ts:HARD_DENY_PATTERNS` (gitignore form).
2. `src/security.ts:isDenied` (runtime form; add to `deniedSegments` for path parts, or the basename chain for filename patterns).
3. `README.md` denylist section.
4. A case in `test/security.test.ts` (blocked list) and, for path-shape rules, `test/cross-platform.test.ts`.

Anti-patterns:

- Editing `.gitignore` by hand inside the managed block — the next `prepareCommit` overwrites it.
- Adding a path to the sync set without the allowlist entry: it commits nothing and looks like "sync is broken".
- Handling secrets by *name only* in one place (`auth*`) while the vault's `SYNCABLE_SENSITIVE_FILES` list implies a different set — see [`credentials-vault.md`](./credentials-vault.md).
- Logging file contents while diagnosing guards; paths and names are fine, values are not.
