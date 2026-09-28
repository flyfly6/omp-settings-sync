/** Parses `owner/repo`, GitHub HTTPS URLs, and `git@github.com:owner/repo` into an owner/name pair. */
export declare function parseRepoReference(input: string): {
    owner: string;
    name: string;
} | undefined;
/**
 * Resolves the remote argument of `init`/`link`. Full URLs, scp-like SSH addresses, and local paths pass
 * through untouched; `owner/repo` shorthand expands to its GitHub URL. No remote is inferred without an argument.
 */
export declare function remoteFromArg(arg: string): string | undefined;
//# sourceMappingURL=remote.d.ts.map