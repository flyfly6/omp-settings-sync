import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GhClient } from "./gh.js";
import { isDenied } from "./security.js";

export interface OmpSyncConfig {
  autoSyncIntervalMinutes?: number;
  includeHostname?: boolean;
  extraPaths?: string[];
  warnOnPublicRemote?: boolean;
  machineLocalSettings?: string[];
  machineLocalYamlKeys?: string[];
  preferRemote?: boolean;
  discardLocalOnConflict?: boolean;
}


export type Level = "info" | "warning" | "error";

export interface Deps {
  dir?: string;
  gh?: GhClient;
  notify?: (message: string, level: Level) => void;
}

export interface UIContext {
  hasUI?: boolean;
  ui?: {
    setStatus(key: string, status?: string): void;
    setWorkingMessage?(message?: string): void;
    notify(message: string, level: Level): void;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
    confirm?(title: string, message: string): Promise<boolean>;
    select?(
      title: string,
      options: Array<{ label: string; value?: string; description?: string }>
    ): Promise<string | undefined>;
  };
}

export type Ctx = UIContext | undefined;

export const DEFAULT_MACHINE_LOCAL_JSON = ["lastChangelogVersion", "setupVersion"];
export const DEFAULT_MACHINE_LOCAL_YAML = [
  "setupVersion",
  "shellPath",
  "dev.autoqaPush.token",
  "dev.autoqaConsent",
  "searxng.token",
  "searxng.basicUsername",
  "searxng.basicPassword",
  "hindsight.apiToken",
  "hindsight.apiUrl",
  "auth.broker.url",
  "auth.broker.token",
  "images.urls.credentials",
  "images.urls.command",
  "python.interpreter",
  "ruby.interpreter",
  "julia.interpreter",
  "browser.cdpUrl",
  "browser.relayUrl",
];

export function dirOf(deps?: Deps): string {
  if (deps?.dir) return path.resolve(deps.dir);
  const explicit = process.env.PI_CODING_AGENT_DIR?.trim();
  if (explicit) {
    if (explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")) {
      return path.resolve(path.join(os.homedir(), explicit.slice(2)));
    }
    return path.resolve(explicit);
  }
  const profile = process.env.OMP_PROFILE?.trim();
  if (profile) {
    return path.resolve(path.join(os.homedir(), ".omp", "profiles", profile, "agent"));
  }
  return path.resolve(path.join(os.homedir(), ".omp", "agent"));
}

export function stripJsonComments(input: string): string {
  let out = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const next = input[i + 1];
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") i++;
      if (input[i] === "\r" && input[i + 1] === "\n") {
        i++;
        out += "\r\n";
      } else {
        out += "\n";
      }
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

export function isValidExtraPath(entry: string): boolean {
  const trimmed = entry.trim();
  return trimmed !== "" && !trimmed.includes("..") && !path.isAbsolute(trimmed) && !isDenied(trimmed);
}

export async function readConfigFile(dir: string): Promise<string | undefined> {
  for (const filename of ["omp-sync.jsonc", "omp-sync.json", "git-sync.jsonc", "git-sync.json"]) {
    try {
      return await fs.readFile(path.join(dir, filename), "utf8");
    } catch {}
  }
  return undefined;
}

const warnedConfigIssues = new Set<string>();

function warnConfigIssue(deps: Deps | undefined, ctx: Ctx, message: string): void {
  if (warnedConfigIssues.has(message)) return;
  warnedConfigIssues.add(message);
  if (deps?.notify) deps.notify(message, "warning");
  else if (ctx?.hasUI && ctx.ui) ctx.ui.notify(message, "warning");
  else if (!ctx) process.stderr.write(`${message}\n`);
}

/** JSONC permits trailing commas, plain JSON does not: drop commas that precede `}` or `]`. */
export function stripTrailingCommas(input: string): string {
  let out = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      const next = input[j];
      if (next === "}" || next === "]") continue;
    }
    out += c;
  }
  return out;
}

export async function readConfig(deps?: Deps, ctx?: Ctx): Promise<OmpSyncConfig> {
  const dir = dirOf(deps);
  const rawText = await readConfigFile(dir);
  if (!rawText) return {};

  const cleaned = stripJsonComments(rawText);
  let raw: OmpSyncConfig;
  try {
    raw = JSON.parse(cleaned) as OmpSyncConfig;
  } catch (strictError) {
    try {
      raw = JSON.parse(stripTrailingCommas(cleaned)) as OmpSyncConfig;
      warnConfigIssue(deps, ctx, "omp-sync: config file has a trailing comma; parsed leniently");
    } catch {
      const reason = strictError instanceof Error ? strictError.message : String(strictError);
      warnConfigIssue(deps, ctx, `omp-sync: ignoring unparsable config file (${reason})`);
      return {};
    }
  }

  const extras = (raw.extraPaths ?? []).filter(isValidExtraPath);

  let machineLocalSettings: string[] | undefined;
  if (Array.isArray(raw.machineLocalSettings)) {
    machineLocalSettings = raw.machineLocalSettings.filter(
      (key): key is string => typeof key === "string" && key.trim() !== ""
    );
  }

  let machineLocalYamlKeys: string[] | undefined;
  if (Array.isArray(raw.machineLocalYamlKeys)) {
    machineLocalYamlKeys = raw.machineLocalYamlKeys.filter(
      (key): key is string => typeof key === "string" && key.trim() !== ""
    );
  }

  return {
    ...raw,
    extraPaths: extras,
    machineLocalSettings,
    machineLocalYamlKeys,
  };
}
