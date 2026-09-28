import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expandUserPath, warnConfigIssue } from "./config.js";
import { atomicWriteFile } from "./vault.js";
const exec = promisify(execFile);
const OMP_TIMEOUT_MS = 120_000;
export const PLUGIN_MANIFEST_FILE = "plugins.json";
export const PLUGIN_MANIFEST_VERSION = 1;
const UNPORTABLE_SPEC_PREFIX = /^(file|link|workspace|portal):/i;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
/** A spec that can be replayed verbatim on another machine (no local path, no local package reference). */
export function isPortablePluginSpec(spec) {
    const trimmed = spec.trim();
    if (trimmed === "" || trimmed.startsWith("~"))
        return false;
    if (trimmed === "." || trimmed === ".." || trimmed.startsWith("./") || trimmed.startsWith("../"))
        return false;
    if (trimmed.startsWith("/") || trimmed.startsWith("\\"))
        return false;
    return !WINDOWS_DRIVE.test(trimmed) && !UNPORTABLE_SPEC_PREFIX.test(trimmed);
}
/**
 * The host stores plugin state at `<configRoot>/plugins` (XDG: `$XDG_DATA_HOME/omp/plugins`), which is a
 * sibling of the managed agent directory. `PI_CODING_AGENT_DIR` and XDG can both move it away from
 * `dirname(agentDir)/plugins`, so the probes are ordered and `pluginsDir` in omp-sync.jsonc overrides them.
 */
export function pluginsRoot(dir, config = {}, exists = existsSync) {
    const candidates = [];
    if (config.pluginsDir)
        candidates.push(expandUserPath(config.pluginsDir));
    const xdgData = process.env.XDG_DATA_HOME?.trim();
    if (xdgData)
        candidates.push(path.join(xdgData, "omp", "plugins"));
    if (path.basename(dir) === "agent")
        candidates.push(path.join(path.dirname(dir), "plugins"));
    for (const candidate of candidates) {
        if (exists(path.join(candidate, "package.json")))
            return candidate;
    }
    return undefined;
}
async function readJsonFile(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
function normalizeFeatures(value) {
    if (!Array.isArray(value))
        return null;
    return [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim() !== ""))];
}
/** The declaration this machine would publish: install spec + enabled state, no settings, no local-only entries. */
export async function readLocalPlugins(dir, config = {}) {
    const root = pluginsRoot(dir, config);
    if (!root)
        return undefined;
    const [manifest, lock] = await Promise.all([
        readJsonFile(path.join(root, "package.json")),
        readJsonFile(path.join(root, "omp-plugins.lock.json")),
    ]);
    if (!manifest || !lock)
        return undefined;
    const machineLocal = new Set(config.machineLocalPlugins ?? []);
    const plugins = {};
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (typeof spec !== "string" || !isPortablePluginSpec(spec))
            continue;
        if (machineLocal.has(name))
            continue;
        const state = lock.plugins?.[name];
        plugins[name] = {
            spec: spec.trim(),
            enabled: typeof state?.enabled === "boolean" ? state.enabled : true,
            enabledFeatures: normalizeFeatures(state?.enabledFeatures),
        };
    }
    return { version: PLUGIN_MANIFEST_VERSION, plugins };
}
export async function readPluginManifest(dir, deps, ctx) {
    const raw = await fs.readFile(path.join(dir, PLUGIN_MANIFEST_FILE), "utf8").catch(() => undefined);
    if (raw === undefined)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        warnConfigIssue(deps, ctx, `omp-sync: ignoring unparsable ${PLUGIN_MANIFEST_FILE}`);
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.plugins !== "object" || parsed.plugins === null) {
        warnConfigIssue(deps, ctx, `omp-sync: ignoring ${PLUGIN_MANIFEST_FILE} without a plugin map`);
        return undefined;
    }
    if (parsed.version !== PLUGIN_MANIFEST_VERSION) {
        warnConfigIssue(deps, ctx, `omp-sync: ${PLUGIN_MANIFEST_FILE} was written by another version; run '/ompsync sync' to refresh it`);
        return undefined;
    }
    return parsed;
}
export function serializePluginManifest(manifest) {
    const plugins = {};
    for (const name of Object.keys(manifest.plugins).sort()) {
        const entry = manifest.plugins[name];
        plugins[name] = {
            spec: entry.spec,
            enabled: entry.enabled !== false,
            enabledFeatures: entry.enabledFeatures ? [...entry.enabledFeatures].sort() : null,
        };
    }
    return `${JSON.stringify({ version: PLUGIN_MANIFEST_VERSION, plugins }, null, 2)}\n`;
}
/**
 * Refresh the committed declaration from this machine's plugin root. Never throws: a plugin problem must not
 * block a config commit. Writes only when the bytes change, and leaves an existing file alone when this
 * machine has no plugin root (a machine that only ever pulls keeps the declaration it received).
 */
