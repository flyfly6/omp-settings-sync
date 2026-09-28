# Machine-Local Sync (Filters, Sidecars, MCP)

> How an allowlisted file gets committed with some keys removed and the rest restored locally.

---

## The Three Drivers

`.gitattributes` (managed by `src/filter.ts:ensureAttributes`) routes four allowlisted files through drivers, each backed by the same generated script:

| File | Attribute | Format argument |
| :--- | :--- | :--- |
| `config.yml`, `config.yaml` | `filter=omp-config-sync-yaml` | `yaml` |
| `settings.json` | `filter=omp-config-sync-json` | `json` |
| `mcp.json` | `filter=omp-config-sync-mcp` | `mcp` |

`ensureAttributes` is idempotent and migration-aware: it preserves unrelated attribute lines, drops any `filter=` rule on a file this plugin owns (older releases routed `mcp.json` through the JSON driver, which leaked launcher commands into commits), appends missing rules, and then re-normalizes only the tracked files (`git ls-files -- <files>` → a single `git add --renormalize`).

Git filter config is written by `ensureFilter` under `filter.omp-config-sync-<driver>.{clean,smudge,required}`. Values are shell-quoted absolutes with forward slashes:

```
"<process.execPath>" "<dir>/.git-sync/filter.mjs" clean yaml
```

`required = false` everywhere: a missing Node binary must degrade to "file passes through", never block a checkout. `readFilterConfig` reads all nine keys in one `git config --get-regexp` spawn — do not add per-key `git config` calls.

## The Generated Filter Script

`generateFilterScript(jsonKeys, yamlKeys, mcpFieldKeys, mcpServerNames)` emits `.git-sync/filter.mjs`; the file is rewritten only when its text differs. Because git runs it on every `add` and every `checkout`:

- It must run on **bare Node ≥ 22 with no dependencies** (currently only `node:fs`). It cannot import from `src/` — it lives in the user's agent directory with no `node_modules` and no TypeScript build step.
- It is a template literal inside `src/filter.ts`; keep it plain JavaScript, and keep every helper it uses defined inside the generated text.
- Protocol: `node filter.mjs <clean|smudge> <yaml|json|mcp>`, content on stdin, result on stdout. Any exception → write the **raw input unchanged** (the outer `try/catch`), so a malformed file can never be corrupted by a filter.
- Line endings are preserved: the script detects `\r\n` and joins with it.
- The key lists are injected as `JSON.stringify(...)` of the values resolved from config, so a new machine-local key needs **no** change to the generator — see "Adding A Machine-Local Key" below.

Clean vs smudge semantics per format:

| Format | clean (worktree → index) | smudge (index → worktree) |
| :--- | :--- | :--- |
| `json` | drop the configured top-level keys, re-stringify with 2-space indent | shallow-merge `settings.machine.json` over the committed object |
| `yaml` | drop top-level `key:` lines plus their indented continuation lines | append `config.machine.yml` verbatim |
| `mcp` | delete `machineLocalMcpServers` entries entirely and the configured fields from every remaining server, re-stringify | merge `.git-sync/mcp.machine.json` patches over the committed `mcpServers`, creating entries that exist only locally |

The invariants to preserve when editing either side:

- **Symmetry.** Whatever `clean` removes, `smudge` must restore from the matching sidecar. The sidecar is the only carrier of that data; a key removed by `clean` but not captured by `refreshMachineSidecar` is destroyed on the next checkout.
- **Order.** `refreshMachineSidecar` runs inside `prepareCommit`, i.e. before any checkout/rebase. Calling it after a checkout reads the machine-neutral copy and loses the local half.
- **Block-level YAML matching only.** Keys are matched as top-level `key:` prefixes at column 0 (`indent === 0`), with indented lines captured while the block continues. Dotted keys such as `dev.autoqaPush.token` are matched literally at column 0 — this is why the plugin needs no YAML parser. Do not add nested-key traversal.

## Sidecars

All three live in `.git-sync/` (denied by the hard denylist, never committed) and are refreshed by `refreshMachineSidecar(dir, config)`:

| File | Content | Written when |
| :--- | :--- | :--- |
| `settings.machine.json` | `{ [key]: settings.json[key] }` for keys from `machineLocalSettings` (default `DEFAULT_MACHINE_LOCAL_JSON`) | `settings.json` exists and has those keys |
| `config.machine.yml` | extracted top-level YAML block(s) for `machineLocalYamlKeys` (default `DEFAULT_MACHINE_LOCAL_YAML`) | at least one key was found |
| `mcp.machine.json` | `{ mcpServers: { <name>: <patch> } }` where `<patch>` is the configured fields found in the local entry, or the **whole** entry for names in `machineLocalMcpServers` | `mcp.json` parses and has `mcpServers` |

## MCP Servers

- `mcpFields(config)` defaults to `["command", "args", "env"]`; `machineLocalMcpFields: []` syncs launchers verbatim (same-platform fleets) and disables both stub reporting (`mcpServersMissingLocalValues` early-returns) and sidecar patches.
- A server created on another machine arrives as a stub (`{"type": "stdio"}`); `runSync` reports it after a pull via `mcpServersMissingLocalValues`, which excludes locally-owned servers and everything named in the top-level `disabledServers` array. Servers existing on one platform only belong in `machineLocalMcpServers`.
- `mcpServersMissingLocalValues` is read-only: it inspects the current `mcp.json` and returns names lacking both `command` and `url`.

## Adding A Machine-Local Key

Update, together:

1. `src/config.ts` — the `OmpSyncConfig` field and/or the relevant `DEFAULT_MACHINE_LOCAL_*` array.
2. `src/filter.ts` — only if the key needs a new *shape* (a new format or block rule); plain top-level keys in an existing format need nothing.
3. Tests: `test/filter.test.ts` for the driver/sidecar behaviour, `test/mcp-sync.test.ts` for MCP fields/servers.
4. `README.md` — the `omp-sync.jsonc` example and the MCP/machine-local sections.

The filter script, `refreshMachineSidecar`, and the `.gitattributes` rules all derive from those constants; a value that only exists in one of them is the classic half-finished change in this area.
