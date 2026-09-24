import type { OmpSyncConfig } from "./config.js";
export declare function stateDir(dir: string): string;
export declare function machineJsonKeys(config: OmpSyncConfig): string[];
export declare function machineYamlKeys(config: OmpSyncConfig): string[];
export declare function generateFilterScript(jsonKeys: string[], yamlKeys: string[]): string;
export declare function ensureAttributes(dir: string): Promise<void>;
export declare function ensureFilter(dir: string, config?: OmpSyncConfig): Promise<void>;
export declare function refreshMachineSidecar(dir: string, config?: OmpSyncConfig): Promise<void>;
//# sourceMappingURL=filter.d.ts.map