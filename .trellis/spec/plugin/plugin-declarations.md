# Plugin Declarations (`src/plugins.ts`)

> The one synced artifact whose source lives outside the managed directory, and the one path that runs `omp`.

---

## Why This Module Exists

`omp` installs plugins into `<config root>/plugins` (`~/.omp/plugins`, or `$XDG_DATA_HOME/omp/plugins` under XDG), a **sibling** of the managed agent directory. Nothing in this plugin can reach it through the sync set: `isValidExtraPath` rejects absolute paths and `..`, and `gitEnv()` pins `GIT_CEILING_DIRECTORIES`. So the machine→repo direction is a *mirror* written inside the agent dir, and the repo→machine direction is a *replay* through the `omp` CLI.

```
<config root>/plugins/{package.json,omp-plugins.lock.json}   (read-only for us)
        │
        ▼  refreshPluginManifest()   (from prepareCommit)
   <agent dir>/plugins.json  ──git──▶  remote
        │
        ▼  /ompsync plugins install → applyPluginPlan()
   omp plugin install|enable|disable|features
```

## Contract

`PLUGIN_MANIFEST_FILE = "plugins.json"`, `PLUGIN_MANIFEST_VERSION = 1`:

```json
{ "version": 1, "plugins": { "<package name>": { "spec": "^4.10.0", "enabled": true, "enabledFeatures": null } } }
```

- Keys are emitted sorted; `enabledFeatures` is sorted and de-duplicated on read; the file is written only when its bytes change (an unchanged machine must never dirty the worktree).
- An unknown `version` is ignored with a warning (`warnConfigIssue`) rather than guessed at.
- A mirrored plugin must satisfy all of: present in the plugin root's `package.json` `dependencies`; portable spec (`isPortablePluginSpec`); not in `machineLocalPlugins`. A dependency with no lock entry is declared as `{ enabled: true, enabledFeatures: null }` — the host's fresh-install state.
- Lock-only entries (symlinked or marketplace packages with no dependency) are skipped: their source is not reproducible elsewhere.
- `settings` is never read. Values there can be third-party API keys, and `isDenied` matches path names only, so nothing at the JSON-content level would stop a secret from being committed.

## Plugin Root Discovery

Ordered probes, first existing `<candidate>/package.json` wins (`pluginsRoot`):

1. `pluginsDir` from `omp-sync.jsonc` (absolute or `~`-prefixed via `expandUserPath`).
2. `$XDG_DATA_HOME/omp/plugins` when that variable is set.
3. `path.dirname(agentDir)/plugins` when the agent dir is named `agent`.

Rationale: the host resolves the root through its own XDG- and profile-aware `getPluginsDir()`, while `PI_CODING_AGENT_DIR` can point the agent dir anywhere, so `dirname(agentDir)/plugins` alone is wrong in supported setups. Probing plus the config override is deliberate: deriving the path would be silently wrong, and a hard error would break machines that have no plugins at all.

Nothing found → `refreshPluginManifest` returns without writing, and an existing `plugins.json` is left untouched. A machine that only pulls keeps the declaration it received.

## Snapshot Invariants

- Called from `prepareCommit` (the single refresh point for every commit path) and wrapped in its own `try/catch`: a plugin problem must never block a config commit.
- `readLocalPlugins` returns `undefined` for "no registry" and `{ plugins: {} }` for "registry with nothing declared" — the two must stay distinguishable.
- Writes go through `atomicWriteFile` (`src/vault.ts`) — the same helper used for state another process may read.
- Never write anything into the plugin root. `bun.lock`, `node_modules/`, `installed_plugins.json`, and `settings` are out of scope by design.

## Apply Path

`pluginPlan(declared, local)` is pure and returns `install`, `enable`, `disable`, `features` (actionable) plus `spec-differs`, `local-only` (report-only). `pluginCommand(action)` returns the argv for `omp`, or `undefined` for report-only kinds — it is the single representation of "what can be executed", used both for filtering and for the plan text. `applyPluginPlan` runs the actionable subset through `runOmp`, collects per-action failures, and continues; it never throws.

Rules that must not be relaxed:

- **Never automatic.** No lifecycle hook, background tick, pull, or rebase installs a plugin. A remote-controlled install list is a code-execution channel.
- `spec-differs` is reported, never applied: reinstalling would clobber a locally upgraded plugin.
- A declared `enabledFeatures: null` means "defaults" and produces no `features` action. An explicit empty list is mirrored but not replayed — the CLI cannot set an empty feature set.
- `deps.omp` is the test seam; nothing else in the module spawns a process, so the snapshot path works without the CLI installed.

## Changing This Area

1. New mirrored field → `PluginDeclaration` + `readLocalPlugins` + `serializePluginManifest` + `pluginPlan`/`pluginCommand` if it is actionable + `test/plugins.test.ts`.
2. A new action kind → `PluginActionKind`, `pluginCommand`, `describePluginAction`, and the `applyPluginPlan` test that asserts exact argv.
3. Format change → bump `PLUGIN_MANIFEST_VERSION` and keep the reader's unknown-version warning.
4. Allowlist/denylist interplay → `security-guards.md` (the name must stay denylist-clean).
