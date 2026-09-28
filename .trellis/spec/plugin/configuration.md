# Configuration and Path Resolution

> `src/config.ts` (agent dir, `omp-sync.jsonc`, UI types) and `src/remote.ts` (remote addresses).

---

## Agent Directory Resolution

`dirOf(deps?)` is the single source of truth for "where is the managed directory": `deps.dir` (used by every test and by internal callers) → `PI_CODING_AGENT_DIR` (with `~` expanded) → `~/.omp/profiles/<OMP_PROFILE>/agent` → `~/.omp/agent`, always `path.resolve`d. `expandUserPath(value)` is the exported single representation of "expand a leading `~` and resolve"; reuse it instead of copying the prefix check (`dirOf` and `pluginsRoot`'s `pluginsDir` both go through it).

Every public function takes `deps?: Deps` (`{ dir?, notify?, omp? }`) and `ctx?: Ctx`; production callers pass `ctx` for UI and tests pass `deps` for the directory, a notification collector, and (for the plugin apply path) an `omp` runner that replaces the real child process. New code must keep that pair optional — no module may read the environment directly for the agent dir.

## Config File

`readConfigFile` tries, in order, `omp-sync.jsonc`, `omp-sync.json`, `git-sync.jsonc`, `git-sync.json` — first readable file wins. All four names are part of the allowlist, so the config itself syncs.

| Key | Type | Default | Effect |
| :--- | :--- | :--- | :--- |
| `autoSyncIntervalMinutes` | number | 1 for the local-repo check (`DEFAULT_AUTO_SYNC_INTERVAL_MINUTES`); 5 for the remote check as passed by `checkAndBackgroundSync` | Reused as the remote-check interval in the background tick |
| `includeHostname` | boolean | true | `false` drops the ` from <hostname>` suffix from auto-sync commit messages |
| `extraPaths` | string[] | `[]` | Additional syncable entries; validated by `isValidExtraPath` |
| `excludePaths` | string[] | `[]` | Removes allowlisted entries from the sync set; non-syncable entries warn |
| `machineLocalSettings` | string[] | `DEFAULT_MACHINE_LOCAL_JSON` = `["lastChangelogVersion", "setupVersion"]` | JSON keys stripped by the `settings.json` driver |
| `machineLocalYamlKeys` | string[] | `DEFAULT_MACHINE_LOCAL_YAML` (`setupVersion`, `shellPath`, `dev.autoqaPush.token`, `searxng.*`, `hindsight.*`, `auth.broker.*`, `images.urls.*`, interpreter paths, `browser.cdpUrl`, …) | Top-level YAML keys stripped from `config.yml` |
| `machineLocalMcpFields` | string[] | `["command", "args", "env"]` | Per-server MCP fields kept local; `[]` syncs launchers verbatim |
| `machineLocalMcpServers` | string[] | `[]` | Server names whose whole entry is machine-local |
| `machineLocalPlugins` | string[] | `[]` | Plugin package names excluded from `plugins.json`; no sync-set warning is emitted for them |
| `pluginsDir` | string | unset | Plugin-root override for `plugins.json` (absolute or `~`-prefixed), probed before the XDG and `dirname(agentDir)/plugins` candidates; every candidate must contain a `package.json` |
| `preferRemote` | boolean | false | Forces `runSync` down the `runReset` path (discard local, take remote) |
| `discardLocalOnConflict` | boolean | false | On a failed integration, reset instead of throwing |

Array-valued keys are normalized: non-strings and blank entries are filtered out; absent keys stay `undefined` so the consumer can fall back to its default (`machineJsonKeys` etc. in `src/filter.ts`).

Two keys are declared but currently have **no reader**: `warnOnPublicRemote` (`OmpSyncConfig` only) and the exported `shouldAutoSync()` in `src/lock.ts` (the background tick calls `checkAndBackgroundSync` instead). Treat them as unfinished, not as behaviour to preserve — if you touch them, implement or delete deliberately.

## Parsing

1. `stripJsonComments` removes `//` and `/* */` while respecting quoted strings and escapes, and preserves CRLF (`\r\n` inside comments becomes a line ending, not swallowed text).
2. Strict `JSON.parse`; on failure `stripTrailingCommas` (drops commas before `}` / `]`, also quote-aware) and parse again → warning `config file has a trailing comma; parsed leniently`.
3. Still unparsable → warning `ignoring unparsable config file (<reason>)` and `{}`.

Warnings are deduplicated per message by `warnedConfigIssues` and routed through `deps.notify` → `ctx.ui.notify` → `process.stderr` (the stderr branch exists because `readConfig` is also called without any context, e.g. from `shouldAutoSync`). Reuse `warnConfigIssue` for new diagnostics instead of calling `notify` directly.

`readConfig` also validates: `extraPaths`/`excludePaths` filtered by `isValidExtraPath`, non-syncable `excludePaths` warned, machine-local arrays sanitized.

## Remote Addresses

`remoteFromArg(arg)` is strict by design — no remote is ever inferred:

- Passed through unchanged: `http(s)://`, `ssh://`, `git://`, scp-style `user@host:path`, absolute POSIX paths, `.`/`..` relative paths, Windows drive paths (`C:\…` via `^[a-zA-Z]:[\\/]`).
- `owner/repo` shorthand expands to `https://github.com/owner/repo.git` via `parseRepoReference` (which also accepts `git@github.com:owner/repo[.git]` and GitHub HTTPS URLs).
- Anything else (a bare word like `my-config`, an empty string) returns `undefined`, and `runInit`/`runLink` throw `a git repository URL is required: /ompsync <init|link> <url>`.

## Adding A Config Key

1. Field on `OmpSyncConfig` + normalization in `readConfig` (arrays sanitized, invalid values dropped with a warning).
2. Consumer: `src/sync.ts` (behaviour), `src/filter.ts` (machine-local lists), `src/lock.ts` (scheduling).
3. `test/config.test.ts` case covering the parse/validation path.
4. `README.md` `omp-sync.jsonc` example block.

Keep defaults exported as named constants next to their consumer (`DEFAULT_MACHINE_LOCAL_*` in `config.ts`, interval constants in `lock.ts`) — tests and docs reference them.
