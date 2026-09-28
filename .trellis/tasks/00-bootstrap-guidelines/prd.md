# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `trellis init` on this project for the first time.
`.trellis/` now exists with empty spec scaffolding, and this bootstrap task
exists under `.trellis/tasks/`. When they want to work on it, they should start
this task from a session that provides Trellis session identity.

**Your job**: help them populate `.trellis/spec/` with the team's real
coding conventions. Every future AI session — this project's
`trellis-implement` and `trellis-check` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (CLAUDE.md, .cursorrules, etc.), and drive
the rest conversationally.

---

## Status (update the checkboxes as you complete each item)

- [x] Reshape the template spec layer to this repository (the generated `fullstack` guess was wrong)
- [x] Fill the product-code guidelines (`plugin/`)
- [x] Rewrite the shared thinking guides with real repository examples
- [x] Add code examples, file paths, and anti-patterns from `src/` and `test/`

Verified: no placeholder text, every relative link resolves, `index.md` files match the shipped file set.

---

## Reality Check (why the template layer was replaced)

`trellis init` guessed "fullstack": `.trellis/spec/backend/` (routes, ORM, migrations,
logging) and `.trellis/spec/frontend/` (components, hooks, state management) describe a
project this is not. `omp-settings-sync` is a **single-package TypeScript omp extension**
with no HTTP server, no database, no UI framework, and zero runtime dependencies. Those
two directories were deleted rather than filled with generic advice.

The real codebase: `src/` (9 modules, 2 569 lines) + `test/` (11 files, `node:test`).

---

## Spec files shipped


### `plugin/` — all product code

| File | What it documents |
|------|-------------------|
| `.trellis/spec/plugin/index.md` | Module table, Pre-Development Checklist, Quality Check, commands |
| `.trellis/spec/plugin/architecture.md` | Managed-directory layout, module map, dependency direction (incl. the `config`↔`security` cycle), synced data flow, where new code goes |
| `.trellis/spec/plugin/extension-api.md` | Host registration, command routing, flags, error boundary, `ctx.ui` contract, progress bar, lifecycle timing, extension test stub |
| `.trellis/spec/plugin/sync-engine.md` | Commit pipeline, orchestrator contracts, `runSync` sequence, git process-layer rules, lock semantics, error policy |
| `.trellis/spec/plugin/machine-local-sync.md` | The three filter drivers, generated `filter.mjs` protocol, sidecar symmetry, MCP field/server handling |
| `.trellis/spec/plugin/security-guards.md` | The four guard tiers, `isDenied` vs `HARD_DENY_PATTERNS`, allowlist/exclusions, multi-site change list |
| `.trellis/spec/plugin/credentials-vault.md` | `vault.enc` format + KDF params, passphrase cache, change detection, lifecycle, the missing version gate |
| `.trellis/spec/plugin/configuration.md` | `omp-sync.jsonc` keys and defaults, lenient parsing, warning routing, `dirOf`, remote address rules |
| `.trellis/spec/plugin/platform-compat.md` | Windows/macOS/Linux rules: separators, ceiling directory, CRLF, rename fallbacks, lock without a held fd |
| `.trellis/spec/plugin/testing.md` | `node:test` harness, fixtures, what to assert, how to add tests, known gaps |


### `guides/` — cross-cutting

| File | What it documents |
|------|-------------------|
| `.trellis/spec/guides/index.md` | Triggers for the two guides |
| `.trellis/spec/guides/code-reuse-thinking-guide.md` | The multi-site change map and the local reuse inventory |
| `.trellis/spec/guides/cross-layer-thinking-guide.md` | The five boundaries (filters, index, remote, machine state, shipped artifact, host) with per-boundary checklists |


### Root navigation

`.trellis/spec/index.md` — what the project is, the two spec layers, how to use them.

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching `.trellis/spec/` files —
usually much faster than documenting from scratch.

| File / Directory | Tool |
|------|------|
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / agent-compatible tools |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor (rules directory) |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roomodes` | Roo Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json` → `github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md` / `.aider.conf.yml` | aider |
| `CONTRIBUTING.md` | General project conventions |
| `.editorconfig` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: `trellis-implement` (writes
  code) and `trellis-check` (verifies quality).
- Each task has `implement.jsonl` / `check.jsonl` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's `prd.md`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: `.trellis/spec/`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

```bash
python ./.trellis/scripts/task.py finish
python ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
```

After archive, every new developer who joins this project will get a
`00-join-<slug>` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Trellis! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"
