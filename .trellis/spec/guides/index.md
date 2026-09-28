# Thinking Guides

> Two checks that catch most incomplete changes in this repository.

---

## Why These Two

This codebase's failure modes are narrow and predictable:

1. **The same policy exists in several representations** (code predicate, gitignore pattern, documentation, test list). Editing one leaves the others stale — most often producing "sync silently does nothing" or "the guard let something through".
2. **Data crosses five boundaries** (worktree ↔ index ↔ local repo ↔ remote, plus the machine-state sidecar directory and the compiled `dist/`). A change that works on one side of a boundary can silently lose data on the other.

---

## Guide Index

| Guide | Use when |
| :--- | :--- |
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Adding an allowlisted path, a denied pattern, a machine-local key, a sensitive file, a command, or a config key — the multi-site change map lives here |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Anything that changes data on its way through git filters, the index, the remote, or `.git-sync/`; or that changes what ships in `dist/` |

---

## Triggers

Read the reuse guide when:

- [ ] You are about to add a constant, list, or default that "feels like it exists already".
- [ ] You are changing any entry in `DEFAULT_ALLOWED_PATHS`, `HARD_DENY_PATTERNS`, `isDenied`, `DEFAULT_MACHINE_LOCAL_*`, `SYNCABLE_SENSITIVE_FILES`, or the command usage string.
- [ ] You are writing a new helper near `src/git.ts`, `src/lock.ts`, or `src/vault.ts`.

Read the cross-layer guide when:

- [ ] A change touches what gets committed, or what is restored on checkout.
- [ ] You are editing `src/filter.ts` (clean and smudge must stay symmetric).
- [ ] You are touching `src/index.ts` lifecycle hooks or anything that ships as `dist/`.
- [ ] The change affects what a user sees after a pull (config or `mcp.json` only apply after `/reload`).

---

## Rule of Thumb

If a change is visible to users, ask in order: **which list decides it → which module consumes it → which sidecar or filter carries it → which doc/test pins it.** Missing any of the four is the usual bug.