export async function refreshPluginManifest(dir, config = {}, deps) {
    try {
        const local = await readLocalPlugins(dir, config);
        if (!local)
            return;
        const next = serializePluginManifest(local);
        const file = path.join(dir, PLUGIN_MANIFEST_FILE);
        const current = await fs.readFile(file, "utf8").catch(() => undefined);
        if (current === next)
            return;
        await atomicWriteFile(file, next);
    }
    catch (error) {
        warnConfigIssue(deps, undefined, `omp-sync: could not refresh ${PLUGIN_MANIFEST_FILE} (${message(error)})`);
    }
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
function sameFeatures(a, b) {
    if (!b)
        return a.length === 0;
    return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}
/** Actions that turn this machine's plugin root into the declared state. Report-only kinds are never applied. */
export function pluginPlan(declared, local) {
    const actions = [];
    const freshInstall = { spec: "", enabled: true, enabledFeatures: null };
    for (const name of Object.keys(declared.plugins).sort()) {
        const want = declared.plugins[name];
        const have = local.plugins[name];
        if (!have) {
            actions.push({ kind: "install", name, spec: want.spec });
        }
        else if (have.spec !== want.spec) {
            actions.push({ kind: "spec-differs", name, spec: want.spec });
        }
        const current = have ?? freshInstall;
        if (current.enabled !== want.enabled) {
            actions.push({ kind: want.enabled ? "enable" : "disable", name });
        }
        // An explicit empty list (`[]` = every feature off) is mirrored but not replayed: the CLI cannot set an
        // empty feature set, so a declared `[]` leaves a fresh install at its defaults.
        if (want.enabledFeatures?.length && !sameFeatures(want.enabledFeatures, current.enabledFeatures)) {
            actions.push({ kind: "features", name, features: [...want.enabledFeatures] });
        }
    }
    for (const name of Object.keys(local.plugins).sort()) {
        if (!declared.plugins[name])
            actions.push({ kind: "local-only", name });
    }
    return actions;
}
export function describePluginAction(action) {
    switch (action.kind) {
        case "install":
            return `install ${action.name} (${action.spec})`;
        case "enable":
            return `enable ${action.name}`;
        case "disable":
            return `disable ${action.name}`;
        case "features":
            return `features ${action.name} --set ${action.features?.join(",") ?? ""}`;
        case "spec-differs":
            return `${action.name}: install spec differs (declared ${action.spec}); reinstall manually to change it`;
        case "local-only":
            return `${action.name}: installed here but not declared; left alone`;
    }
}
/** argv for `omp`; `undefined` for report-only kinds, which are never executed. */
export function pluginCommand(action) {
    switch (action.kind) {
        case "install":
            return ["plugin", "install", action.spec];
        case "enable":
            return ["plugin", "enable", action.name];
        case "disable":
            return ["plugin", "disable", action.name];
        case "features":
            return ["plugin", "features", action.name, "--set", action.features?.join(",") ?? ""];
        default:
            return undefined;
    }
}
/** The only place this plugin shells out to `omp`; write actions are delegated so the host owns its own bookkeeping. */
export async function applyPluginPlan(actions, deps) {
    const results = [];
    for (const action of actions) {
        const args = pluginCommand(action);
        if (!args)
            continue;
        try {
            await runOmp(args, deps);
            results.push({ action });
        }
        catch (error) {
            results.push({ action, error: message(error) });
        }
    }
    return results;
}
async function runOmp(args, deps) {
    if (deps?.omp)
        return deps.omp(args);
    return exec("omp", args, { timeout: OMP_TIMEOUT_MS, windowsHide: true });
}
//# sourceMappingURL=plugins.js.map