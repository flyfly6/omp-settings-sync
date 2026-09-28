import path from "node:path";

/** Parses `owner/repo`, GitHub HTTPS URLs, and `git@github.com:owner/repo` into an owner/name pair. */
export function parseRepoReference(input: string): { owner: string; name: string } | undefined {
  const raw = input.trim().replace(/\.git$/i, "");
  if (!raw) return undefined;

  const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };

  try {
    const url = new URL(raw);
    if (["github.com", "www.github.com"].includes(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 2) {
        return { owner: parts[0]!, name: parts[1]!.replace(/\.git$/i, "") };
      }
    }
  } catch {}

  const bits = raw.split("/").filter(Boolean);
  if (bits.length === 2 && !raw.includes(":")) return { owner: bits[0]!, name: bits[1]! };

  return undefined;
}

/**
 * Resolves the remote argument of `init`/`link`. Full URLs, scp-like SSH addresses, and local paths pass
 * through untouched; `owner/repo` shorthand expands to its GitHub URL. No remote is inferred without an argument.
 */
export function remoteFromArg(arg: string): string | undefined {
  const raw = arg.trim();
  if (!raw) return undefined;
  if (
    /^(https?|ssh|git):\/\//i.test(raw) ||
    /^[^\s/@]+@[^\s/]+:/.test(raw) ||
    raw.startsWith("/") ||
    raw.startsWith(".") ||
    raw.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(raw) ||
    path.isAbsolute(raw)
  ) {
    return raw;
  }
  const ref = parseRepoReference(raw);
  return ref ? `https://github.com/${ref.owner}/${ref.name}.git` : undefined;
}
