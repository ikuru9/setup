import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  agentPolicySentinel,
  renderAgentGuardExtension,
  renderMainExtension,
  renderMcpLauncher,
  type RuntimeTemplateSpec,
} from "../src/runtime-templates.js";

async function importGeneratedExtensionAt(source: string, target: string): Promise<(pi: unknown) => void> {
  const withTypeStub = source.replace(
    'import { Type } from "typebox";',
    "const Type = { Object: (value) => value, Optional: (value) => value, String: (value) => value, Integer: (value) => value, Boolean: (value) => value };",
  );
  const compiled = await transform(withTypeStub, { loader: "ts", format: "esm", target: "node20" });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, compiled.code);
  const imported = await import(`${pathToFileURL(target).href}?test=${Date.now()}-${Math.random()}`) as {
    default: (pi: unknown) => void;
  };
  return imported.default;
}

async function importGeneratedExtension(source: string): Promise<(pi: unknown) => void> {
  const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-template-"));
  const target = path.join(parent, "extension.mjs");
  const register = await importGeneratedExtensionAt(source, target);
  await rm(parent, { recursive: true, force: true });
  return register;
}

async function readJsonWhenReady(filePath: string): Promise<Record<string, string>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("runtime templates", () => {
  it("renders namespaced LSP tools and approximate hook event bridges with valid syntax", async () => {
    const approximateEvents = [
      "PostToolBatch",
      "PermissionRequest",
      "PermissionDenied",
      "Notification",
      "MessageDisplay",
      "InstructionsLoaded",
      "CwdChanged",
      "FileChanged",
      "WorktreeCreate",
      "WorktreeRemove",
    ];
    const spec: RuntimeTemplateSpec = {
      pluginId: "fixture@example",
      pluginSlug: "fixture-tools",
      outputStyles: [{ name: "brief", prompt: "Be brief." }],
      hooks: approximateEvents.map((event) => ({
        event,
        handlers: [
          { type: "command", command: "true" },
          { type: "agent", prompt: "Audit this event." },
        ],
      })),
      lspServers: [{ name: "ts", command: "typescript-language-server", extensions: [".ts"] }],
      monitors: [
        { id: "logs", command: "tail -F app.log", persistent: true, when: "always" },
        { id: "skill", command: "echo ready", persistent: true, when: "on-skill-invoke:audit" },
      ],
    };

    const main = renderMainExtension(spec);
    const guard = renderAgentGuardExtension(spec);
    const launcher = renderMcpLauncher({ ...spec, runtimeDirFromLauncher: "./original/" });
    await expect(transform(main, { loader: "ts", format: "esm", target: "node20" })).resolves.toBeTruthy();
    await expect(transform(guard, { loader: "ts", format: "esm", target: "node20" })).resolves.toBeTruthy();
    await expect(transform(launcher, { loader: "js", format: "esm", target: "node20" })).resolves.toBeTruthy();

    expect(main).toContain('pi.registerCommand(PLUGIN_SLUG + ".output-style"');
    expect(main).toContain('name: TOOL_NAMESPACE + "_lsp_symbols"');
    expect(main).toContain('pi.on("turn_end"');
    expect(main).toContain('pi.on("message_end"');
    expect(main).toContain('watch(ctx.cwd, { recursive: true }');
    expect(main).toContain('subagentEvents.on("subagents:started"');
    expect(main).toContain('pi.sendMessage({');
    expect(main).toContain('activation.startsWith("on-skill-invoke:")');
    expect(main).toContain('new URL("../activation/runtime/data/", import.meta.url)');
    expect(main).toContain("const env = childEnvironment(server.env, { cwd });");
    expect(main).toContain('process.platform === "win32"');
    expect(main).toContain('"$env:Path = " + powershellSingleQuote(prefix) + " + $env:Path"');
    expect(main).toContain("if (existsSync(PACKAGE_ORIGINAL_PLUGIN_ROOT)) return PACKAGE_ORIGINAL_PLUGIN_ROOT;");
    expect(main).toContain('"command": "true"');
    expect(main).not.toContain("Audit this event.");

    expect(guard).toContain('pi.on("turn_end"');
    expect(guard).toContain('pi.on("message_end"');
    expect(guard).toContain('runConvertedHooks(pi, "WorktreeCreate"');
    expect(guard).toContain('runConvertedHooks(pi, "WorktreeRemove"');
    expect(guard).toContain('new URL("../activation/runtime/data/", import.meta.url)');
    expect(guard).toContain("if (existsSync(PACKAGE_ORIGINAL_PLUGIN_ROOT)) return PACKAGE_ORIGINAL_PLUGIN_ROOT;");
    expect(guard).toContain("Audit this event.");
    expect(guard).not.toContain('"command": "true"');

    expect(launcher).toContain('new URL("./original/", import.meta.url)');
    expect(launcher).toContain('new URL("./data/", import.meta.url)');
  });

  it("does not apply a single agent sentinel policy to the parent session", async () => {
    const agentName = "fixture-tools.review";
    const spec: RuntimeTemplateSpec = {
      pluginId: "fixture@example",
      pluginSlug: "fixture-tools",
      agentPolicies: [{ name: agentName, mcpAllow: ["allowed/read"] }],
    };
    const register = await importGeneratedExtension(renderAgentGuardExtension(spec));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getActiveTools: () => [`ext:agent-guard/${agentPolicySentinel(agentName)}`],
    };
    register(pi);
    const toolCall = handlers.get("tool_call")?.[0];
    expect(toolCall).toBeTypeOf("function");

    const context = (sessionName: string) => ({
      cwd: process.cwd(),
      hasUI: false,
      signal: undefined,
      sessionManager: {
        getSessionName: () => sessionName,
        getSessionId: () => "session",
      },
    });
    const event = { toolName: "mcp", input: { tool: "blocked_write" }, toolCallId: "call-1" };
    await expect(toolCall?.(event, context("parent"))).resolves.toBeUndefined();
    await expect(toolCall?.(event, context(`${agentName}#abc123`))).resolves.toMatchObject({ block: true });
  });

  it("passes active plugin paths and a plugin-bin-prefixed PATH to agent-guard hook children", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-guard-env-"));
    const project = path.join(parent, "project");
    const pluginId = "guard-env@example";
    const runtimeRoot = path.join(project, ".pi", "claude-pi-convert", pluginId, "runtime");
    const originalRoot = path.join(runtimeRoot, "original");
    const dataRoot = path.join(runtimeRoot, "data");
    const outputFile = path.join(parent, "guard.json");
    await mkdir(path.join(originalRoot, "bin"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    const captureEnvironment = [
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.argv[1], JSON.stringify({",
      "root: process.env.CLAUDE_PLUGIN_ROOT,",
      "data: process.env.CLAUDE_PLUGIN_DATA,",
      "project: process.env.CLAUDE_PROJECT_DIR,",
      "path: process.env.PATH || process.env.Path,",
      "keep: process.env.KEEP,",
      "expanded: process.argv[2],",
      "}));",
    ].join("\n");
    const register = await importGeneratedExtension(renderAgentGuardExtension({
      pluginId,
      pluginSlug: "guard-env",
      hooks: [{
        event: "TaskCreated",
        handlers: [{
          type: "command",
          command: process.execPath,
          args: ["-e", captureEnvironment, outputFile, "${CLAUDE_PLUGIN_DATA}"],
          shell: false,
          env: { PATH: "guard-base", KEEP: "guard" },
        }],
      }],
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const eventHandlers = new Map<string, Array<(event: unknown) => unknown>>();
    const pi = {
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: {
        on(name: string, handler: (event: unknown) => unknown) {
          const list = eventHandlers.get(name) ?? [];
          list.push(handler);
          eventHandlers.set(name, list);
          return () => {};
        },
        emit() {},
      },
      getActiveTools: () => [],
      sendUserMessage() {},
    };
    const sessionId = "guard-env-session";
    const context = {
      cwd: project,
      hasUI: false,
      signal: undefined,
      getSystemPrompt: () => "",
      sessionManager: { getSessionId: () => sessionId, getSessionName: () => "parent" },
    };
    const rootSessionKey = Symbol.for(`claude-pi-convert:${pluginId}:root-session`);
    Reflect.set(globalThis, rootSessionKey, sessionId);
    register(pi);

    try {
      await handlers.get("session_start")?.[0]?.({ reason: "startup" }, context);
      eventHandlers.get("subagents:created")?.[0]?.({ data: { id: "child-1", type: "review" } });
      expect(await readJsonWhenReady(outputFile)).toEqual({
        root: originalRoot,
        data: dataRoot,
        project,
        path: [path.join(runtimeRoot, "bin"), path.join(originalRoot, "bin"), "guard-base"].join(path.delimiter),
        keep: "guard",
        expanded: dataRoot,
      });
    } finally {
      await handlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, context);
      Reflect.deleteProperty(globalThis, rootSessionKey);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("prefers package-local original assets for main and agent-guard hook children", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-package-original-"));
    const packageRoot = path.join(parent, "package");
    const packageOriginal = path.join(packageRoot, "original");
    const project = path.join(parent, "project");
    const pluginId = "package-original@example";
    const runtimeRoot = path.join(project, ".pi", "claude-pi-convert", pluginId, "runtime");
    const dataRoot = path.join(runtimeRoot, "data");
    const mainOutput = path.join(parent, "main.json");
    const guardOutput = path.join(parent, "guard.json");
    await mkdir(path.join(packageOriginal, "bin"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "original", "bin"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    const canonicalPackageOriginal = `${await realpath(packageOriginal)}${path.sep}`;
    const captureEnvironment = [
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.argv[1], JSON.stringify({",
      "root: process.env.CLAUDE_PLUGIN_ROOT,",
      "data: process.env.CLAUDE_PLUGIN_DATA,",
      "project: process.env.CLAUDE_PROJECT_DIR,",
      "path: process.env.PATH || process.env.Path,",
      "}));",
    ].join("\n");
    const spec: RuntimeTemplateSpec = {
      pluginId,
      pluginSlug: "package-original",
      hooks: [
        {
          event: "SessionStart",
          handlers: [{
            type: "command",
            command: process.execPath,
            args: ["-e", captureEnvironment, mainOutput],
            shell: false,
            env: { PATH: "main-base" },
          }],
        },
        {
          event: "TaskCreated",
          handlers: [{
            type: "command",
            command: process.execPath,
            args: ["-e", captureEnvironment, guardOutput],
            shell: false,
            env: { PATH: "guard-base" },
          }],
        },
      ],
    };
    const mainRegister = await importGeneratedExtensionAt(
      renderMainExtension(spec),
      path.join(packageRoot, "extensions", "main.mjs"),
    );
    const guardRegister = await importGeneratedExtensionAt(
      renderAgentGuardExtension(spec),
      path.join(packageRoot, "extensions", "guard.mjs"),
    );
    const mainHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const mainPi = {
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = mainHandlers.get(name) ?? [];
        list.push(handler);
        mainHandlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
    };
    const guardHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const guardEvents = new Map<string, Array<(event: unknown) => unknown>>();
    const guardPi = {
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = guardHandlers.get(name) ?? [];
        list.push(handler);
        guardHandlers.set(name, list);
      },
      events: {
        on(name: string, handler: (event: unknown) => unknown) {
          const list = guardEvents.get(name) ?? [];
          list.push(handler);
          guardEvents.set(name, list);
          return () => {};
        },
        emit() {},
      },
      getActiveTools: () => [],
      sendUserMessage() {},
    };
    const sessionId = "package-original-session";
    const context = {
      cwd: project,
      hasUI: false,
      signal: undefined,
      getSystemPrompt: () => "",
      sessionManager: { getSessionId: () => sessionId, getSessionName: () => "parent" },
    };
    const expected = (basePath: string) => ({
      root: canonicalPackageOriginal,
      data: dataRoot,
      project,
      path: [runtimeRoot + path.sep + "bin", path.join(canonicalPackageOriginal, "bin"), basePath].join(path.delimiter),
    });
    mainRegister(mainPi);
    guardRegister(guardPi);

    try {
      await mainHandlers.get("session_start")?.[0]?.({ reason: "startup" }, context);
      await guardHandlers.get("session_start")?.[0]?.({ reason: "startup" }, context);
      guardEvents.get("subagents:created")?.[0]?.({ data: { id: "child-1", type: "review" } });
      expect(await readJsonWhenReady(mainOutput)).toEqual(expected("main-base"));
      expect(await readJsonWhenReady(guardOutput)).toEqual(expected("guard-base"));
    } finally {
      await guardHandlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, context);
      await mainHandlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, context);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("keeps shell hook commands fixed when cwd contains shell metacharacters", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-hook-injection-"));
    const project = path.join(parent, "project;touch injected;#");
    await mkdir(project);
    let monitorNotified: (() => void) | undefined;
    const monitorNotification = new Promise<void>((resolve) => { monitorNotified = resolve; });
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "fixture@example",
      pluginSlug: "fixture-tools",
      hooks: [{
        event: "SessionStart",
        handlers: [{ type: "command", command: "printf '%s' $CLAUDE_PROJECT_DIR", shell: true }],
      }],
      monitors: [{
        id: "fixed-source",
        command: "printf '%s\\n' $CLAUDE_PROJECT_DIR",
        persistent: true,
        when: "always",
      }],
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
      sendMessage() { monitorNotified?.(); },
    };
    register(pi);
    const context = {
      cwd: project,
      hasUI: false,
      signal: undefined,
      getSystemPrompt: () => "",
      sessionManager: { getSessionId: () => "session" },
    };

    try {
      await handlers.get("session_start")?.[0]?.({ reason: "startup" }, context);
      await Promise.race([
        monitorNotification,
        new Promise((_, reject) => setTimeout(() => reject(new Error("monitor did not emit")), 2_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await handlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, context);
      await expect(stat(path.join(project, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("passes active plugin paths and a plugin-bin-prefixed PATH to hook, monitor, and LSP children", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-child-env-"));
    const project = path.join(parent, "project");
    const pluginId = "runtime-env@example";
    const runtimeRoot = path.join(project, ".pi", "claude-pi-convert", pluginId, "runtime");
    const originalRoot = path.join(runtimeRoot, "original");
    const dataRoot = path.join(runtimeRoot, "data");
    const hookFile = path.join(parent, "hook.json");
    const monitorFile = path.join(parent, "monitor.json");
    const lspFile = path.join(parent, "lsp.json");
    const sourceFile = path.join(project, "fixture.ts");
    await mkdir(path.join(originalRoot, "bin"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(sourceFile, "export const fixture = true;\n");

    const captureEnvironment = [
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.argv[1], JSON.stringify({",
      "root: process.env.CLAUDE_PLUGIN_ROOT,",
      "data: process.env.CLAUDE_PLUGIN_DATA,",
      "project: process.env.CLAUDE_PROJECT_DIR,",
      "path: process.env.PATH || process.env.Path,",
      "keep: process.env.KEEP,",
      "expanded: process.argv[2],",
      "}));",
    ].join("\n");
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId,
      pluginSlug: "runtime-env",
      hooks: [{
        event: "SessionStart",
        handlers: [{
          type: "command",
          command: process.execPath,
          args: ["-e", captureEnvironment, hookFile, "${CLAUDE_PLUGIN_DATA}"],
          shell: false,
          env: { PATH: "hook-base", KEEP: "hook" },
        }],
      }],
      monitors: [{
        id: "environment",
        command: process.execPath,
        args: ["-e", captureEnvironment, monitorFile, "${CLAUDE_PLUGIN_DATA}"],
        env: { PATH: "monitor-base", KEEP: "monitor" },
        persistent: true,
        when: "always",
      }],
      lspServers: [{
        name: "environment",
        command: process.execPath,
        args: ["-e", captureEnvironment, lspFile, "${CLAUDE_PLUGIN_DATA}"],
        env: { PATH: "lsp-base", KEEP: "lsp" },
        extensions: [".ts"],
      }],
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const tools = new Map<string, {
      execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: () => void, ctx: unknown) => unknown;
    }>();
    const pi = {
      registerCommand() {},
      registerTool(tool: { name: string; execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: () => void, ctx: unknown) => unknown }) {
        tools.set(tool.name, tool);
      },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
      sendMessage() {},
    };
    const context = {
      cwd: project,
      hasUI: false,
      signal: undefined,
      getSystemPrompt: () => "",
      sessionManager: { getSessionId: () => "runtime-env-session" },
    };
    const expected = (basePath: string, keep: string) => ({
      root: originalRoot,
      data: dataRoot,
      project,
      path: [path.join(runtimeRoot, "bin"), path.join(originalRoot, "bin"), basePath].join(path.delimiter),
      keep,
      expanded: dataRoot,
    });
    register(pi);

    try {
      await handlers.get("session_start")?.[0]?.({ reason: "startup" }, context);
      expect(await readJsonWhenReady(hookFile)).toEqual(expected("hook-base", "hook"));
      expect(await readJsonWhenReady(monitorFile)).toEqual(expected("monitor-base", "monitor"));

      await tools.get("runtime_env_lsp_hover")?.execute(
        "lsp-call",
        { path: sourceFile, line: 0, character: 0 },
        undefined,
        () => {},
        context,
      );
      expect(await readJsonWhenReady(lspFile)).toEqual(expected("lsp-base", "lsp"));
    } finally {
      await handlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, context);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("prefixes Bash tool calls with runtime bins once and keeps the change call-scoped", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-bash-path-"));
    const project = path.join(parent, "project with ' quote");
    const pluginId = "bash-path@example";
    const runtimeRoot = path.join(project, ".pi", "claude-pi-convert", pluginId, "runtime");
    const runtimeBin = path.join(runtimeRoot, "bin");
    const originalBin = path.join(runtimeRoot, "original", "bin");
    await mkdir(runtimeBin, { recursive: true });
    await mkdir(originalBin, { recursive: true });
    await writeFile(path.join(runtimeBin, "runtime-command"), "#!/bin/sh\nprintf 'runtime\\n'\n", { mode: 0o755 });
    await writeFile(path.join(originalBin, "runtime-command"), "#!/bin/sh\nprintf 'wrong\\n'\n", { mode: 0o755 });
    await writeFile(path.join(originalBin, "original-only"), "#!/bin/sh\nprintf 'original\\n'\n", { mode: 0o755 });
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId,
      pluginSlug: "bash-path",
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
    };
    const context = { cwd: project, hasUI: false, signal: undefined };
    const event = {
      toolName: "bash",
      toolCallId: "bash-1",
      input: { command: "runtime-command && original-only" },
    };
    register(pi);

    try {
      await handlers.get("tool_call")?.[0]?.(event, context);
      await handlers.get("tool_call")?.[0]?.(event, context);
      expect(event.input.command.match(/# claude-pi-convert:path:bash_path/g)).toHaveLength(1);
      expect(event.input.command.indexOf(`${pluginId}/runtime/bin`)).toBeLessThan(
        event.input.command.indexOf(`${pluginId}/runtime/original/bin`),
      );
      expect(event.input.command).toContain(process.platform === "win32" ? "$env:Path = " : "export PATH=");
      expect(process.env.PATH).not.toContain(runtimeBin);

      if (process.platform !== "win32") {
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn("/bin/bash", ["-c", event.input.command], {
            cwd: project,
            env: { ...process.env, PATH: "/usr/bin:/bin" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => { stdout += chunk; });
          child.stderr.on("data", (chunk: string) => { stderr += chunk; });
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        });
        expect(result).toEqual({ code: 0, stdout: "runtime\noriginal\n", stderr: "" });
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("uses extensionToLanguage for each LSP document extension", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-lsp-language-"));
    const project = path.join(parent, "project");
    const sourceFile = path.join(project, "component.vue");
    const languageFile = path.join(parent, "language.txt");
    await mkdir(project);
    await writeFile(sourceFile, "<template />\n");
    const fakeLsp = [
      'const fs = require("node:fs");',
      "const output = process.argv[1];",
      "let buffer = Buffer.alloc(0);",
      "const send = (message) => {",
      "  const body = JSON.stringify(message);",
      '  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);',
      "};",
      'process.stdin.on("data", (chunk) => {',
      "  buffer = Buffer.concat([buffer, chunk]);",
      "  while (true) {",
      '    const marker = buffer.indexOf("\\r\\n\\r\\n");',
      "    if (marker < 0) return;",
      '    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, marker).toString("ascii"));',
      "    if (!match) { buffer = buffer.subarray(marker + 4); continue; }",
      "    const length = Number(match[1]);",
      "    if (buffer.length < marker + 4 + length) return;",
      '    const message = JSON.parse(buffer.subarray(marker + 4, marker + 4 + length).toString("utf8"));',
      "    buffer = buffer.subarray(marker + 4 + length);",
      '    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });',
      '    else if (message.method === "textDocument/didOpen") fs.writeFileSync(output, message.params.textDocument.languageId);',
      '    else if (message.method === "textDocument/hover") send({ jsonrpc: "2.0", id: message.id, result: null });',
      '    else if (message.method === "shutdown") send({ jsonrpc: "2.0", id: message.id, result: null });',
      '    else if (message.method === "exit") process.exit(0);',
      "  }",
      "});",
    ].join("\n");
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "lsp-language@example",
      pluginSlug: "lsp-language",
      lspServers: [{
        name: "fixture",
        command: process.execPath,
        args: ["-e", fakeLsp, languageFile],
        languageId: "fallback",
        extensionToLanguage: { ".vue": "vue-special", ".ts": "typescript" },
      }],
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const tools = new Map<string, {
      execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: () => void, ctx: unknown) => unknown;
    }>();
    const pi = {
      registerCommand() {},
      registerTool(tool: { name: string; execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: () => void, ctx: unknown) => unknown }) {
        tools.set(tool.name, tool);
      },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
    };
    const context = { cwd: project, hasUI: false, signal: undefined };
    register(pi);

    try {
      await tools.get("lsp_language_lsp_hover")?.execute(
        "hover",
        { path: sourceFile, line: 0, character: 0 },
        undefined,
        () => {},
        context,
      );
      expect(await readFile(languageFile, "utf8")).toBe("vue-special");
    } finally {
      await handlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, context);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("evicts dead LSP clients so the next request starts a new child", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-lsp-restart-"));
    const project = path.join(parent, "project");
    const sourceFile = path.join(project, "fixture.ts");
    const startsFile = path.join(parent, "starts.txt");
    await mkdir(project);
    await writeFile(sourceFile, "export {};\n");
    const exitImmediately = [
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.argv[1], "x");',
    ].join("\n");
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "lsp-restart@example",
      pluginSlug: "lsp-restart",
      lspServers: [{
        name: "fixture",
        command: process.execPath,
        args: ["-e", exitImmediately, startsFile],
        extensions: [".ts"],
      }],
    }));
    const tools = new Map<string, {
      execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: () => void, ctx: unknown) => unknown;
    }>();
    const pi = {
      registerCommand() {},
      registerTool(tool: { name: string; execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: () => void, ctx: unknown) => unknown }) {
        tools.set(tool.name, tool);
      },
      on() {},
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
    };
    const context = { cwd: project, hasUI: false, signal: undefined };
    register(pi);

    try {
      const tool = tools.get("lsp_restart_lsp_hover");
      await tool?.execute("first", { path: sourceFile, line: 0, character: 0 }, undefined, () => {}, context);
      await tool?.execute("second", { path: sourceFile, line: 0, character: 0 }, undefined, () => {}, context);
      expect(await readFile(startsFile, "utf8")).toBe("xx");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("uses direct execution for monitor args and a fixed shell wrapper for raw monitor commands", async () => {
    let monitorNotified: (() => void) | undefined;
    const monitorNotification = new Promise<void>((resolve) => { monitorNotified = resolve; });
    const directRegister = await importGeneratedExtension(renderMainExtension({
      pluginId: "direct-monitor@example",
      pluginSlug: "direct-monitor",
      monitors: [{
        id: "direct",
        command: process.execPath,
        args: ["-e", 'process.stdout.write("direct\\n")'],
        persistent: true,
        when: "always",
      }],
    }));
    const directHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const directPi = {
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = directHandlers.get(name) ?? [];
        list.push(handler);
        directHandlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
      sendMessage(message: { content?: string }) {
        if (message.content?.includes("direct")) monitorNotified?.();
      },
    };
    const directContext = {
      cwd: process.cwd(),
      hasUI: false,
      signal: undefined,
      getSystemPrompt: () => "",
      sessionManager: { getSessionId: () => "direct-monitor-session" },
    };
    directRegister(directPi);
    await directHandlers.get("session_start")?.[0]?.({ reason: "startup" }, directContext);
    await Promise.race([
      monitorNotification,
      new Promise((_, reject) => setTimeout(() => reject(new Error("direct monitor did not emit")), 2_000)),
    ]);
    await directHandlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, directContext);

    let captureLegacyExec: ((value: { command: string; args: string[] }) => void) | undefined;
    const legacyExec = new Promise<{ command: string; args: string[] }>((resolve) => {
      captureLegacyExec = resolve;
    });
    const sourceCommand = "printf '%s\\n' $CLAUDE_PROJECT_DIR";
    const legacyRegister = await importGeneratedExtension(renderMainExtension({
      pluginId: "legacy-monitor@example",
      pluginSlug: "legacy-monitor",
      monitors: [{
        id: "legacy",
        command: sourceCommand,
        intervalMs: 60_000,
        when: "always",
      }],
    }));
    const legacyHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const legacyPi = {
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = legacyHandlers.get(name) ?? [];
        list.push(handler);
        legacyHandlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
      async exec(command: string, args: string[]) {
        captureLegacyExec?.({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const legacyContext = {
      cwd: process.cwd(),
      hasUI: false,
      signal: undefined,
      getSystemPrompt: () => "",
      sessionManager: { getSessionId: () => "legacy-monitor-session" },
    };
    legacyRegister(legacyPi);
    await legacyHandlers.get("session_start")?.[0]?.({ reason: "startup" }, legacyContext);
    const captured = await legacyExec;
    expect(captured.command).toBe(process.execPath);
    expect(captured.args.slice(0, 2)).toEqual(["-e", expect.any(String)]);
    expect(captured.args[2]).toBe(process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh");
    expect(JSON.parse(captured.args[3] ?? "[]")).toEqual(
      process.platform === "win32"
        ? ["/d", "/s", "/c", sourceCommand]
        : ["-lc", sourceCommand],
    );
    await legacyHandlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, legacyContext);
  });

  it("applies safe PostToolUse result fields and approximates wildcard permissions with UI", async () => {
    const hookOutput = JSON.stringify({
      hookSpecificOutput: {
        updatedOutput: { content: "changed", details: { source: "hook" }, isError: true },
      },
    });
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "fixture@example",
      pluginSlug: "fixture-tools",
      hooks: [
        {
          event: "PostToolUse",
          handlers: [{
            type: "command",
            command: process.execPath,
            args: ["-e", `process.stdout.write(${JSON.stringify(hookOutput)})`],
            shell: false,
          }],
        },
        {
          event: "PermissionRequest",
          matcher: "*",
          handlers: [{ type: "command", command: "true", shell: true }],
        },
      ],
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
    };
    let confirmations = 0;
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      signal: undefined,
      ui: {
        confirm: async () => { confirmations += 1; return false; },
        notify() {},
      },
      sessionManager: { getSessionId: () => "session" },
    };
    register(pi);

    await expect(handlers.get("tool_result")?.[0]?.({
      toolName: "read",
      toolCallId: "result-1",
      input: { path: "README.md" },
      content: [{ type: "text", text: "original" }],
      details: { source: "tool" },
      isError: false,
    }, context)).resolves.toEqual({
      content: [{ type: "text", text: "changed" }],
      details: { source: "hook" },
      isError: true,
    });
    await expect(handlers.get("tool_call")?.[0]?.({
      toolName: "read",
      toolCallId: "call-1",
      input: { path: "README.md" },
    }, context)).resolves.toMatchObject({ block: true });
    expect(confirmations).toBe(1);

    await expect(handlers.get("tool_call")?.[0]?.({
      toolName: "read",
      toolCallId: "call-2",
      input: { path: "README.md" },
    }, {
      ...context,
      hasUI: false,
      ui: undefined,
    })).resolves.toEqual({
      block: true,
      reason: "Denied: confirmation unavailable in non-interactive session",
    });
  });

  it("expands zero-based command arguments and appends otherwise-unreferenced arguments", async () => {
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "arguments@example",
      pluginSlug: "arguments",
      commands: [
        {
          name: "positionals",
          prompt: "zero=$0 indexed=$ARGUMENTS[0] second=$1 indexedSecond=$ARGUMENTS[1] default=${2:-fallback} slice=${@:1:1} all=$ARGUMENTS at=$@",
        },
        { name: "implicit", prompt: "Run the review." },
      ],
    }));
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
    const messages: string[] = [];
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, command);
      },
      registerTool() {},
      on() {},
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage(message: string) { messages.push(message); },
    };
    const context = { cwd: process.cwd(), hasUI: false, signal: undefined };
    register(pi);

    await commands.get("positionals")?.handler('first "second value"', context);
    await commands.get("implicit")?.handler("alpha beta", context);

    expect(messages).toEqual([
      'zero=first indexed=first second=second value indexedSecond=second value default=fallback slice=second value all=first "second value" at=first "second value"',
      "Run the review.\n\nARGUMENTS: alpha beta",
    ]);
  });

  it("resolves Claude command model aliases only when the available candidate is unique", async () => {
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "models@example",
      pluginSlug: "models",
      commands: [
        { name: "sonnet", prompt: "Use Sonnet.", model: "sonnet" },
        { name: "opus", prompt: "Use Opus.", model: "opus" },
        { name: "haiku", prompt: "Use Haiku.", model: "haiku" },
      ],
    }));
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
    const selected: Array<{ provider: string; id: string }> = [];
    const available = [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "gateway-opus", id: "latest", name: "Gateway Latest" },
      { provider: "anthropic", id: "claude-haiku-3", name: "Claude Haiku 3" },
      { provider: "anthropic", id: "claude-haiku-4", name: "Claude Haiku 4" },
    ];
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, command);
      },
      registerTool() {},
      on() {},
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
      async setModel(model: { provider: string; id: string }) {
        selected.push(model);
        return true;
      },
    };
    const context = {
      cwd: process.cwd(),
      hasUI: false,
      signal: undefined,
      model: { provider: "initial", id: "initial" },
      modelRegistry: {
        find: () => undefined,
        getAvailable: () => available,
      },
    };
    register(pi);

    await commands.get("sonnet")?.handler("", context);
    await commands.get("opus")?.handler("", context);
    await commands.get("haiku")?.handler("", context);

    expect(selected).toEqual([available[0], available[1]]);
  });

  it("activates the first force-for-plugin output style as each session default", async () => {
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "styles@example",
      pluginSlug: "styles",
      outputStyles: [
        { name: "manual", prompt: "Manual only." },
        { name: "forced", prompt: "Force it.", forceForPlugin: true, keepCodingInstructions: false },
        { name: "later", prompt: "Do not select.", forceForPlugin: true },
      ],
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, command);
      },
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      sendUserMessage() {},
    };
    const context = {
      cwd: process.cwd(),
      hasUI: false,
      signal: undefined,
      sessionManager: { getSessionId: () => "style-session" },
    };
    register(pi);

    await handlers.get("session_start")?.[0]?.({ reason: "startup" }, context);
    await expect(handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "Base" }, context)).resolves.toEqual({
      systemPrompt: "Base\n\nOutput style forced:\nForce it.",
    });
    await commands.get("styles.output-style")?.handler("off", context);
    await expect(handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "Base" }, context)).resolves.toBeUndefined();
    await handlers.get("session_start")?.[0]?.({ reason: "switch" }, context);
    await expect(handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "Base" }, context)).resolves.toEqual({
      systemPrompt: "Base\n\nOutput style forced:\nForce it.",
    });
    await handlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, context);
  });

  it("honors explicit empty tool lists and enforces command-scoped MCP tools", async () => {
    const register = await importGeneratedExtension(renderMainExtension({
      pluginId: "fixture@example",
      pluginSlug: "fixture-tools",
      commands: [{
        name: "restricted",
        prompt: "Run safely",
        allowedTools: [],
        mcpAllow: ["allowed/read"],
      }],
    }));
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
    const activeToolUpdates: string[][] = [];
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, command);
      },
      registerTool() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: { on: () => () => {}, emit() {} },
      getAllTools: () => [{ name: "read" }, { name: "mcp" }],
      getActiveTools: () => ["read", "mcp"],
      setActiveTools(tools: string[]) { activeToolUpdates.push(tools); },
      sendUserMessage() {},
    };
    const context = {
      cwd: process.cwd(),
      hasUI: false,
      signal: undefined,
      sessionManager: { getSessionId: () => "session" },
    };
    register(pi);
    await commands.get("restricted")?.handler("", context);
    expect(activeToolUpdates).toEqual([[]]);

    await expect(handlers.get("tool_call")?.[0]?.({
      toolName: "mcp",
      toolCallId: "blocked",
      input: { tool: "other_write" },
    }, context)).resolves.toMatchObject({ block: true });
    await expect(handlers.get("tool_call")?.[0]?.({
      toolName: "mcp",
      toolCallId: "allowed",
      input: { tool: "allowed_read" },
    }, context)).resolves.toBeUndefined();
  });

  it("passes import-relative plugin paths and a plugin-bin-prefixed PATH to MCP children", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-launcher-env-"));
    const runtimeRoot = path.join(parent, "activation", "runtime");
    const originalRoot = path.join(runtimeRoot, "original");
    const dataRoot = path.join(runtimeRoot, "data");
    const project = path.join(parent, "project");
    const target = path.join(runtimeRoot, "mcp-launcher.mjs");
    await mkdir(path.join(originalRoot, "bin"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await mkdir(project);
    const canonicalRuntimeRoot = await realpath(runtimeRoot);
    const canonicalProject = await realpath(project);
    const captureEnvironment = [
      "process.stdout.write(JSON.stringify({",
      "root: process.env.CLAUDE_PLUGIN_ROOT,",
      "data: process.env.CLAUDE_PLUGIN_DATA,",
      "project: process.env.CLAUDE_PROJECT_DIR,",
      "path: process.env.PATH || process.env.Path,",
      "keep: process.env.KEEP,",
      "expanded: process.argv[1],",
      "}));",
    ].join("\n");
    await writeFile(target, renderMcpLauncher({
      pluginId: "launcher-env@example",
      pluginSlug: "launcher-env",
      runtimeDirFromLauncher: "./original/",
      mcpServers: [{
        name: "fixture",
        command: process.execPath,
        args: ["-e", captureEnvironment, "${CLAUDE_PLUGIN_DATA}"],
        env: { PATH: "launcher-base", KEEP: "launcher" },
      }],
    }));

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [target, "fixture"], {
          cwd: project,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        root: `${path.join(canonicalRuntimeRoot, "original")}${path.sep}`,
        data: `${path.join(canonicalRuntimeRoot, "data")}${path.sep}`,
        project: canonicalProject,
        path: [
          path.join(canonicalRuntimeRoot, "bin"),
          path.join(canonicalRuntimeRoot, "original", "bin"),
          "launcher-base",
        ].join(path.delimiter),
        keep: "launcher",
        expanded: `${path.join(canonicalRuntimeRoot, "data")}${path.sep}`,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("ends MCP launcher stdout and exits after its child closes", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-launcher-"));
    const target = path.join(parent, "launcher.mjs");
    const source = renderMcpLauncher({
      pluginId: "fixture@example",
      pluginSlug: "fixture-tools",
      mcpServers: [{
        name: "fixture",
        command: process.execPath,
        args: ["-e", 'process.stdout.write("ready")'],
      }],
    });
    await writeFile(target, source);

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [target, "fixture"], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`launcher timed out; stderr: ${stderr}`));
        }, 3_000);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
      expect(result).toMatchObject({ code: 0, stdout: "ready", stderr: "" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
