import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { convertPlugin } from "../src/converter.js";

const PI = process.platform === "win32" ? "pi.cmd" : "pi";
const PI_VERSION = spawnSync(PI, ["--version"], { encoding: "utf8" });
const HAS_TARGET_PI = PI_VERSION.status === 0 && /\b0\.81\.1\b/.test(
  `${PI_VERSION.stdout ?? ""}\n${PI_VERSION.stderr ?? ""}`,
);
const require = createRequire(import.meta.url);
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
const RUNTIME_PROBE = path.join(FIXTURE_DIR, "runtime-probe.ts");
const RUNTIME_MOCK_SUBAGENTS = path.join(FIXTURE_DIR, "runtime-mock-subagents.ts");
const RUNTIME_MOCK_MODEL = path.join(FIXTURE_DIR, "runtime-mock-model.ts");
const RUNTIME_FAKE_MCP = path.join(FIXTURE_DIR, "runtime-fake-mcp.mjs");
const RUNTIME_SPAWN_PROBE = path.join(FIXTURE_DIR, "runtime-spawn-probe.ts");
const RUNTIME_PACKAGES = {
  "@tintinweb/pi-subagents": "0.14.2",
  "pi-mcp-adapter": "2.11.0",
  "pi-web-access": "0.13.0",
} as const;

type JsonObject = Record<string, any>;

