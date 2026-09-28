# PRD: Sync installed plugin declarations across machines

## Problem

`omp` plugins are installed into `<configRoot>/plugins` (`~/.omp/plugins`, or `$XDG_DATA_HOME/omp/plugins`), which is a sibling of the managed agent directory that this extension syncs. Every guard in this plugin is built on the invariant "the agent directory *is* the repository" (`src/config.ts:dirOf`, `src/git.ts:gitEnv` → `GIT_CEILING_DIRECTORIES`), and the synced set only accepts relative paths inside that directory (`isValidExtraPath`). There is therefore no configuration that can sync plugin state today, and provisioning a second machine means re-running `omp plugin install …` by hand.

Confirmed on the author's machine: `~/.omp/plugins` holds `package.json` (`github:flyfly6/omp-settings-sync`, `@dietrichgebert/ponytail: ^4.10.0`), `omp-plugins.lock.json` (resolved version, `enabled`, `enabledFeatures`, `settings`), `bun.lock` (66 KB, private mirror tarball URLs + sha512) and `node_modules/`.

## Goal

Declare the plugins installed on this machine inside the synced agent directory, and let another machine replay that declaration on demand — without moving secrets, machine paths, or package-manager lock data.

## Requirements

**R1 — Declaration file.** A new committed file in the managed agent directory (`plugins.json`) records, for every plugin installed from a portable source: the install spec exactly as recorded in the plugin root's `package.json` dependencies, plus `enabled` and `enabledFeatures`. Keys are emitted in stable (sorted) order so an unchanged machine produces no diff.

**R2 — Refresh point.** The declaration is refreshed by the same call that prepares every commit (`prepareCommit`), so `/ompsync sync|push|pull`, the startup sync, the 1-minute tick, and the shutdown sync all refresh it through one code path.

**R3 — Absent registry is not an error.** A machine with no plugin root (or no lock file) must not fail, must not warn more than once per session, and must not delete an existing `plugins.json` — a read-only mirror machine keeps the pulled declaration.

**R4 — Nothing outside the agent directory is written.** The snapshot is read-only with respect to the plugin root; apply actions are delegated to the `omp` CLI, which owns `package.json`/`bun.lock`/`node_modules` consistency and its own rollback.

**R5 — Inspect command.** `/ompsync plugins` prints, without modifying anything: plugins declared but missing locally, plugins present only locally, `enabled`/`enabledFeatures` differences, and install-spec differences.

**R6 — Apply command.** `/ompsync plugins install` prints the plan first, then executes it: `omp plugin install <spec>` for declared-but-missing plugins, and `omp plugin enable|disable <name>` / `omp plugin features <name> --set …` for state deviations. It refuses nothing silently: each failed action is reported individually, the run continues with the remaining actions, and the final line names the number of failures.

**R7 — Never automatic.** No lifecycle hook, background tick, pull, or rebase ever installs or enables a plugin. Installing is user-invoked only. The explicit invocation is the consent; when `ctx.ui.confirm` exists the plan is confirmed once, and when it does not exist the command still completes (existing non-interactive convention).

**R8 — Local-only entries stay local.** Plugins whose spec is a local path or a `file:`/`link:`/`workspace:` reference, and plugin entries listed in the new `machineLocalPlugins` config key, are excluded from the declaration. Installed-plugin settings values are never written to any committed file.

**R9 — Documentation.** `README.md` gains the declaration in the allowlist table, the two commands in the command table, and the new `omp-sync.jsonc` keys. Spec pages that describe the sync set, the command surface, the module map, and the config keys are updated in the same change.

## Constraints

- **C1** No new runtime dependency; only `node:` builtins and existing `src/` modules (the package ships with `dependencies: {}`).
- **C2** The extension is a guest of the plugin root: it reads `package.json` + `omp-plugins.lock.json` and shells out to `omp`. It never hand-edits those files.
- **C3** Subprocess discipline follows `src/git.ts`: fixed argv, no shell, timeout, `windowsHide`.
- **C4** Windows, macOS, and Linux all behave identically; paths are compared with `/` normalization, and no absolute machine path may enter `src/` or `test/` fixtures.
- **C5** `plugins.json` must be denied nothing: its name must pass `isDenied` (no `token`/`secret`/`credential`/`key`/`.local.` substring) and it must not be routed through a git filter driver.
- **C6** The declaration is a portable *spec* list, not a lock file: it does not pin resolved versions or registry URLs.

## Acceptance Criteria

1. Install a plugin on machine A, run `/ompsync sync`; `plugins.json` appears in the repository containing that plugin's `spec`/`enabled`/`enabledFeatures`, and contains no absolute path, no `settings` value, no tarball URL, and no sha512.
2. On machine B (fresh agent dir, same remote, `/ompsync link`), `/ompsync plugins` lists the plugin as missing without touching anything; `/ompsync plugins install` installs it, and a second `/ompsync plugins` reports no differences.
3. On a machine whose plugin root does not exist, the sync pipeline writes no `plugins.json`, emits no error, and an existing pulled `plugins.json` is left byte-identical.
4. A plugin with a local-path spec never appears in `plugins.json`; a plugin listed in `machineLocalPlugins` never appears in `plugins.json`.
5. `grep -rn "plugin install" src/` shows exactly one call site (the apply path); no lifecycle hook, tick, or pull path references it.
6. Set `enabled: false` for a plugin on machine A, sync, then apply on machine B → the plugin is disabled there; the mirror file is identical on both machines afterwards.
7. `npm run typecheck` and the `node:test` suite pass; the new tests fail if the snapshot stops sorting keys, starts recording path-like specs, or if the apply path replays a non-deviation.

## Non-Goals

- Syncing plugin `settings` values (scope decision: they can hold third-party API keys and `isDenied` only inspects file names, not JSON content).
- Syncing `node_modules/`, `bun.lock`, `installed_plugins.json`, or marketplace registry state.
- Project-scope plugin installs (`<projectAnchor>/.omp/plugins`).
- Auto-uninstalling or auto-downgrading a plugin to match the declaration.
- Syncing the legacy in-agent `<agentDir>/plugins` installer directory (already allowlisted as a directory; unrelated to this file).

## Open Questions

- **Q1** Reinstalling when only the spec differs (for example `github:user/repo` → `name@marketplace`) is reported but not applied, because reinstalling can clobber a locally upgraded plugin. Confirm this is the desired default.
- **Q2** Declarations are replayed by spec, so a floating range (`^4.10.0`) installs the newest matching version on the target machine rather than the version on the source machine. Accepted for portability; a `#tag`/`@version` in the spec is preserved verbatim when the user writes it that way.
