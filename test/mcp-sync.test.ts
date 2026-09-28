import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureAttributes, ensureFilter, mcpServersMissingLocalValues } from "../src/filter.js";
import { gitRaw } from "../src/git.js";
import { runInit, runLink, runSync } from "../src/sync.js";
import { createBareRemote, createMachineFixture, sh } from "./helpers.js";

interface McpDocument {
  mcpServers: Record<string, Record<string, unknown>>;
  disabledServers?: string[];
}

function mcpDocument(servers: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ mcpServers: servers, ...extra }, null, 2) + "\n";
}

async function readMcp(dir: string): Promise<McpDocument> {
  return JSON.parse(await fs.readFile(path.join(dir, "mcp.json"), "utf8")) as McpDocument;
}

async function writeMcp(dir: string, document: McpDocument): Promise<void> {
  await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify(document, null, 2) + "\n");
}

async function committedMcp(dir: string): Promise<McpDocument> {
  return JSON.parse((await gitRaw(["show", "main:mcp.json"], dir)).stdout.toString()) as McpDocument;
}

test("mcp.json syncs server definitions while every machine keeps its own command, args and env", async () => {
  const a = await createMachineFixture("mcp-a");
  const remote = await createBareRemote(a.root);

  await fs.writeFile(
    path.join(a.dir, "mcp.json"),
    mcpDocument(
      {
        "chrome-devtools": {
          type: "stdio",
          command: "cmd",
          args: ["/c", "npx", "-y", "chrome-devtools-mcp@latest"],
          env: { SystemRoot: "C:\\Windows" },
          timeout: 60000,
        },
        gh_grep: { type: "http", url: "https://mcp.grep.app" },
      },
      { disabledServers: ["node_repl"] }
    )
  );

  await runInit(remote, undefined, { dir: a.dir });

  // The committed copy carries the machine-neutral half of the server, plus the fully shared entries.
  const committed = await committedMcp(a.dir);
  assert.deepEqual(committed.mcpServers["chrome-devtools"], { type: "stdio", timeout: 60000 });
  assert.deepEqual(committed.mcpServers.gh_grep, { type: "http", url: "https://mcp.grep.app" });
  assert.deepEqual(committed.disabledServers, ["node_repl"]);

  // Machine A still runs its own Windows launcher.
  const localA = await readMcp(a.dir);
  assert.equal(localA.mcpServers["chrome-devtools"]?.command, "cmd");
  assert.deepEqual(localA.mcpServers["chrome-devtools"]?.args, ["/c", "npx", "-y", "chrome-devtools-mcp@latest"]);
  assert.deepEqual(localA.mcpServers["chrome-devtools"]?.env, { SystemRoot: "C:\\Windows" });

  // Machine B keeps its own macOS launcher for the same server while adopting the shared definition.
  const b = await createMachineFixture("mcp-b");
  await fs.writeFile(
    path.join(b.dir, "mcp.json"),
    mcpDocument({
      "chrome-devtools": {
        type: "stdio",
        command: "/opt/homebrew/bin/npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
      },
    })
  );

  await runLink(remote, undefined, { dir: b.dir });

  const localB = await readMcp(b.dir);
  assert.equal(localB.mcpServers["chrome-devtools"]?.command, "/opt/homebrew/bin/npx");
  assert.deepEqual(localB.mcpServers["chrome-devtools"]?.args, ["-y", "chrome-devtools-mcp@latest"]);
  assert.equal(localB.mcpServers["chrome-devtools"]?.timeout, 60000);
  assert.deepEqual(localB.mcpServers.gh_grep, { type: "http", url: "https://mcp.grep.app" });

  // A shared change made on B reaches A without dragging B's launcher along.
  localB.mcpServers["chrome-devtools"] = { ...localB.mcpServers["chrome-devtools"], timeout: 30000 };
  await writeMcp(b.dir, localB);
  await runSync(undefined, { auto: false, push: true }, { dir: b.dir });
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });

  const localA2 = await readMcp(a.dir);
  assert.equal(localA2.mcpServers["chrome-devtools"]?.timeout, 30000);
  assert.equal(localA2.mcpServers["chrome-devtools"]?.command, "cmd");
  assert.equal((await committedMcp(a.dir)).mcpServers["chrome-devtools"]?.command, undefined);
});

