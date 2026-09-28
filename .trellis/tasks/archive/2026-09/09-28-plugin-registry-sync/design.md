# Design: Plugin declaration mirror

## Change boundary

New module `src/plugins.ts` (plugin-root discovery, declaration read/merge/write, plan/diff, apply), one call added to `prepareCommit` in `src/sync.ts`, one command branch + completions in `src/index.ts`, one allowlist entry in `src/security.ts`, two config keys in `src/config.ts`, docs, and tests. No filter driver, no vault change, no new dependency.

## Data flow

```
omp plugin root (machine)                     agent dir (= git repo)
  package.json      ─┐
  omp-plugins.lock.json ─┴─► refreshPluginManifest() ─► plugins.json ──git──► remote
                                                             │
  omp plugin install/enable/disable/features ◄── applyPluginPlan() ◄── /ompsync plugins install
```

Read path is machine → repo; apply path is repo → machine, and the two never share a code path.

## Declaration contract — `plugins.json`

Committed file in the managed agent directory, allowlisted, **no** git filter (nothing machine-local is ever written into it; local-only entries are omitted entirely).

```json
{
  "version": 1,
  "plugins": {
    "@dietrichgebert/ponytail": {
      "spec": "^4.10.0",
      "enabled": true,
      "enabledFeatures": null
    },
    "omp-settings-sync": {
      "spec": "github:flyfly6/omp-settings-sync",
      "enabled": true,
      "enabledFeatures": null
    }
  }
}
```

- `version` exists so a future format change can gate on it (the same habit as `vault.enc`); a reader that sees an unknown `version` skips the file with a warning instead of guessing.
- Plugin map keys are package names, emitted sorted; the file is written with `JSON.stringify(…, 2) + "\n"` and compared byte-wise before writing, so an unchanged machine never dirties the worktree.
- `enabledFeatures: null` means "defaults" (host semantics: fresh installs record `null`).

## Source of truth on this machine

`<pluginRoot>/package.json` → `dependencies` (name → spec) joined with `<pluginRoot>/omp-plugins.lock.json` → `plugins[name]` (`version`, `enabled`, `enabledFeatures`).

A plugin is mirrored when **all** hold:

1. it appears in `dependencies`;
2. its spec is portable — rejected: empty, `file:`, `link:`, `workspace:`, `portal:`, `.`/`..` prefixes, `/`- or `\`-absolute, Windows drive letters, UNC (`\\`), and `~` prefixes;
3. its name is not in `machineLocalPlugins`;
4. the lock file parsed; a plugin missing from the lock is recorded as `{ enabled: true, enabledFeatures: null }` (the host's fresh-install state).

A plugin only present in the lock file (symlinked/marketplace package with no dependency entry) is skipped, not recorded — its source is not reproducible elsewhere.

`settings` is never read. That is deliberate: values can carry third-party API keys, and the denylist matches only path names, so nothing at the JSON-content level would stop a secret from being committed.

## Plugin root discovery

Read-only, best-effort, first existing `package.json` wins:

1. `pluginsDir` config key (absolute or `~`-prefixed, resolved like `dirOf` does).
2. `$XDG_DATA_HOME/omp/plugins` when `XDG_DATA_HOME` is set **and** that directory exists (host rule: XDG wins on Linux/macOS when `$XDG_DATA_HOME/omp` exists).
3. `path.dirname(agentDir)/plugins` when `path.basename(agentDir) === "agent"` **and** it exists.

Rationale: the host resolves the root as `getPluginsDir()` = `<configRoot>/plugins` with an XDG override, and `PI_CODING_AGENT_DIR` can point the agent dir anywhere, so `dirname(agentDir)/plugins` alone is wrong in two supported setups. The ordered probe plus the config override keeps the common cases zero-config and gives exotic layouts an escape hatch instead of a silent no-op.

Nothing found → `refreshPluginManifest` returns without writing (R3). Never delete an existing `plugins.json`.

## Modules and contracts

`src/plugins.ts` (new, ~180 lines):

```ts
export const PLUGIN_MANIFEST_FILE = "plugins.json";
export const PLUGIN_MANIFEST_VERSION = 1;

export interface PluginDeclaration { spec: string; enabled: boolean; enabledFeatures: string[] | null }
export interface PluginManifest { version: number; plugins: Record<string, PluginDeclaration> }

