import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRepoReference, remoteFromArg } from "../src/remote.js";
import { git, hasAnyChanges, hasDotGit, hasLocalChanges, isSyncableRepo } from "../src/git.js";

test("parseRepoReference parses various GitHub repository URL and name shapes", () => {
  assert.deepEqual(parseRepoReference("org/repo"), { owner: "org", name: "repo" });
  assert.deepEqual(parseRepoReference("git@github.com:org/repo.git"), { owner: "org", name: "repo" });
  assert.deepEqual(parseRepoReference("https://github.com/org/repo"), { owner: "org", name: "repo" });
  assert.equal(parseRepoReference("my-config"), undefined);
});

test("remoteFromArg requires an explicit repository address", () => {
  assert.equal(remoteFromArg(""), undefined);
  assert.equal(remoteFromArg("my-config"), undefined);
  assert.equal(remoteFromArg("org/repo"), "https://github.com/org/repo.git");
  assert.equal(remoteFromArg("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
  assert.equal(remoteFromArg("https://gitlab.com/org/repo.git"), "https://gitlab.com/org/repo.git");
  assert.equal(remoteFromArg("/srv/git/config.git"), "/srv/git/config.git");
});

test("git operations execute in isolated ceiling directory and detect changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-test-"));
  assert.equal(await hasDotGit(root), false);
  await git(["init", "-b", "main"], root);
  assert.equal(await hasDotGit(root), true);
  assert.equal(await isSyncableRepo(root), false);

  // No changes yet
  assert.equal(await hasLocalChanges(root), false);

  // Add a change
  await fs.writeFile(path.join(root, "test.txt"), "hello");
  assert.equal(await hasLocalChanges(root), true);
  assert.equal(await hasAnyChanges(root), true);

  // Simulate stale index.lock
  const lockFile = path.join(root, ".git", "index.lock");
  await fs.writeFile(lockFile, "dummy-lock");
  // Set mtime to past
  const past = new Date(Date.now() - 30_000);
  await fs.utimes(lockFile, past, past);

  // git command automatically removes stale index.lock and succeeds
  await git(["add", "-A"], root);
  assert.equal(await hasDotGit(root), true);
});