function packageRoot(packageName: string): string {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly records: JsonObject[] = [];
  stderr = "";
  private stdoutBuffer = "";
  private sequence = 0;
  private listeners = new Set<() => void>();

  constructor(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(PI, args, {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
  }

  async request(command: JsonObject, timeoutMs = 10_000): Promise<JsonObject> {
    const id = `runtime-${++this.sequence}`;
    const response = this.waitFor((record) => record.type === "response" && record.id === id, timeoutMs);
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return response;
  }

  async waitFor(predicate: (record: JsonObject) => boolean, timeoutMs = 10_000): Promise<JsonObject> {
    const existing = this.records.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const inspect = (): void => {
        const record = this.records.find(predicate);
        if (!record) return;
        clearTimeout(timer);
        this.listeners.delete(inspect);
        resolve(record);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(inspect);
        reject(new Error(`Pi RPC timed out. stderr: ${this.stderr}`));
      }, timeoutMs);
      this.listeners.add(inspect);
      this.child.once("error", (error) => {
        clearTimeout(timer);
        this.listeners.delete(inspect);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.records.push(JSON.parse(line) as JsonObject);
        for (const listener of [...this.listeners]) listener();
      } catch {
        // Pi diagnostics belong on stderr; retain malformed stdout in diagnostics.
        this.stderr += `[non-json stdout] ${line}\n`;
      }
    }
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("external runtime integration", () => {
  it("pins the exact tested runtime versions", async () => {
    for (const [packageName, expectedVersion] of Object.entries(RUNTIME_PACKAGES)) {
      const manifest = JSON.parse(await readFile(path.join(packageRoot(packageName), "package.json"), "utf8")) as {
        version?: string;
      };
      expect(manifest.version, packageName).toBe(expectedVersion);
    }
  });

  it.skipIf(!HAS_TARGET_PI)("loads all public package roots and registers their public tools", async () => {
    const parent = await temporaryDirectory("claude-pi-external-runtimes-");
    const piHome = path.join(parent, "pi-agent");
    await mkdir(piHome);
    const runtimeRoots = Object.keys(RUNTIME_PACKAGES).map(packageRoot);
    const args = ["--mode", "rpc", "--offline", "--no-session"];
    for (const root of runtimeRoots) args.push("-e", root);
    args.push("-e", RUNTIME_PROBE, "--approve");
    const rpc = new RpcProcess(args, parent, { PI_CODING_AGENT_DIR: piHome });

    try {
      const commandsResponse = await rpc.request({ type: "get_commands" });
      expect(commandsResponse.success).toBe(true);
      const commands = (commandsResponse.data?.commands ?? []).map((command: { name: string }) => command.name);
      expect(commands).toEqual(expect.arrayContaining([
        "agents",
        "mcp",
        "mcp-auth",
        "websearch",
        "runtime-probe",
      ]));

      const promptResponse = await rpc.request({ type: "prompt", message: "/runtime-probe" });
      expect(promptResponse.success).toBe(true);
      const messagesResponse = await rpc.request({ type: "get_messages" });
      const messages = messagesResponse.data?.messages ?? [];
      const probeMessage = messages.find((message: JsonObject) => message.customType === "runtime-probe");
      expect(probeMessage).toBeDefined();
      const probe = JSON.parse(probeMessage.content) as {
        subagents: { success?: boolean; data?: { version?: unknown } };
        tools: Array<{ name: string; sourceInfo?: { path?: string } }>;
      };
      expect(probe.subagents).toMatchObject({ success: true, data: { version: expect.anything() } });
      const tools = new Map(probe.tools.map((tool) => [tool.name, tool]));
      expect([...tools.keys()]).toEqual(expect.arrayContaining([
        "Agent",
        "get_subagent_result",
        "steer_subagent",
        "mcp",
        "web_search",
        "fetch_content",
        "get_search_content",
      ]));
      expect(tools.get("Agent")?.sourceInfo?.path).toContain(packageRoot("@tintinweb/pi-subagents"));
      expect(tools.get("mcp")?.sourceInfo?.path).toContain(packageRoot("pi-mcp-adapter"));
      expect(tools.get("web_search")?.sourceInfo?.path).toContain(packageRoot("pi-web-access"));
      expect(rpc.stderr).not.toMatch(/failed to load|syntaxerror|extension error/i);
    } finally {
      await rpc.stop();
    }
  }, 20_000);

  it.skipIf(!HAS_TARGET_PI)("spawns a real pi-subagents worker with a deterministic local mock model", async () => {
    const parent = await temporaryDirectory("claude-pi-real-subagent-");
    const piHome = path.join(parent, "pi-agent");
    await mkdir(piHome);
    const rpc = new RpcProcess([
      "--mode", "rpc", "--offline", "--no-session",
      "--provider", "runtime-smoke",
      "--model", "runtime-smoke-model",
      "-e", packageRoot("@tintinweb/pi-subagents"),
      "-e", RUNTIME_MOCK_MODEL,
      "-e", RUNTIME_SPAWN_PROBE,
      "--approve",
    ], parent, {
      PI_CODING_AGENT_DIR: piHome,
      RUNTIME_SMOKE_MODEL_MODE: "subagent",
    });
    try {
      const response = await rpc.request({ type: "prompt", message: "/runtime-spawn-probe" }, 15_000);
      expect(response.success).toBe(true);
      const messagesResponse = await rpc.request({ type: "get_messages" });
      const probeMessage = (messagesResponse.data?.messages ?? []).find(
        (message: JsonObject) => message.customType === "runtime-spawn-probe",
      );
      expect(probeMessage).toBeDefined();
      const probe = JSON.parse(probeMessage.content) as { reply: JsonObject; outcome: JsonObject };
      expect(probe.reply).toMatchObject({ success: true, data: { id: expect.any(String) } });
      expect(probe.outcome).toMatchObject({
        id: probe.reply.data?.id,
        result: expect.stringContaining("mock subagent complete"),
      });
      expect(rpc.stderr).not.toMatch(/spawn failed|completion timed out|failed to load|syntaxerror/i);
    } finally {
      await rpc.stop();
    }
  }, 25_000);

  it.skipIf(!HAS_TARGET_PI)("drives converted agent hooks through only the public subagent event RPC", async () => {
    const parent = await temporaryDirectory("claude-pi-subagent-rpc-");
    const source = path.join(parent, "source");
    const output = path.join(parent, "converted");
    const piHome = path.join(parent, "pi-agent");
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(source, "hooks"), { recursive: true });
    await mkdir(piHome);
    await writeFile(path.join(source, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "Runtime Agent Hooks",
      version: "1.0.0",
    }));
    await writeFile(path.join(source, "hooks", "hooks.json"), JSON.stringify({
      hooks: {
        SubagentStop: [{
          hooks: [{
            type: "agent",
            prompt: "Summarize the completed subagent result",
            timeout: 2,
          }],
        }],
      },
    }));
    await convertPlugin({ source, output });

    const rpc = new RpcProcess([
      "--mode", "rpc", "--offline", "--no-session",
      "-e", output,
      "-e", RUNTIME_MOCK_SUBAGENTS,
      "--approve",
    ], parent, { PI_CODING_AGENT_DIR: piHome });
    try {
      const commandResponse = await rpc.request({ type: "prompt", message: "/runtime-mock-subagent" });
      expect(commandResponse.success).toBe(true);
      const messagesResponse = await rpc.request({ type: "get_messages" });
      const probeMessage = (messagesResponse.data?.messages ?? []).find(
        (message: JsonObject) => message.customType === "runtime-mock-subagent",
      );
      expect(probeMessage).toBeDefined();
      const probe = JSON.parse(probeMessage.content) as { spawns: JsonObject[] };
      expect(probe.spawns).toHaveLength(1);
      expect(probe.spawns[0]).toMatchObject({
        type: "general-purpose",
        options: {
          run_in_background: true,
          description: expect.stringContaining("SubagentStop"),
        },
      });
      expect(probe.spawns[0]?.prompt).toContain("Summarize the completed subagent result");
      expect(probe.spawns[0]?.prompt).toContain('"hook_event_name": "SubagentStop"');
      expect(probe.spawns[0]?.prompt).toContain('"result": "source result"');
      expect(rpc.stderr).not.toMatch(/agent hook failed|rpc timed out|failed to load|syntaxerror/i);
    } finally {
      await rpc.stop();
    }
  }, 20_000);

  it.skipIf(!HAS_TARGET_PI)("calls a local MCP server and reverses its proxy tool name for Claude hook matching", async () => {
    const parent = await temporaryDirectory("claude-pi-mcp-runtime-");
    const source = path.join(parent, "source");
    const output = path.join(parent, "converted");
    const project = path.join(parent, "project");
    const piHome = path.join(parent, "pi-agent");
    const hookCapture = path.join(parent, "hook.json");
    const mcpCapture = path.join(parent, "mcp.jsonl");
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(source, "hooks"), { recursive: true });
    await mkdir(path.join(source, "scripts"), { recursive: true });
    await mkdir(path.join(project, ".pi"), { recursive: true });
    await mkdir(piHome);
    await writeFile(path.join(source, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "Runtime Hook Smoke",
      version: "1.0.0",
    }));
    await writeFile(path.join(source, ".mcp.json"), JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [RUNTIME_FAKE_MCP],
          lifecycle: "lazy",
        },
      },
    }));
    await writeFile(path.join(source, "hooks", "hooks.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "mcp__fixture__echo",
          hooks: [{
            type: "command",
            command: process.execPath,
            args: ["${CLAUDE_PLUGIN_ROOT}/scripts/capture-hook.mjs"],
            shell: false,
            timeout: 5,
          }],
        }],
      },
    }));
    await writeFile(path.join(source, "scripts", "capture-hook.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'let input = "";',
      'for await (const chunk of process.stdin) input += chunk;',
      'writeFileSync(process.env.RUNTIME_SMOKE_HOOK_CAPTURE, input);',
      'process.stdout.write("{}");',
    ].join("\n"));
    await convertPlugin({ source, output });
    const activation = JSON.parse(
      await readFile(path.join(output, "activation-manifest.json"), "utf8"),
    ) as { mcpConfig?: JsonObject };
    expect(activation.mcpConfig).toBeDefined();
    await writeFile(path.join(project, ".pi", "mcp.json"), `${JSON.stringify(activation.mcpConfig, null, 2)}\n`);

    const proxyToolName = "runtime_hook_smoke_fixture_echo";
    const rpc = new RpcProcess([
      "--mode", "rpc", "--offline", "--no-session",
      "--provider", "runtime-smoke",
      "--model", "runtime-smoke-model",
      "-e", output,
      "-e", packageRoot("pi-mcp-adapter"),
      "-e", RUNTIME_MOCK_MODEL,
      "--approve",
    ], project, {
      PI_CODING_AGENT_DIR: piHome,
      RUNTIME_SMOKE_MCP_TOOL: proxyToolName,
      RUNTIME_SMOKE_MCP_CAPTURE: mcpCapture,
      RUNTIME_SMOKE_HOOK_CAPTURE: hookCapture,
    });
    try {
      const promptResponse = await rpc.request({ type: "prompt", message: "Run the MCP runtime smoke test." });
      expect(promptResponse.success).toBe(true);
      await rpc.waitFor((record) => record.type === "agent_end", 15_000);

      const mcpCall = JSON.parse((await readFile(mcpCapture, "utf8")).trim()) as JsonObject;
      expect(mcpCall).toEqual({ name: "echo", arguments: { value: "hook-smoke" } });
      const hookInput = JSON.parse(await readFile(hookCapture, "utf8")) as JsonObject;
      expect(hookInput).toMatchObject({
        hook_event_name: "PreToolUse",
        tool_name: "mcp",
        tool_input: {
          tool: proxyToolName,
          args: JSON.stringify({ value: "hook-smoke" }),
        },
      });
      expect(rpc.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool_execution_end", toolName: "mcp", isError: false }),
      ]));
      expect(rpc.stderr).not.toMatch(/failed to load|syntaxerror|extension error|failed to connect/i);
    } finally {
      await rpc.stop();
    }
  }, 25_000);
});
