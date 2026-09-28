# Extension API Boundary

> Everything that touches the host: registration, command routing, lifecycle hooks, UI, and error handling.

---

## Registration

`src/index.ts` is the whole boundary. It exports one default factory:

```ts
export default function gitSyncExtension(pi: ExtensionAPI) {
  pi.setLabel("OMP Config Git Sync");
  …
  pi.registerCommand("ompsync", commandDef);
  pi.registerCommand("gitsync", commandDef);
  pi.on("session_start", …);
  pi.on("session_shutdown", …);
}
```

- The host types (`ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`) are imported with `import type` only. Nothing from `@oh-my-pi/pi-coding-agent` exists at runtime, which is why the package declares no `dependencies`.
- Two names share one `commandDef` object — never register divergent behaviour per alias.
- `package.json` maps both `omp.extensions` and `pi.extensions` to `./dist/index.js`.

## Command Routing

- `args.trim().split(/\s+/)` → first token is the command, rest re-joined as the raw argument string. Empty input defaults to `status`.
- Dispatch is a flat `if` chain inside `withLock(ctx, …)`, so **every** command is serialized against background sync and other sessions.
- Flags are parsed from the raw argument with a word-boundary regex and then stripped before the argument is interpreted:

```ts
const isForce = /\b(--force|--fresh|-f)\b/i.test(arg);
const cleanArg = arg.replace(/\b(--force|--fresh|-f)\b/gi, "").trim();
```

  Follow this two-step pattern (`test` for the flag, `replace` to remove it). Never split arguments positionally — a remote URL may legitimately contain dashes.
- `vault` is the only command with subcommands (`enable|disable|unlock|lock|status`); its default is `status`.
- Unknown command/subcommand → `throw new Error("… Usage: /ompsync [...]")`. The usage string is the contract shown to users, so extend it when adding a command.
- `getArgumentCompletions(prefix)` returns `{ value, label }[]` or `null`; `vault …` completions are a separate branch. New commands must be added to the plain list.

## Error Handling

One try/catch wraps the handler:

```ts
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`omp-sync: ${msg}`, "error");
}
```

- Orchestrators in `src/sync.ts` `throw` when the user must act (`no git repo … Run /ompsync init <url>`), and return quietly when the situation is benign-but-not-syncable. The handler never rethrows into the host.
- Messages are written for the user, include the command to run next, and are prefixed `omp-sync:`.
- Best-effort operations (fetch retry, `git rebase --abort`, stale lock cleanup) swallow errors deliberately in `src/git.ts`; do not "fix" them into throws without checking the caller's contract.

## UI Access

`src/config.ts` declares the local `UIContext` interface (`hasUI`, `ui.setStatus`, `ui.setWorkingMessage?`, `ui.notify`, `ui.input?`, `ui.confirm?`, `ui.select?`). It is structural, not imported from the SDK, so `src/` stays testable and the optional methods force degradation paths.

- Always guard: `if (ctx?.hasUI && ctx.ui) { … }`, and guard optional methods with `typeof ctx.ui.input === "function"`.
- Interactive prompts (`input`, `confirm`, `select`) are **always optional** — the non-interactive path must still complete (see `runInit`/`runLink`: vault setup is simply skipped, and `runLink` reports `credentials vault is locked. Run '/ompsync unlock' later.`).
- `notify(ctx, text, level, deps?)` in `src/sync.ts` is the single notification helper: `deps.notify` (tests) → `ctx.ui.notify` → (in `src/config.ts` only) `process.stderr`. Never call `console.log` from `src/`.

## Progress Reporting

- `STATUS_KEY = "omp-git-sync"` is the one status slot; `renderProgressBar(percentage, stage)` renders `🔄 Sync [█████░░░░░] 50% Fetching...` and `updateSyncProgress` writes it to `ui.setStatus` + `ui.setWorkingMessage`.
- Long flows (`runSync`, `runReset`) bracket their work with 10/30/50/70/90/100 milestones and clear the status in a `finally` block. Any new long-running command must do the same, or the status line is left dangling.
- `test/progress.test.ts` asserts the exact bar/percentage format — changing the string means changing that test deliberately.

## Lifecycle Hooks

`session_start`:

1. Skip when `isSubagentChild()` or the directory is not a syncable repo.
2. Run one immediate sync inside `withLock`, recording `lastAutoSyncAt`.
3. Schedule the background tick via `ctx.setInterval(fn, 60_000)` — with a `setInterval` + `timer.unref?.()` fallback when the host context lacks `setInterval`. The tick calls `checkAndBackgroundSync`, which does its own "anything changed?" gating.

`session_shutdown`:

- Returns early for `reason === "reload"` and for subagent children.
- Runs the exit sync **detached** (`void (async () => { … })()`) and swallows errors. Comment in the source explains why: omp allows ~2 s for shutdown handlers while commit+push takes seconds; the pending git child keeps the process alive, and anything unpushed is retried by the next start or tick. Do not convert this to `await`.

## Testing The Boundary

`test/extension.test.ts` drives the factory with a hand-rolled `pi` stub (`registerCommand`/`on` capture) and asserts both command names plus both listeners register. Extend that stub rather than mocking the SDK; the point is the registration contract, not host behaviour.

New host-facing behaviour should keep all SDK contact inside `src/index.ts`, so everything to the right of it stays callable with `(deps, ctx)` arguments from tests.
