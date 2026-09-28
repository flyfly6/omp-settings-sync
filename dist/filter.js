import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MACHINE_LOCAL_JSON, DEFAULT_MACHINE_LOCAL_MCP_FIELDS, DEFAULT_MACHINE_LOCAL_YAML, } from "./config.js";
import { git, hasDotGit } from "./git.js";
export function stateDir(dir) {
    return path.join(dir, ".git-sync");
}
export function machineJsonKeys(config) {
    return config.machineLocalSettings ?? DEFAULT_MACHINE_LOCAL_JSON;
}
export function machineYamlKeys(config) {
    return config.machineLocalYamlKeys ?? DEFAULT_MACHINE_LOCAL_YAML;
}
/** Fields inside every MCP server entry whose values are machine-specific (paths, shims, Windows-only env). */
export function mcpFields(config) {
    return config.machineLocalMcpFields ?? DEFAULT_MACHINE_LOCAL_MCP_FIELDS;
}
/** Server names whose entire entry stays on this machine (a server that only exists on one platform). */
export function mcpLocalServers(config) {
    return config.machineLocalMcpServers ?? [];
}
const MCP_FILTER_ATTRIBUTE = "mcp.json filter=omp-config-sync-mcp";
export function generateFilterScript(jsonKeys, yamlKeys, mcpFieldKeys, mcpServerNames) {
    return `import fs from "node:fs";

const jsonKeys = ${JSON.stringify(jsonKeys)};
const yamlKeys = ${JSON.stringify(yamlKeys)};
const mcpFields = ${JSON.stringify(mcpFieldKeys)};
const mcpLocalServers = ${JSON.stringify(mcpServerNames)};

const mode = process.argv[2];
const format = process.argv[3] || "json";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks);
const text = raw.toString("utf8");

function cleanYamlLine(line, keys) {
  const trimmed = line.trimStart();
  for (const key of keys) {
    const prefix = key + ":";
    if (trimmed.startsWith(prefix) && line.search(/\\S/) === 0) {
      return true;
    }
  }
  return false;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

try {
  const lineEnding = text.includes("\\r\\n") ? "\\r\\n" : "\\n";
  if (format === "yaml") {
    if (mode === "clean") {
      const lines = text.split(/\\r?\\n/);
      const filtered = [];
      let skippingBlock = false;
      let blockIndent = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const indent = line.search(/\\S/);

        if (skippingBlock) {
          if (indent > blockIndent && line.trim() !== "") {
            continue;
          } else {
            skippingBlock = false;
          }
        }

        if (cleanYamlLine(line, yamlKeys)) {
          skippingBlock = true;
          blockIndent = indent >= 0 ? indent : 0;
          continue;
        }

        filtered.push(line);
      }
      process.stdout.write(filtered.join(lineEnding));
    } else if (mode === "smudge") {
      const sidecarPath = new URL("config.machine.yml", import.meta.url);
      let sidecarText = "";
      try {
        sidecarText = fs.readFileSync(sidecarPath, "utf8");
      } catch {}
      const combined =
        (text.trim() ? text.trim() + lineEnding : "") +
        sidecarText.trim() +
        (sidecarText.trim() ? lineEnding : "");
      process.stdout.write(combined);
    } else {
      process.stdout.write(raw);
    }
  } else if (format === "mcp") {
    const value = JSON.parse(text);
    const document = asRecord(value);
    if (!document) throw new Error("not object");
    const servers = asRecord(document.mcpServers);

    if (mode === "clean") {
      if (servers) {
        for (const name of mcpLocalServers) delete servers[name];
        for (const server of Object.values(servers)) {
          const entry = asRecord(server);
          if (!entry) continue;
          for (const field of mcpFields) delete entry[field];
        }
      }
      process.stdout.write(JSON.stringify(document, null, 2) + lineEnding);
    } else if (mode === "smudge") {
      if (!servers) {
        process.stdout.write(raw);
      } else {
        const sidecarPath = new URL("mcp.machine.json", import.meta.url);
        let local = {};
        try {
          const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
          local = asRecord(asRecord(sidecar)?.mcpServers) || {};
        } catch {}
        for (const [name, patch] of Object.entries(local)) {
          const fields = asRecord(patch);
          if (!fields) continue;
          const base = asRecord(servers[name]);
          servers[name] = base ? { ...base, ...fields } : fields;
        }
        process.stdout.write(JSON.stringify(document, null, 2) + lineEnding);
      }
    } else {
      process.stdout.write(raw);
    }
  } else {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not object");

    if (mode === "clean") {
      for (const key of jsonKeys) delete value[key];
      process.stdout.write(JSON.stringify(value, null, 2) + lineEnding);
    } else if (mode === "smudge") {
      const sidecarPath = new URL("settings.machine.json", import.meta.url);
      let sidecar = {};
      try {
        sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      } catch {}
      process.stdout.write(JSON.stringify({ ...value, ...sidecar }, null, 2) + lineEnding);
    } else {
      process.stdout.write(raw);
    }
  }
} catch {
  process.stdout.write(raw);
}
`;
}
async function renormalizeFilteredFiles(dir) {
    const files = ["config.yml", "config.yaml", "settings.json", "mcp.json"];
    // `git add --renormalize` aborts as a whole when a pathspec matches nothing, so narrow it to the tracked
    // files first (one spawn) instead of adding each path blindly (four spawns, each able to fail).
    let tracked;
    try {
        const { stdout } = await git(["ls-files", "-z", "--", ...files], dir);
        tracked = stdout.split("\0").filter(Boolean);
    }
    catch {
        return;
    }
    if (!tracked.length)
        return;
    try {
        await git(["add", "--renormalize", "--", ...tracked], dir);
    }
    catch { }
}
/** Every filter setting in one spawn: the per-key variant cost nine process launches per sync. */
async function readFilterConfig(dir) {
    const values = new Map();
    try {
        const { stdout } = await git(["config", "--get-regexp", "^filter\\.omp-config-sync-"], dir);
        for (const line of stdout.split(/\r?\n/)) {
            const separator = line.indexOf(" ");
            if (separator < 0)
                continue;
            values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
        }
    }
    catch { }
    return values;
}
export async function ensureAttributes(dir) {
    const file = path.join(dir, ".gitattributes");
    let current = "";
    try {
        current = await fs.readFile(file, "utf8");
    }
    catch { }
    const rules = [
        "config.yml filter=omp-config-sync-yaml",
        "config.yaml filter=omp-config-sync-yaml",
        "settings.json filter=omp-config-sync-json",
        MCP_FILTER_ATTRIBUTE,
    ];
    // Releases before MCP-aware syncing routed mcp.json through the plain JSON driver; a stale rule keeps
    // machine-specific commands in the committed blob, so drop the filter rule for every file we now own
    // (their other attributes are left alone).
    const targets = new Set(rules.map((rule) => rule.split(/\s+/)[0]));
    const kept = current
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => {
        if (line === "")
            return false;
        if (!targets.has(line.split(/\s+/)[0] ?? ""))
            return true;
        return rules.includes(line) || !line.includes("filter=");
    });
    const missing = rules.filter((rule) => !kept.includes(rule));
    const next = [...kept, ...missing].join("\n") + "\n";
    if (next.trim() === current.trim())
        return false;
    await fs.writeFile(file, next);
    if (await hasDotGit(dir))
        await renormalizeFilteredFiles(dir);
    return true;
}
function formatFilterCommand(scriptPath, mode, format) {
    const nodeExec = process.execPath.replaceAll("\\", "/");
    const script = scriptPath.replaceAll("\\", "/");
    return `"${nodeExec}" "${script}" ${mode} ${format}`;
}
export async function ensureFilter(dir, config = {}) {
    if (!(await hasDotGit(dir)))
        return;
    await fs.mkdir(stateDir(dir), { recursive: true });
    const scriptPath = path.join(stateDir(dir), "filter.mjs");
    const source = generateFilterScript(machineJsonKeys(config), machineYamlKeys(config), mcpFields(config), mcpLocalServers(config));
    try {
        if ((await fs.readFile(scriptPath, "utf8")) !== source) {
            await fs.writeFile(scriptPath, source);
        }
    }
    catch {
        await fs.writeFile(scriptPath, source);
    }
    const configs = {
        "filter.omp-config-sync-yaml.clean": formatFilterCommand(scriptPath, "clean", "yaml"),
        "filter.omp-config-sync-yaml.smudge": formatFilterCommand(scriptPath, "smudge", "yaml"),
        "filter.omp-config-sync-yaml.required": "false",
        "filter.omp-config-sync-json.clean": formatFilterCommand(scriptPath, "clean", "json"),
        "filter.omp-config-sync-json.smudge": formatFilterCommand(scriptPath, "smudge", "json"),
        "filter.omp-config-sync-json.required": "false",
        "filter.omp-config-sync-mcp.clean": formatFilterCommand(scriptPath, "clean", "mcp"),
        "filter.omp-config-sync-mcp.smudge": formatFilterCommand(scriptPath, "smudge", "mcp"),
        "filter.omp-config-sync-mcp.required": "false",
    };
    const current = await readFilterConfig(dir);
    let changed = false;
    for (const [k, v] of Object.entries(configs)) {
        if (current.get(k) === v)
            continue;
        await git(["config", k, v], dir);
        changed = true;
    }
    if (changed)
        await renormalizeFilteredFiles(dir);
}
export async function refreshMachineSidecar(dir, config = {}) {
    await fs.mkdir(stateDir(dir), { recursive: true });
    // 1. JSON sidecar
    try {
        const raw = await fs.readFile(path.join(dir, "settings.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const keys = machineJsonKeys(config);
            const settingsRecord = parsed;
            const sidecar = Object.fromEntries(keys.filter((k) => Object.hasOwn(settingsRecord, k)).map((k) => [k, settingsRecord[k]]));
            await fs.writeFile(path.join(stateDir(dir), "settings.machine.json"), JSON.stringify(sidecar, null, 2) + "\n");
        }
    }
    catch { }
    // 2. YAML sidecar
    try {
        const raw = await fs.readFile(path.join(dir, "config.yml"), "utf8");
        const keys = new Set(machineYamlKeys(config));
        const lines = raw.split(/\r?\n/);
        const extracted = [];
        let capturing = false;
        let captureIndent = 0;
        for (const line of lines) {
            const indent = line.search(/\S/);
            if (capturing) {
                if (indent > captureIndent && line.trim() !== "") {
                    extracted.push(line);
                    continue;
                }
                else {
                    capturing = false;
                }
            }
            const trimmed = line.trimStart();
            for (const key of keys) {
                if (trimmed.startsWith(`${key}:`) && indent === 0) {
                    capturing = true;
                    captureIndent = indent;
                    extracted.push(line);
                    break;
                }
            }
        }
        if (extracted.length) {
            await fs.writeFile(path.join(stateDir(dir), "config.machine.yml"), extracted.join("\n") + "\n");
        }
    }
    catch { }
    // 3. MCP sidecar: the machine-specific half of every MCP server entry, captured before any checkout
    // replaces the local copy with the committed (machine-neutral) one.
    try {
        const raw = await fs.readFile(path.join(dir, "mcp.json"), "utf8");
        const document = asRecord(JSON.parse(raw));
        const servers = asRecord(document?.mcpServers);
        if (servers) {
            const fields = mcpFields(config);
            const local = new Set(mcpLocalServers(config));
            const sidecar = {};
            for (const [name, value] of Object.entries(servers)) {
                const entry = asRecord(value);
                if (!entry)
                    continue;
                if (local.has(name)) {
                    sidecar[name] = entry;
                    continue;
                }
                const patch = Object.fromEntries(fields.filter((field) => Object.hasOwn(entry, field)).map((field) => [field, entry[field]]));
                if (Object.keys(patch).length)
                    sidecar[name] = patch;
            }
            await fs.writeFile(path.join(stateDir(dir), "mcp.machine.json"), JSON.stringify({ mcpServers: sidecar }, null, 2) + "\n");
        }
    }
    catch { }
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/**
 * Servers the synced copy reduced to a stub: their transport fields never sync, so a machine that never
 * held them locally receives an entry without `command` or `url` until someone fills in this platform's value.
 */
export async function mcpServersMissingLocalValues(dir, config = {}) {
    if (!mcpFields(config).length)
        return [];
    let document;
    try {
        document = asRecord(JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8")));
    }
    catch {
        return [];
    }
    const servers = asRecord(document?.mcpServers);
    if (!servers)
        return [];
    const disabled = new Set((Array.isArray(document?.disabledServers) ? document.disabledServers : []).filter((name) => typeof name === "string"));
    const local = new Set(mcpLocalServers(config));
    return Object.entries(servers)
        .filter(([name, value]) => {
        if (local.has(name) || disabled.has(name))
            return false;
        const entry = asRecord(value);
        if (!entry)
            return false;
        return entry.command === undefined && entry.url === undefined;
    })
        .map(([name]) => name);
}
//# sourceMappingURL=filter.js.map