export function isPortablePluginSpec(spec: string): boolean;
export function pluginsRoot(dir: string, config: OmpSyncConfig, probe?: (p: string) => boolean): string | undefined;
export async function readLocalPlugins(dir: string, config: OmpSyncConfig): Promise<PluginManifest | undefined>;
export async function refreshPluginManifest(dir: string, config: OmpSyncConfig, deps?: Deps): Promise<void>;
export async function readPluginManifest(dir: string): Promise<PluginManifest | undefined>;
export function pluginPlan(manifest: PluginManifest, local: PluginManifest): PluginAction[];
export async function applyPluginPlan(actions: PluginAction[], ctx?: Ctx, deps?: Deps): Promise<number>;
```

```ts
export interface PluginAction {
  kind: "install" | "enable" | "disable" | "features" | "spec-differs" | "local-only";
  name: string;
  spec?: string;
  features?: string[];
}
```

- `readLocalPlugins` returns `undefined` (not an empty manifest) when no plugin root exists, so the caller can distinguish "no registry" from "registry with zero plugins".
- `refreshPluginManifest(dir, config, deps?)`: read local → `undefined`? return : compare against the existing file → write only on change.
- `pluginPlan(mirror, local)`: pure function; the diff surface the command prints and the apply loop execute. `install` → missing locally; `enable`/`disable` → mirrored `enabled` differs; `features` → mirrored `enabledFeatures` is a non-null array that differs (compared as sets); `spec-differs` and `local-only` are report-only.
- `applyPluginPlan` spawns through one internal `runOmp(args, deps?)` (`execFile("omp", args, { timeout: 120_000, windowsHide: true })`), overridable by `deps.omp` for tests. Errors are collected per action, reported with `notify` at `warning` level, and counted; the function returns the failure count.

## Wiring

| Site | Change |
| :--- | :--- |
| `src/sync.ts:prepareCommit` | `await refreshPluginManifest(dir, config, deps)` after `refreshMachineSidecar`; the function never throws (self-guarded, one `warnConfigIssue` per session) so a plugin problem cannot block a config commit |
| `src/sync.ts` (new orchestrator) | `showPluginPlan(ctx, deps?)` and `runPluginInstall(ctx, deps?)`: plan print + confirm-once + apply, wrapped by `withLock` from the command boundary like every other command |
| `src/index.ts` | `plugins` command branch with subcommand `install` (default = plan), plus usage string and `getArgumentCompletions` entries (`plugins`, `plugins install`) |
| `src/security.ts` | `"plugins.json"` in `DEFAULT_ALLOWED_PATHS`; no denylist change (`plugins.json` is not matched by any denial rule) |
| `src/config.ts` | `machineLocalPlugins?: string[]`, `pluginsDir?: string` on `OmpSyncConfig`; both normalized in `readConfig` (arrays sanitized, blank dropped; `pluginsDir` dropped if not a string) |
| `src/config.ts:Deps` | `omp?: (args: string[], cwd?: string) => Promise<{ stdout: string }>` test seam |

No `machineLocalMcpFields`-style sidecar is needed: machine-local data is excluded from the file instead of stripped out of it, which keeps `plugins.json` filter-free (boundary 1 of the cross-layer guide is untouched).

## Tradeoffs

| Decision | Alternative | Why |
| :--- | :--- | :--- |
| Mirror a declaration, not the live files | Sync `~/.omp/plugins/**` in place | Impossible: out-of-tree paths are unreachable by design (`extraPaths` rejects absolute paths; `GIT_CEILING_DIRECTORIES` blocks traversal), and `node_modules`/`bun.lock` must never sync |
| Read `package.json` + lock file directly | Call `omp plugin list --json` for the snapshot | The CLI output has no install spec (verified: name/version/path/manifest/enabledFeatures/enabled only), so a mirror built from it would silently change provenance. Apply still goes through the CLI |
| Explicit `plugins install` | Install automatically after `link`/`pull` | A remote-controlled install list is a code-execution channel; auto-applying turns the sync remote into a supply-chain vector |
| Exclude `settings` | Sync settings, or route them through the vault | Settings values are secrets by nature and the denylist cannot see JSON content. Vault routing is possible later (`SYNCABLE_SENSITIVE_FILES` is a sibling mechanism) but is out of scope |
| Report spec drift, never reinstall | Reinstall to force a match | Reinstalling clobbers a locally upgraded plugin; drift is visible in the plan output instead |

## Risks

- **Version drift:** a spec is not a lock. Documented; `#tag`/`@version` accepted verbatim for users who want pinning (PRD Q2).
- **XDG/profile ambiguity:** with a named profile on Linux/macOS, or with `XDG_DATA_HOME` set, the probe order above can resolve to the wrong root; the config override is the documented escape hatch. Determinism is provided by probing, not by deriving.
- **`enabledFeatures: null` vs `[]`:** host semantics differ (null = defaults, `[]` = none). The mirror preserves `null`, and the plan emits a `features` action only for non-null arrays, so a null mirror is never converted into "all features off".
- **`omp` not on PATH** (or an older omp without `plugin install`): the apply path fails per action with the CLI's own message; the snapshot path does not depend on the CLI at all.
- **Distribution:** `dist/` is committed in this repo, and every user-visible change needs a rebuilt `dist/` + version bump before publishing (spec `plugin/index.md` Quality Check). Per the user's global verification rule this change will be verified with `npm run typecheck` + `npm run build:test` + `node --test dist-test/test/*.test.js`; rebuilding `dist/` is a separate, explicitly approved release step.
