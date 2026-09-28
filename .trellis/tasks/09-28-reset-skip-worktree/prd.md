# Clear legacy skip-worktree bits before reset

## Goal

`/ompsync reset` must work on a machine that still carries a `git update-index --skip-worktree` freeze
from the 0.1.x `mcp.json` recipe.

## Requirements

- `runReset` clears every skip-worktree bit in the agent repo before `reset --hard origin/<branch>`.
- Clearing is idempotent, silent, and never throws (a repo without bits must not change behaviour).
- No behavioural change for `link`, `sync`, `push`, `pull`: only the discarding path (`/ompsync reset`,
  `--discard-local`, `config.preferRemote`) discharges the freeze.

## Acceptance Criteria

- [x] A repo whose frozen file drifted from the index resets cleanly instead of failing with
      `error: Entry '<path>' not uptodate. Cannot merge.`
- [x] `clearSkipWorktree` returns the cleared paths, reports `[]` on a clean repo.
- [x] `npm run check` (typecheck + 54 tests) passes.

## Notes

- Reproduced from a real failure: `reset --hard origin/main` aborted on a stranded `mcp.json` freeze
  (pre-0.2 machines froze the file with skip-worktree because launcher `command`/`args` are machine-local).
- The regression test in `test/end-to-end.test.ts` is red without the fix and green with it.
- `link`/`sync` were probed with the same class of frozen repo: they already survive it (the link path
  backs the drifted file aside; the sync path reports divergence to the user), so no extra call sites.
