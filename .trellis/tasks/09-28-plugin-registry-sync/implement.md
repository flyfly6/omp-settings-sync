# Implementation Plan: Plugin declaration mirror

Ordered checklist. Each step is independently reviewable; nothing here runs `npm run build` (the user's global verification rule), so `dist/` refresh is a separate release step listed at the end.

## Preconditions

- User approved `prd.md` + `design.md` (review gate), then `python ./.trellis/scripts/task.py start 09-28-plugin-registry-sync`.
- Sub-agent dispatch is disabled by the user's global rule: this task runs in **inline** mode (main agent implements and verifies). `implement.jsonl` / `check.jsonl` curation is skipped; if `task.py validate` refuses the empty seeded manifests, start with `--allow-empty-context`.
- Spec read before editing: `plugin/index.md` (checklist), `plugin/architecture.md`, `plugin/extension-api.md`, `plugin/security-guards.md`, `plugin/configuration.md`, `plugin/testing.md`, `guides/code-reuse-thinking-guide.md`.

## Steps

### 1. Allowlist the declaration file

- `src/security.ts`: add `"plugins.json"` to `DEFAULT_ALLOWED_PATHS` (after `omp-sync.json*`, before the directories). No `HARD_DENY_PATTERNS` or `isDenied` change — no rule matches `plugins.json`.
- Multi-site: `README.md` allowlist table; `test/security.test.ts` ignore-block assertion (`!plugins.json` present, and the managed block still contains every prior entry).
- Validate: `npm run typecheck`.

### 2. Config keys and the test seam

- `src/config.ts`: `OmpSyncConfig` += `machineLocalPlugins?: string[]`, `pluginsDir?: string`; normalize in `readConfig` (arrays sanitized like `machineLocalMcpServers`; `pluginsDir` kept only as a non-blank string, trimmed).
- `src/config.ts`: `Deps` += `omp?: (args: string[], cwd?: string) => Promise<{ stdout: string }>` — the injection point for every test that would otherwise spawn a real `omp`.
- Multi-site: `README.md` `omp-sync.jsonc` example block; `test/config.test.ts` case for both keys (valid + dropped values).
- Validate: `npm run typecheck`; `node --test dist-test/test/config.test.js` after step 6's compile.

### 3. `src/plugins.ts` — the module

- `PLUGIN_MANIFEST_FILE = "plugins.json"`, `PLUGIN_MANIFEST_VERSION = 1`.
- `isPortablePluginSpec(spec)`: reject empty/blank; `file:`/`link:`/`workspace:`/`portal:`; `.`/`..`; leading `/` or `\`; `~`; drive letters (`^[a-zA-Z]:[\\/]`); UNC (`\\`). Accept npm ranges, scoped names, `github:`/`gitlab:`/`bitbucket:`, `https://`, `name@marketplace`, `name@version`, `#tag`.
- `pluginsRoot(dir, config, probe = fs.existsSync)`: ordered probe from the design (`pluginsDir` → `$XDG_DATA_HOME/omp/plugins` when set → `dirname(agentDir)/plugins` when `basename === "agent"`), each candidate accepted only when `<candidate>/package.json` exists. `~` expansion reuses the same rule as `dirOf`.
- `readLocalPlugins(dir, config)`: read `package.json` (`dependencies`) + `omp-plugins.lock.json` (`plugins`); plain `JSON.parse` in `try/catch` (these are host-written files, not user-edited JSONC — no comment stripping); merge per design rules (portable spec ∧ not `machineLocalPlugins` ∧ dependency present); lock entry missing → `{ enabled: true, enabledFeatures: null }`; lock file unparsable → treat as "no registry" and return `undefined`; return `undefined` when no root.
- `readPluginManifest(dir)`: parse `plugins.json`; unknown `version` → warn once via `warnConfigIssue` and return `undefined`.
- `refreshPluginManifest(dir, config, deps?)`: `readLocalPlugins` → `undefined` → return; else serialize (sorted keys, 2-space, trailing newline) and write only when the bytes differ (atomic write via `atomicWriteFile` from `src/vault.ts` — the existing helper for files another process may read). Whole body wrapped so any failure is one `warnConfigIssue` and never throws into `prepareCommit`.
- `pluginPlan(mirror, local)`: `install` (in mirror, absent locally), `enable`/`disable` (mirror said `enabled` differs), `features` (mirror `enabledFeatures` is a non-null array and set-differs), `spec-differs` (both sides present, spec strings differ) and `local-only` (local, not in mirror) as report-only kinds.
- `applyPluginPlan(actions, ctx, deps?)`: execute only the four mutating kinds via `runOmp`; report-only kinds are printed, never executed; per-action `try/catch` → `notify(…, "warning")`, continue; returns the failure count.
- `runOmp(args, deps?)`: `deps.omp?.(args) ?? execFile("omp", args, { timeout: 120_000, windowsHide: true })`; no shell; returns trimmed stdout.
- Validate: `npm run typecheck`.

### 4. Wire the snapshot and the orchestrators

- `src/sync.ts:prepareCommit`: `await refreshPluginManifest(dir, config)` immediately after `refreshMachineSidecar(dir, config)` — the single refresh point for every commit path.
- `src/sync.ts`: `showPluginPlan(ctx, deps?)` (read mirror + local, print `no plugin registry on this machine` / `no plugins.json in this repository` / per-action lines / `no differences`) and `runPluginInstall(ctx, deps?)` (print plan → `ctx.ui.confirm?.(…)` when available → apply → summary with failure count). Both use `notify`; no `console.log`.
- Progress reporting: not required (short, non-long-running); do not reuse `STATUS_KEY`.
- Validate: `npm run typecheck`.

### 5. Command surface

- `src/index.ts`: `if (command === "plugins")` branch → subcommand `install` (also accept `apply`) → `runPluginInstall(ctx)`; default → `showPluginPlan(ctx)`; unknown subcommand → `throw new Error("Unknown plugins subcommand. Usage: /ompsync plugins [install]")`.
- Extend the top-level usage string (`…|status|sync|reset|push|pull|plugins|unlock|lock|vault`), the plain completion list, and the `vault `-style branch for `plugins `.
- Multi-site: `test/extension.test.ts` — completions assertion for `plugins` and `plugins install`; `README.md` command table.
- Validate: `npm run typecheck`.

### 6. Tests — `test/plugins.test.ts` (+ two existing files)

Cases (fixtures reuse `createMachineFixture`/`createBareRemote` from `test/helpers.ts`; the plugin root is a sibling `<root>/plugins` with hand-written `package.json` + `omp-plugins.lock.json`, so the `dirname(agentDir)` probe resolves naturally):

1. `isPortablePluginSpec` accept/reject table (rejects local paths, accepts the four portable shapes).
2. `readLocalPlugins`: merges deps + lock; lock-only entry skipped; `machineLocalPlugins` excluded; missing lock entry → `{enabled: true, enabledFeatures: null}`; no root → `undefined`; unparsable lock → `undefined`.
3. `refreshPluginManifest`: no root → no file created, no throw; identical state → file bytes unchanged; key order sorted; existing `plugins.json` survives a vanished root.
4. `pluginPlan`: each kind, plus `enabledFeatures: null` producing no `features` action.
5. `applyPluginPlan` with `deps.omp` recording argv: only deviations produce commands; the four command forms are exactly `install <spec>`, `enable <name>`, `disable <name>`, `features <name> --set a,b`; one failing action does not stop the rest and is counted.
6. `test/security.test.ts`: `plugins.json` present in the managed `.gitignore` block and allowed by `isDenied` (guards the C5 constraint).
7. `test/extension.test.ts`: registration + completions as above.

- Validate: `npm run build:test && node --test --test-concurrency=4 dist-test/test/*.test.js`.

### 7. Documentation and spec

- `README.md`: allowlist table row for `plugins.json`; command table rows for `/ompsync plugins` and `/ompsync plugins install`; `omp-sync.jsonc` block += `machineLocalPlugins`, `pluginsDir`; a short "Plugin declarations across machines" section stating the never-automatic rule and the settings exclusion.
- `.trellis/spec/plugin/architecture.md`: module table += `src/plugins.ts`; artifact table += `plugins.json` (committed, no filter).
- `.trellis/spec/plugin/extension-api.md`: command routing (`plugins` + subcommand structure, usage string, completions).
- `.trellis/spec/plugin/security-guards.md`: allowlist list + the `plugins.json` rationale (name is denylist-clean; content is checked by construction, not by pattern).
- `.trellis/spec/plugin/configuration.md`: config key table += the two keys; note the discovery order and the `pluginsDir` escape hatch.
- `.trellis/spec/plugin/machine-local-sync.md`: one line — `plugins.json` carries no filter driver because machine-local entries are omitted rather than stripped.
- `.trellis/spec/guides/cross-layer-thinking-guide.md`: only if a boundary genuinely gained a case (expected: none — no filter, no new sidecar, no new remote flow). Do not pad it.

### 8. Verification (no build, no dev server)

| Check | Command |
| :--- | :--- |
| Types | `npm run typecheck` |
| Suite | `npm run build:test` then `node --test --test-concurrency=4 dist-test/test/*.test.js` |
| Real-machine snapshot (read-only) | throwaway script compiled by `build:test` calling `refreshPluginManifest` against the real agent dir with `dirOf()`; assert `plugins.json` lists exactly the two installed plugins with specs `^4.10.0` and `github:flyfly6/omp-settings-sync`, `enabled: true`, `enabledFeatures: null`, and no absolute path or `settings` key. Delete the script after the run |
| Apply path | exercised through the recorded-argv fake; the real CLI form was verified once by hand (`omp plugin install github:flyfly6/omp-settings-sync --dry-run` → `[dry-run] Would install github:flyfly6/omp-settings-sync`). A live apply against the real plugin root is deliberately not run as a smoke test — it mutates the user's plugin installation |
| Formatting/lint | no Prettier or ESLint configuration exists in this repository (devDependencies: `typescript`, `@types/node`, the omp SDK), so there is nothing to run; match the surrounding 2-space style |

Manual end-to-end (user, optional): reload the plugin in omp, run `/ompsync plugins`, then `/ompsync plugins install` on a second machine after `/ompsync link`.

### 9. Release step (separate approval)

- `dist/` is committed shipped output: before publishing, run `npm run build`, bump `package.json` version, and commit `dist/`. This step is **not** part of verification and requires explicit user approval, per the global no-build rule.

## Review gates

- **G1** after step 3: module compiles, unit tests for the pure functions pass, no spawn site outside `runOmp`.
- **G2** after step 6: full suite green (`typecheck` + `node --test`), and `grep -rn "plugin install" src/` shows exactly one call site.
- **G3** before commit: README + all five spec pages updated; `git status` clean of throwaway scripts; commit only after explicit user approval (global rule), then `task.py archive` with the task directory included in the commit.

## Rollback points

- Steps are ordered so that reverting the allowlist entry (step 1) plus deleting `plugins.json` fully disables the feature: nothing else reads the file, and no state outside the agent directory exists to clean up.
- A partially applied `plugins install` is not rolled back automatically; the summary reports what failed and the user re-runs (or unhooks a plugin with `omp plugin uninstall`). Fabricating a rollback would mean uninstalling plugins a user may have installed independently.
