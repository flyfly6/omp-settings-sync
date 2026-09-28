import type { OmpSyncConfig } from "./config.js";
export declare function stateDir(dir: string): string;
export declare function machineJsonKeys(config: OmpSyncConfig): string[];
export declare function machineYamlKeys(config: OmpSyncConfig): string[];
/** Fields inside every MCP server entry whose values are machine-specific (paths, shims, Windows-only env). */
export declare function mcpFields(config: OmpSyncConfig): string[];
/** Server names whose entire entry stays on this machine (a server that only exists on one platform). */
export declare function mcpLocalServers(config: OmpSyncConfig): string[];
export declare function generateFilterScript(jsonKeys: string[], yamlKeys: string[], mcpFieldKeys: string[], mcpServerNames: string[]): string;
export declare function ensureAttributes(dir: string): Promise<boolean>;
export declare function ensureFilter(dir: string, config?: OmpSyncConfig): Promise<void>;
export declare function refreshMachineSidecar(dir: string, config?: OmpSyncConfig): Promise<void>;
/**
 * Servers the synced copy reduced to a stub: their transport fields never sync, so a machine that never
 * held them locally receives an entry without `command` or `url` until someone fills in this platform's value.
 */
export declare function mcpServersMissingLocalValues(dir: string, config?: OmpSyncConfig): Promise<string[]>;
//# sourceMappingURL=filter.d.ts.map