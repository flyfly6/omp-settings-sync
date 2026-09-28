export interface OmpSyncConfig {
    autoSyncIntervalMinutes?: number;
    includeHostname?: boolean;
    extraPaths?: string[];
    excludePaths?: string[];
    warnOnPublicRemote?: boolean;
    machineLocalSettings?: string[];
    machineLocalYamlKeys?: string[];
    machineLocalMcpFields?: string[];
    machineLocalMcpServers?: string[];
    machineLocalPlugins?: string[];
    pluginsDir?: string;
    preferRemote?: boolean;
    discardLocalOnConflict?: boolean;
}
export type Level = "info" | "warning" | "error";
export interface Deps {
    dir?: string;
    notify?: (message: string, level: Level) => void;
    /** Test seam: replaces the real `omp` child process used by the plugin commands. */
    omp?: (args: string[], cwd?: string) => Promise<{
        stdout: string;
    }>;
}
export interface UIContext {
    hasUI?: boolean;
    ui?: {
        setStatus(key: string, status?: string): void;
        setWorkingMessage?(message?: string): void;
        notify(message: string, level: Level): void;
        input?(title: string, placeholder?: string): Promise<string | undefined>;
        confirm?(title: string, message: string): Promise<boolean>;
        select?(title: string, options: Array<{
            label: string;
            value?: string;
            description?: string;
        }>): Promise<string | undefined>;
    };
}
export type Ctx = UIContext | undefined;
export declare const DEFAULT_MACHINE_LOCAL_JSON: string[];
export declare const DEFAULT_MACHINE_LOCAL_YAML: string[];
/** MCP server fields whose values differ per machine (absolute paths, npx/vendor shims, Windows-only env). */
export declare const DEFAULT_MACHINE_LOCAL_MCP_FIELDS: string[];
/** Expand a leading `~` and resolve to an absolute path. */
export declare function expandUserPath(value: string): string;
export declare function dirOf(deps?: Deps): string;
export declare function stripJsonComments(input: string): string;
export declare function isValidExtraPath(entry: string): boolean;
export declare function readConfigFile(dir: string): Promise<string | undefined>;
export declare function warnConfigIssue(deps: Deps | undefined, ctx: Ctx, message: string): void;
/** JSONC permits trailing commas, plain JSON does not: drop commas that precede `}` or `]`. */
export declare function stripTrailingCommas(input: string): string;
export declare function readConfig(deps?: Deps, ctx?: Ctx): Promise<OmpSyncConfig>;
//# sourceMappingURL=config.d.ts.map