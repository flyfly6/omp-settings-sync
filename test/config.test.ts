import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dirOf, readConfig, stripJsonComments } from "../src/config.js";

test("dirOf resolves ~/.omp/agent by default, respects OMP_PROFILE and PI_CODING_AGENT_DIR", () => {
  const originalProfile = process.env.OMP_PROFILE;
  const originalPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.OMP_PROFILE;
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(dirOf(), path.join(os.homedir(), ".omp", "agent"));

    process.env.OMP_PROFILE = "work";
    assert.equal(dirOf(), path.join(os.homedir(), ".omp", "profiles", "work", "agent"));

    process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
    assert.equal(dirOf(), path.join(os.homedir(), "custom-agent"));

    assert.equal(dirOf({ dir: "/explicit/dir" }), path.resolve("/explicit/dir"));
  } finally {
    if (originalProfile) process.env.OMP_PROFILE = originalProfile; else delete process.env.OMP_PROFILE;
    if (originalPiDir) process.env.PI_CODING_AGENT_DIR = originalPiDir; else delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("readConfig parses JSONC with comments and validates safe extraPaths and machineLocalSettings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-test-"));
  const configContent = `{\n  // Auto sync interval in minutes\n  "autoSyncIntervalMinutes": 10,\n  "includeHostname": false,\n  "extraPaths": ["safe-dir", "custom/path", "../unsafe", "auth-token"],\n  "machineLocalSettings": ["setupVersion", "dev.autoqaConsent", ""]\n}`;
  await fs.writeFile(path.join(tempDir, "omp-sync.jsonc"), configContent);

  const config = await readConfig({ dir: tempDir });
  assert.equal(config.autoSyncIntervalMinutes, 10);
  assert.equal(config.includeHostname, false);
  assert.deepEqual(config.extraPaths, ["safe-dir", "custom/path"]);
  assert.deepEqual(config.machineLocalSettings, ["setupVersion", "dev.autoqaConsent"]);
});

test("readConfig tolerates trailing commas and reports config files it cannot parse", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-lenient-"));
  const warnings: string[] = [];
  const notify = (message: string, level: string) => warnings.push(`${level}: ${message}`);

  await fs.writeFile(
    path.join(tempDir, "omp-sync.jsonc"),
    `{\n  "autoSyncIntervalMinutes": 5,\n  "extraPaths": ["models.yml"],\n}\n`
  );
  const lenient = await readConfig({ dir: tempDir, notify });
  assert.equal(lenient.autoSyncIntervalMinutes, 5);
  assert.deepEqual(lenient.extraPaths, ["models.yml"]);
  assert.equal(warnings.length, 1, "a trailing comma must be reported, not silently ignored");

  await fs.writeFile(
    path.join(tempDir, "omp-sync.jsonc"),
    `{\n  "extraPaths": ["a{b,c"],\n  "machineLocalSettings": ["x,}", "setupVersion"]\n}\n`
  );
  const tricky = await readConfig({ dir: tempDir, notify });
  assert.deepEqual(tricky.extraPaths, ["a{b,c"]);
  assert.deepEqual(tricky.machineLocalSettings, ["x,}", "setupVersion"]);

  const warningsBeforeBroken = warnings.length;
  await fs.writeFile(path.join(tempDir, "omp-sync.jsonc"), "{ this is not json ");
  const broken = await readConfig({ dir: tempDir, notify });
  assert.deepEqual(broken, {});
  assert.equal(warnings.length, warningsBeforeBroken + 1, "an unparsable config must be reported");
});
