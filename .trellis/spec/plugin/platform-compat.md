# Platform Compatibility

> Windows, macOS, and Linux are all first-class targets (see `README.md` → Cross-Platform Compatibility). These rules exist because a real user hit each one.

---

## Paths

- Build paths with `path.join` / `path.resolve`; the only place a separator is normalized by hand is a security/ git-boundary decision, where lowercasing and `\\ → /` conversion happen together (`isDenied`).
- `isDenied` must stay case- and separator-insensitive: `C:\Users\x\.omp\agent\auth.json`, `extensions\secrets\api_key.json`, `Extensions/Secrets/TOKEN.txt`, and `agent.DB-wal` are all denied (`test/cross-platform.test.ts`).
- Case-insensitive filesystems (APFS/HFS+, Windows) mean two paths differing only in case are the same file. Never write a test or a comparison that depends on case sensitivity; the repo's own tests assert denial, not path identity.
- `PI_CODING_AGENT_DIR` accepts `~`-prefixed and backslash paths; `dirOf` expands `~` and resolves (test covers both `C:\…` and `~/…`).

## Git Subprocess Environment

- `GIT_CEILING_DIRECTORIES` is set to the **parent** of the agent dir and normalized to forward slashes (`C:\Users\tester\.omp` → `C:/Users/tester/.omp`). Backslashes in that variable are consumed as escapes on some Git-for-Windows builds, which would let git walk up into the user's home. `test/cross-platform.test.ts` asserts the value contains no backslash.
- `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from blocking the agent process.
- Author/committer identity is injected by `gitEnv`, so neither CI nor the test suite needs a global `git config` (CI still sets one defensively).
- Filter commands are shell-quoted with `process.execPath` and the script path both converted to forward slashes (`formatFilterCommand`) — git runs filter commands through a shell, and a Windows backslash path would be read as an escape sequence.

## Line Endings

- `stripJsonComments` is written so CRLF survives: a `//` comment terminated by `\r\n` emits `\r\n`, not a lone `\n`.
- The generated filter script detects the input's line ending and re-joins with it, so a CRLF `config.yml` stays CRLF after a round trip.
- When parsing multi-line git output, split with `/\r?\n/` (the pattern used throughout `src/`) — never `"\n"` alone.

## Filesystem Quirks

- `safeRenameBackup` (`src/sync.ts`) tries `fs.rename` first; endpoint DLP filter drivers and some network/overlay filesystems refuse same-directory renames with `EXDEV`/`EPERM`, so it falls back to `copyFile` + `rm`. Both branches are best-effort: a failed backup must not abort a link.
- Backups of locally differing files use the suffix `.local-backup`, which is itself hard-denied (see `security-guards.md`).
- `atomicWriteFile` (vault.ts) writes to `<target>.<random>.tmp` then renames, retrying after `rm` when the rename fails — the same Windows/network failure mode.
- The cross-process lock is created with `fs.open(lock, "wx")`, written, and **closed immediately**; the lock is identified by its path and payload, never by holding an open descriptor. Holding the fd would deadlock on Windows when another process needs to remove or replace it.

## Testing Cross-Platform Behaviour

`test/cross-platform.test.ts` is the place for path/separator/line-ending rules; it exercises pure functions (`dirOf`, `stripJsonComments`, `gitEnv`, `isDenied`, `generateFilterScript`) rather than spinning up a second OS. Keep new cross-platform assertions there, and avoid asserting host-specific absolute prefixes — assert on substrings (`includes("custom-agent")`) as the existing tests do.

Real end-to-end sync behaviour is OS-independent by construction: `test/helpers.ts` builds a **local bare repository** as the remote, so no test depends on network, credentials, or platform-specific git configuration.