test("machineLocalMcpServers keeps a platform-only server out of the committed copy", async () => {
  const a = await createMachineFixture("mcp-local-server-a");
  await fs.writeFile(
    path.join(a.dir, "omp-sync.jsonc"),
    `${JSON.stringify({ machineLocalMcpServers: ["win-only"] }, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(a.dir, "mcp.json"),
    mcpDocument({
      "win-only": { type: "stdio", command: "win-tool.exe" },
      gh_grep: { type: "http", url: "https://mcp.grep.app" },
    })
  );
  const remote = await createBareRemote(a.root);
  await runInit(remote, undefined, { dir: a.dir });

  const committed = await committedMcp(a.dir);
  assert.equal(committed.mcpServers["win-only"], undefined);
  assert.equal(committed.mcpServers.gh_grep?.url, "https://mcp.grep.app");

  const localA = await readMcp(a.dir);
  assert.equal(localA.mcpServers["win-only"]?.command, "win-tool.exe");

  // A machine that never had the platform-only server does not inherit a stub for it.
  const b = await createMachineFixture("mcp-local-server-b");
  await runLink(remote, undefined, { dir: b.dir });
  const localB = await readMcp(b.dir);
  assert.equal(localB.mcpServers["win-only"], undefined);
  assert.equal(localB.mcpServers.gh_grep?.url, "https://mcp.grep.app");
});

test("servers whose launcher never synced are reported until this machine supplies its own", async () => {
  const a = await createMachineFixture("mcp-stub-a");
  const remote = await createBareRemote(a.root);
  await runInit(remote, undefined, { dir: a.dir });

  const b = await createMachineFixture("mcp-stub-b");
  await runLink(remote, undefined, { dir: b.dir });

  // Machine A adds a server whose launcher only exists on Windows.
  const localA = await readMcp(a.dir);
  localA.mcpServers.ctx7 = { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "ctx7@latest"] };
  await writeMcp(a.dir, localA);
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });

  const notices: string[] = [];
  await runSync(undefined, { auto: false, push: false }, { dir: b.dir, notify: (msg) => notices.push(msg) });

  const localB = await readMcp(b.dir);
  assert.deepEqual(localB.mcpServers.ctx7, { type: "stdio" });
  assert.ok(
    notices.some((msg) => msg.includes("ctx7") && msg.includes("command/args/env stay local")),
    `expected a warning naming ctx7, got: ${notices.join(" | ")}`
  );
  assert.deepEqual(await mcpServersMissingLocalValues(b.dir), ["ctx7"]);

  // B fills in its own launcher: nothing left to report.
  localB.mcpServers.ctx7 = { type: "stdio", command: "/opt/homebrew/bin/npx", args: ["-y", "ctx7@latest"] };
  await writeMcp(b.dir, localB);
  assert.deepEqual(await mcpServersMissingLocalValues(b.dir), []);
  await runSync(undefined, { auto: false, push: true }, { dir: b.dir });

  // A deliberately disabled server stays a stub without being reported.
  localB.mcpServers.ctx7 = { type: "stdio" };
  localB.disabledServers = ["ctx7"];
  await writeMcp(b.dir, localB);
  assert.deepEqual(await mcpServersMissingLocalValues(b.dir), []);
  await runSync(undefined, { auto: false, push: true }, { dir: b.dir });

  // The stub in the repository never overwrites the launcher each machine runs locally.
  await runSync(undefined, { auto: false, push: false }, { dir: a.dir });
  const localA2 = await readMcp(a.dir);
  assert.deepEqual(localA2.mcpServers.ctx7?.args, ["/c", "npx", "-y", "ctx7@latest"]);
  assert.deepEqual((await committedMcp(a.dir)).mcpServers.ctx7, { type: "stdio" });
});

test("re-enabling mcp.json sync keeps the local launcher while adopting the shared definition", async () => {
  // Machine A starts without mcp.json in sync (the pre-feature setup).
  const a = await createMachineFixture("mcp-reenable-a");
  await fs.rm(path.join(a.dir, "mcp.json"));
  await fs.writeFile(path.join(a.dir, "omp-sync.jsonc"), `${JSON.stringify({ excludePaths: ["mcp.json"] }, null, 2)}\n`);
  const remote = await createBareRemote(a.root);
  await runInit(remote, undefined, { dir: a.dir });

  // Machine B keeps mcp.json local the same way, with its own launcher.
  const b = await createMachineFixture("mcp-reenable-b");
  await fs.writeFile(path.join(b.dir, "omp-sync.jsonc"), `${JSON.stringify({ excludePaths: ["mcp.json"] }, null, 2)}\n`);
  await fs.writeFile(
    path.join(b.dir, "mcp.json"),
    mcpDocument({ "chrome-devtools": { type: "stdio", command: "/opt/homebrew/bin/npx", args: ["-y", "cdm@latest"] } })
  );
  await runLink(remote, undefined, { dir: b.dir });
  assert.equal((await readMcp(b.dir)).mcpServers["chrome-devtools"]?.command, "/opt/homebrew/bin/npx");

  // A enables mcp.json sync with its Windows launcher and pushes it.
  await fs.writeFile(path.join(a.dir, "omp-sync.jsonc"), `${JSON.stringify({}, null, 2)}\n`);
  await fs.writeFile(
    path.join(a.dir, "mcp.json"),
    mcpDocument({
      "chrome-devtools": { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "cdm@latest"], timeout: 60000 },
      gh_grep: { type: "http", url: "https://mcp.grep.app" },
    })
  );
  await runSync(undefined, { auto: false, push: true }, { dir: a.dir });
  assert.equal((await committedMcp(a.dir)).mcpServers["chrome-devtools"]?.command, undefined);

  // B receives the committed definition; its local launcher survives the checkout through the sidecar and
  // A's Windows launcher never lands on B.
  await runSync(undefined, { auto: false, push: false }, { dir: b.dir });

  const localB = await readMcp(b.dir);
  assert.equal(localB.mcpServers["chrome-devtools"]?.command, "/opt/homebrew/bin/npx");
  assert.deepEqual(localB.mcpServers["chrome-devtools"]?.args, ["-y", "cdm@latest"]);
  assert.equal(localB.mcpServers["chrome-devtools"]?.timeout, 60000);
  assert.deepEqual(localB.mcpServers.gh_grep, { type: "http", url: "https://mcp.grep.app" });
});

test("a stale mcp.json filter rule from an older release is retargeted and the committed copy re-cleaned", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-filter-migrate-"));
  await sh("git", ["init", "-b", "main"], root);
  await fs.writeFile(
    path.join(root, ".gitattributes"),
    "settings.json filter=omp-config-sync-json\nmcp.json filter=omp-config-sync-json\n"
  );
  await fs.writeFile(
    path.join(root, "mcp.json"),
    mcpDocument({ "chrome-devtools": { type: "stdio", command: "cmd", args: ["/c", "npx"] } })
  );
  await sh("git", ["add", "-A"], root);
  await sh("git", ["commit", "-m", "legacy mcp.json"], root);

  assert.equal(await ensureAttributes(root), true);
  const attributes = await fs.readFile(path.join(root, ".gitattributes"), "utf8");
  assert.match(attributes, /^mcp\.json filter=omp-config-sync-mcp$/m);
  assert.match(attributes, /^settings\.json filter=omp-config-sync-json$/m);
  assert.doesNotMatch(attributes, /mcp\.json filter=omp-config-sync-json/);
  assert.equal(await ensureAttributes(root), false);

  await ensureFilter(root);
  const blob = (await gitRaw(["show", ":mcp.json"], root)).stdout.toString();
  assert.match(blob, /"type": "stdio"/);
  assert.doesNotMatch(blob, /"command"|"args"/);
});
