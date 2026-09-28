import type { Ctx, Deps, OmpSyncConfig } from "./config.js";
export declare const PLUGIN_MANIFEST_FILE = "plugins.json";
export declare const PLUGIN_MANIFEST_VERSION = 1;
export interface PluginDeclaration {
    /** Install spec exactly as the plugin root's `package.json` records it. */
    spec: string;
    enabled: boolean;
    enabledFeatures: string[] | null;
}
export interface PluginManifest {
    version: number;
    plugins: Record<string, PluginDeclaration>;
}
export type PluginActionKind = "install" | "enable" | "disable" | "features" | "spec-differs" | "local-only";
export interface PluginAction {
    kind: PluginActionKind;
    name: string;
    spec?: string;
    features?: string[];
}
export interface PluginActionResult {
    action: PluginAction;
    error?: string;
}
/** A spec that can be replayed verbatim on another machine (no local path, no local package reference). */
export declare function isPortablePluginSpec(spec: string): boolean;
/**
 * The host stores plugin state at `<configRoot>/plugins` (XDG: `$XDG_DATA_HOME/omp/plugins`), which is a
 * sibling of the managed agent directory. `PI_CODING_AGENT_DIR` and XDG can both move it away from
 * `dirname(agentDir)/plugins`, so the probes are ordered and `pluginsDir` in omp-sync.jsonc overrides them.
 */
export declare function pluginsRoot(dir: string, config?: OmpSyncConfig, exists?: (candidate: string) => boolean): string | undefined;
/** The declaration this machine would publish: install spec + enabled state, no settings, no local-only entries. */
export declare function readLocalPlugins(dir: string, config?: OmpSyncConfig): Promise<PluginManifest | undefined>;
export declare function readPluginManifest(dir: string, deps?: Deps, ctx?: Ctx): Promise<PluginManifest | undefined>;
export declare function serializePluginManifest(manifest: PluginManifest): string;
/**
 * Refresh the committed declaration from this machine's plugin root. Never throws: a plugin problem must not
 * block a config commit. Writes only when the bytes change, and leaves an existing file alone when this
 * machine has no plugin root (a machine that only ever pulls keeps the declaration it received).
 */
export declare function refreshPluginManifest(dir: string, config?: OmpSyncConfig, deps?: Deps): Promise<void>;
/** Actions that turn this machine's plugin root into the declared state. Report-only kinds are never applied. */
export declare function pluginPlan(declared: PluginManifest, local: PluginManifest): PluginAction[];
export declare function describePluginAction(action: PluginAction): string;
/** argv for `omp`; `undefined` for report-only kinds, which are never executed. */
export declare function pluginCommand(action: PluginAction): string[] | undefined;
/** The only place this plugin shells out to `omp`; write actions are delegated so the host owns its own bookkeeping. */
export declare function applyPluginPlan(actions: PluginAction[], deps?: Deps): Promise<PluginActionResult[]>;
//# sourceMappingURL=plugins.d.ts.map