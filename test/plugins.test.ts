import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { git } from "../src/git.js";
import {
  applyPluginPlan,
  describePluginAction,
  isPortablePluginSpec,
  PLUGIN_MANIFEST_FILE,
  pluginCommand,
  pluginPlan,
  pluginsRoot,
  readLocalPlugins,
  readPluginManifest,
  refreshPluginManifest,
  serializePluginManifest,
  type PluginAction,
  type PluginManifest,
} from "../src/plugins.js";
import { runInit, runLink, runSync, showPluginPlan } from "../src/sync.js";
import { createBareRemote, createMachineFixture } from "./helpers.js";

// The plugin-root probe consults XDG_DATA_HOME (the host prefers it on Linux/macOS); clear it so the
// fixture layout is the only candidate that can match.
delete process.env.XDG_DATA_HOME;

async function writePluginRoot(root: string, dependencies: Record<string, string>, lock: unknown) {
  const dir = path.join(root, "plugins");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "omp-plugins", private: true, dependencies }, null, 2)}\n`
  );
  await fs.writeFile(path.join(dir, "omp-plugins.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return dir;
}

test("isPortablePluginSpec keeps host-installable specs and rejects machine-local sources", () => {
  for (const spec of [
    "^4.10.0",
    "omp-settings-sync",
    "@dietrichgebert/ponytail",
    "github:flyfly6/omp-settings-sync",
    "https://github.com/user/repo#v1.0",
    "name@marketplace",
    "pkg@1.2.3",
  ]) {
    assert.ok(isPortablePluginSpec(spec), `expected portable: ${spec}`);
  }

  for (const spec of [
    "",
    "   ",
    ".",
    "..",
    "./local/plugin",
    "../local",
    "/opt/plugins/mine",
    "~/plugins/mine",
    "C:\\plugins\\mine",
    "\\\\server\\share\\plugin",
    "file:../pkg",
    "link:/tmp/pkg",
    "workspace:*",
  ]) {
    assert.ok(!isPortablePluginSpec(spec), `expected local-only: ${spec}`);
  }
});

test("readLocalPlugins mirrors portable specs with their lock state and drops local-only entries", async () => {
  const { root, dir } = await createMachineFixture("plugin-mirror");
  await writePluginRoot(
    root,
    {
      "@dietrichgebert/ponytail": "^4.10.0",
      "omp-settings-sync": "github:flyfly6/omp-settings-sync",
      "my-local": "link:/tmp/my-local",
      "win-only": "^1.0.0",
      unlisted: "^2.0.0",
    },
    {
      plugins: {
        "@dietrichgebert/ponytail": { version: "4.10.0", enabled: false, enabledFeatures: ["b", "a"] },
        "omp-settings-sync": { version: "0.1.8", enabled: true, enabledFeatures: null },
        "my-local": { version: "0.0.1", enabled: true, enabledFeatures: null },
        "win-only": { version: "1.0.0", enabled: true, enabledFeatures: null },
        "lock-only": { version: "9.9.9", enabled: true, enabledFeatures: null },
      },
      settings: { "omp-settings-sync": {} },
    }
  );

  const manifest = await readLocalPlugins(dir, { machineLocalPlugins: ["win-only"] });
  assert.deepEqual(manifest, {
    version: 1,
    plugins: {
      "@dietrichgebert/ponytail": { spec: "^4.10.0", enabled: false, enabledFeatures: ["b", "a"] },
      "omp-settings-sync": { spec: "github:flyfly6/omp-settings-sync", enabled: true, enabledFeatures: null },
      unlisted: { spec: "^2.0.0", enabled: true, enabledFeatures: null },
    },
  });
});

test("readLocalPlugins reports no registry instead of an empty declaration", async () => {
  const { root, dir } = await createMachineFixture("plugin-no-root");
  assert.equal(pluginsRoot(dir), undefined);
  assert.equal(await readLocalPlugins(dir), undefined);
  assert.equal(await readPluginManifest(dir), undefined);

  await writePluginRoot(root, { pkg: "^1.0.0" }, { plugins: {} });
  assert.equal(pluginsRoot(dir), path.join(root, "plugins"));
  assert.deepEqual(
    await readLocalPlugins(dir),
    { version: 1, plugins: { pkg: { spec: "^1.0.0", enabled: true, enabledFeatures: null } } },
    "a dependency with no lock entry is declared with fresh-install defaults"
  );

  await writePluginRoot(root, { pkg: "^1.0.0" }, { plugins: { pkg: { enabled: false, enabledFeatures: "not-a-list" } } });
  assert.deepEqual((await readLocalPlugins(dir))?.plugins.pkg, { spec: "^1.0.0", enabled: false, enabledFeatures: null });

  await fs.writeFile(path.join(root, "plugins", "omp-plugins.lock.json"), "{ this is not json");
  assert.equal(await readLocalPlugins(dir), undefined, "a lock file this plugin cannot read is not a registry");
});

test("pluginsDir in omp-sync.jsonc overrides plugin root discovery", async () => {
  const { root, dir } = await createMachineFixture("plugin-root-override");
  const custom = await writePluginRoot(root, { pkg: "^1.0.0" }, { plugins: { pkg: { enabled: true, enabledFeatures: null } } });
  await fs.rename(custom, path.join(root, "elsewhere"));

  assert.equal(pluginsRoot(dir), undefined);
  assert.equal(pluginsRoot(dir, { pluginsDir: path.join(root, "elsewhere") }), path.join(root, "elsewhere"));
  assert.deepEqual(await readLocalPlugins(dir, { pluginsDir: "~/nowhere" }), undefined);
});

test("refreshPluginManifest writes only when the declaration changes and survives a vanished registry", async () => {
  const { root, dir } = await createMachineFixture("plugin-refresh");
  await writePluginRoot(
    root,
    { zeta: "^1.0.0", alpha: "github:u/alpha" },
    {
      plugins: {
        zeta: { version: "1.0.0", enabled: true, enabledFeatures: ["b", "a"] },
        alpha: { version: "2.0.0", enabled: false, enabledFeatures: null },
      },
    }
  );

  await refreshPluginManifest(dir);
  const file = path.join(dir, PLUGIN_MANIFEST_FILE);
  const written = await fs.readFile(file, "utf8");
  assert.deepEqual(JSON.parse(written), {
    version: 1,
    plugins: {
      alpha: { spec: "github:u/alpha", enabled: false, enabledFeatures: null },
      zeta: { spec: "^1.0.0", enabled: true, enabledFeatures: ["a", "b"] },
    },
  });
  assert.ok(written.indexOf("alpha") < written.indexOf("zeta"), "plugins must be emitted in sorted order");

  const mtime = (await fs.stat(file)).mtimeMs;
  await refreshPluginManifest(dir);
  assert.equal((await fs.stat(file)).mtimeMs, mtime, "an unchanged machine must not rewrite the declaration");

  await fs.rm(path.join(root, "plugins"), { recursive: true, force: true });
  await refreshPluginManifest(dir);
  assert.equal(await fs.readFile(file, "utf8"), written, "a machine without a registry keeps the pulled declaration");
});

test("refreshPluginManifest never throws when the registry is unreadable", async () => {
  const { root, dir } = await createMachineFixture("plugin-refresh-broken");
  await writePluginRoot(root, { pkg: "^1.0.0" }, { plugins: {} });
  await fs.writeFile(path.join(root, "plugins", "package.json"), "not json at all");

  const warnings: string[] = [];
  await refreshPluginManifest(dir, {}, { dir, notify: (message: string) => warnings.push(message) });
  assert.equal(await fs.readFile(path.join(dir, PLUGIN_MANIFEST_FILE), "utf8").catch(() => undefined), undefined);
  assert.deepEqual(warnings, []);
});

test("readPluginManifest ignores a foreign version and a missing plugin map", async () => {
  const { dir } = await createMachineFixture("plugin-manifest-read");
  const warnings: string[] = [];
  const deps = { dir, notify: (message: string) => warnings.push(message) };

  await fs.writeFile(path.join(dir, PLUGIN_MANIFEST_FILE), `{"version": 99, "plugins": {}}\n`);
  assert.equal(await readPluginManifest(dir, deps), undefined);
  assert.equal(warnings.length, 1);

  await fs.writeFile(path.join(dir, PLUGIN_MANIFEST_FILE), `{"version": 1}\n`);
  assert.equal(await readPluginManifest(dir, deps), undefined);
  assert.equal(warnings.length, 2);
});

test("pluginPlan lists installs and state deviations, never uninstalls", () => {
  const declared: PluginManifest = {
    version: 1,
    plugins: {
      "@dietrichgebert/ponytail": { spec: "^4.10.0", enabled: false, enabledFeatures: ["search"] },
      "not-here": { spec: "^1.0.0", enabled: true, enabledFeatures: ["x"] },
      "omp-settings-sync": { spec: "github:flyfly6/omp-settings-sync", enabled: true, enabledFeatures: null },
    },
  };
  const local: PluginManifest = {
    version: 1,
    plugins: {
      "@dietrichgebert/ponytail": { spec: "^4.10.0", enabled: true, enabledFeatures: ["search"] },
      "mine-only": { spec: "./local", enabled: true, enabledFeatures: null },
      "omp-settings-sync": { spec: "npm:omp-settings-sync", enabled: true, enabledFeatures: null },
    },
  };

  assert.deepEqual(pluginPlan(declared, local), [
    { kind: "disable", name: "@dietrichgebert/ponytail" },
    { kind: "install", name: "not-here", spec: "^1.0.0" },
    { kind: "features", name: "not-here", features: ["x"] },
    { kind: "spec-differs", name: "omp-settings-sync", spec: "github:flyfly6/omp-settings-sync" },
    { kind: "local-only", name: "mine-only" },
  ]);

  assert.deepEqual(pluginPlan({ version: 1, plugins: {} }, local), [
    { kind: "local-only", name: "@dietrichgebert/ponytail" },
    { kind: "local-only", name: "mine-only" },
    { kind: "local-only", name: "omp-settings-sync" },
  ]);
});

test("applyPluginPlan runs only executable commands and continues past a failure", async () => {
  const calls: string[][] = [];
  const deps = {
    omp: async (args: string[]) => {
      calls.push(args);
      if (args[2] === "^1.0.0") throw new Error("boom");
      return { stdout: "" };
    },
  };
  const actions: PluginAction[] = [
    { kind: "install", name: "good", spec: "github:u/good" },
    { kind: "install", name: "bad-plugin", spec: "^1.0.0" },
    { kind: "disable", name: "good" },
    { kind: "features", name: "good", features: ["a", "b"] },
    { kind: "spec-differs", name: "good", spec: "x" },
    { kind: "local-only", name: "mine" },
  ];

  const results = await applyPluginPlan(actions, deps);
  assert.deepEqual(calls, [
    ["plugin", "install", "github:u/good"],
    ["plugin", "install", "^1.0.0"],
    ["plugin", "disable", "good"],
    ["plugin", "features", "good", "--set", "a,b"],
  ]);
  assert.equal(results.length, 4);
  assert.deepEqual(
    results.filter((result) => result.error).map((result) => result.action.name),
    ["bad-plugin"]
  );
  assert.match(results[1]!.error!, /boom/);
  assert.equal(pluginCommand({ kind: "spec-differs", name: "x" }), undefined);
  assert.equal(pluginCommand({ kind: "local-only", name: "x" }), undefined);
});

test("describePluginAction states what each planned action does", () => {
  assert.equal(describePluginAction({ kind: "install", name: "pkg", spec: "github:u/pkg" }), "install pkg (github:u/pkg)");
  assert.equal(describePluginAction({ kind: "features", name: "pkg", features: ["a", "b"] }), "features pkg --set a,b");
  assert.match(describePluginAction({ kind: "spec-differs", name: "pkg", spec: "x" }), /reinstall manually/);
  assert.match(describePluginAction({ kind: "local-only", name: "pkg" }), /left alone/);
});

test("serializePluginManifest normalizes feature order and enabled defaults", () => {
  const manifest: PluginManifest = {
    version: 1,
    plugins: {
      zeta: { spec: "zeta", enabled: true, enabledFeatures: ["b", "a"] },
      empty: { spec: "empty", enabled: true, enabledFeatures: [] },
    },
  };
  const parsed = JSON.parse(serializePluginManifest(manifest)) as PluginManifest;
  assert.deepEqual(Object.keys(parsed.plugins), ["empty", "zeta"]);
  assert.deepEqual(parsed.plugins.zeta!.enabledFeatures, ["a", "b"]);
  assert.deepEqual(parsed.plugins.empty!.enabledFeatures, [], "an explicit empty list stays explicit");
});

test("a real sync commits the declaration and never tracks the plugin registry", async () => {
  const a = await createMachineFixture("plugin-e2e-a");
  const remote = await createBareRemote(a.root);
  await runInit(remote, undefined, { dir: a.dir });

  await writePluginRoot(
    a.root,
    { "omp-settings-sync": "github:flyfly6/omp-settings-sync" },
    { plugins: { "omp-settings-sync": { version: "0.1.8", enabled: true, enabledFeatures: null } } }
  );
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(a.dir, PLUGIN_MANIFEST_FILE), "utf8")), {
    version: 1,
    plugins: { "omp-settings-sync": { spec: "github:flyfly6/omp-settings-sync", enabled: true, enabledFeatures: null } },
  });

  const tracked = (await git(["ls-files"], a.dir)).stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(tracked.includes(PLUGIN_MANIFEST_FILE), `declaration must be tracked, got: ${tracked.join(", ")}`);
  assert.ok(
    !tracked.some((file) => file.startsWith("plugins/")),
    "the plugin registry itself must never be tracked"
  );

  const b = await createMachineFixture("plugin-e2e-b");
  await runLink(remote, undefined, { dir: b.dir });
  const notices: string[] = [];
  await showPluginPlan(undefined, { dir: b.dir, notify: (message: string) => notices.push(message) });
  assert.ok(
    notices.some((line) => line.includes("no plugin registry on this machine")),
    `a machine without a registry must say so: ${notices.join(" | ")}`
  );
});
