import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { activatePackage, deactivatePackage, doctorPackage } from "../src/activation.js";
import { convertPlugin } from "../src/converter.js";

const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv[2] === "--version") {
  process.stdout.write("0.81.1\\n");
  process.exit(0);
}
if (process.argv[2] !== "install") process.exit(2);

const source = process.argv[3];
const settingsPath = path.join(process.cwd(), ".pi", "settings.json");
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const settings = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  : {};
const normalized = source.startsWith("npm:")
  ? source
  : path.relative(path.dirname(settingsPath), source) || ".";
settings.packages = Array.isArray(settings.packages) ? settings.packages : [];
if (!settings.packages.includes(normalized)) settings.packages.push(normalized);
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\\n");
if (source.startsWith("npm:")) {
  const spec = source.slice(4);
  const versionAt = spec.lastIndexOf("@");
  const name = spec.slice(0, versionAt);
  const version = spec.slice(versionAt + 1);
  const packageDir = path.join(process.cwd(), ".pi", "npm", "node_modules", name);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(process.cwd(), ".pi", "npm", "sentinel.txt"), "mutated\\n");
}
if (process.env.FAKE_PI_FAIL === "1") process.exit(9);
`;

const FAKE_WEB_EXTENSION = `export default function (pi) {
  pi.registerTool({ name: "web_search" });
  pi.registerTool({ name: "fetch_content" });
}
`;

interface Fixture {
  root: string;
  convertedDir: string;
  project: string;
  runtimePath: string;
  receiptPath: string;
  settingsPath: string;
  mcpPath: string;
  skillPath: string;
  skillAssetPath: string;
}

describe("activation lifecycle", () => {
  let fixture: Fixture;
  let previousPath: string | undefined;
  let previousAgentDir: string | undefined;
  let previousFailure: string | undefined;

  beforeEach(async () => {
    previousPath = process.env.PATH;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousFailure = process.env.FAKE_PI_FAIL;
    fixture = await createFixture();
    process.env.PATH = `${join(fixture.root, "bin")}${delimiter}${previousPath ?? ""}`;
    process.env.PI_CODING_AGENT_DIR = join(fixture.root, "global-agent");
    delete process.env.FAKE_PI_FAIL;
  });

  afterEach(async () => {
    restoreEnvironment("PATH", previousPath);
    restoreEnvironment("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnvironment("FAKE_PI_FAIL", previousFailure);
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("activates, diagnoses, and deactivates a converted package", async () => {
    const activated = await activatePackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });

    expect(activated.ok).toBe(true);
    expect(await exists(fixture.runtimePath)).toBe(true);
    expect((await stat(fixture.runtimePath)).mode & 0o777).toBe(0o755);
    expect(await exists(fixture.receiptPath)).toBe(true);
    expect(await readFile(fixture.skillPath, "utf8")).toContain("Smoke skill");
    expect(await readFile(fixture.skillAssetPath, "utf8")).toBe("supporting asset\n");
    expect(await exists(join(fixture.project, ".pi", "extensions", "smoke", "index.ts"))).toBe(true);
    expect(await exists(join(fixture.project, ".pi", "extensions", "smoke", "package", "package.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(fixture.receiptPath)).mode & 0o777).toBe(0o600);
    }

    const doctor = await doctorPackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    expect(doctor.ok, JSON.stringify(doctor.checks, null, 2)).toBe(true);

    const deactivated = await deactivatePackage({
      convertedDirOrPluginId: "smoke",
      project: fixture.project,
    });
    expect(deactivated.ok).toBe(true);
    expect(await exists(fixture.runtimePath)).toBe(false);
    expect(await exists(fixture.receiptPath)).toBe(false);
    expect(await exists(fixture.settingsPath)).toBe(false);
    expect(await exists(fixture.skillPath)).toBe(false);
    expect(await exists(fixture.skillAssetPath)).toBe(false);
  });

  test("activates a converter-generated Pi-valid skill name", async () => {
    const source = join(fixture.root, "skill-source");
    const converted = join(fixture.root, "skill-converted");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await mkdir(join(source, "skills", "audit"), { recursive: true });
    await writeFile(
      join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "Integrated Skill" }, null, 2)}\n`,
    );
    await writeFile(
      join(source, "skills", "audit", "SKILL.md"),
      "---\nname: audit\ndescription: Integrated skill\n---\nRun the audit.\n",
    );
    await convertPlugin({ source, output: converted });

    await activatePackage({ convertedDir: converted, project: fixture.project });
    const activatedSkill = join(
      fixture.project,
      ".pi",
      "skills",
      "integrated-skill-audit",
      "SKILL.md",
    );
    expect(await readFile(activatedSkill, "utf8")).toContain("name: integrated-skill-audit");
    await deactivatePackage({ convertedDirOrPluginId: "integrated-skill", project: fixture.project });
    expect(await exists(activatedSkill)).toBe(false);
  });

  test("preserves a modified owned file until force is requested", async () => {
    await activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project });
    await writeFile(fixture.runtimePath, "user modification\n");

    const safe = await deactivatePackage({
      convertedDirOrPluginId: fixture.convertedDir,
      project: fixture.project,
    });
    expect(safe.ok).toBe(false);
    expect(safe.warnings.some((warning) => warning.includes("Preserved modified file"))).toBe(true);
    expect(await readFile(fixture.runtimePath, "utf8")).toBe("user modification\n");
    expect(await exists(fixture.receiptPath)).toBe(true);

    const forced = await deactivatePackage({
      convertedDirOrPluginId: "smoke",
      project: fixture.project,
      force: true,
    });
    expect(forced.ok).toBe(true);
    expect(await exists(fixture.runtimePath)).toBe(false);
    expect(await exists(fixture.receiptPath)).toBe(false);
  });

  test("rolls back copied files and settings when Pi package installation fails", async () => {
    const originalSettings = '{\n  "theme": "dark"\n}\n';
    await enableWebRuntime(fixture);
    await mkdir(join(fixture.project, ".pi"), { recursive: true });
    await writeFile(fixture.settingsPath, originalSettings);
    const npmSentinel = join(fixture.project, ".pi", "npm", "sentinel.txt");
    await mkdir(join(fixture.project, ".pi", "npm"), { recursive: true });
    await writeFile(npmSentinel, "original\n");
    process.env.FAKE_PI_FAIL = "1";

    await expect(
      activatePackage({
        convertedDir: fixture.convertedDir,
        project: fixture.project,
        installRuntimes: true,
      }),
    ).rejects.toThrow(/Activation failed/);

    expect(await readFile(fixture.settingsPath, "utf8")).toBe(originalSettings);
    expect(await readFile(npmSentinel, "utf8")).toBe("original\n");
    expect(
      await exists(
        join(fixture.project, ".pi", "npm", "node_modules", "pi-web-access", "package.json"),
      ),
    ).toBe(false);
    expect(await exists(fixture.runtimePath)).toBe(false);
    expect(await exists(fixture.receiptPath)).toBe(false);
  });

  test("preserves unrelated MCP and settings edits even during forced deactivation", async () => {
    await enableMcpRuntime(fixture);
    const initialMcp = {
      mcpServers: { existing: { url: "http://localhost:7777" } },
    };
    await mkdir(join(fixture.project, ".pi"), { recursive: true });
    await writeFile(fixture.mcpPath, `${JSON.stringify(initialMcp, null, 2)}\n`);
    await activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project });

    const activeMcp = JSON.parse(await readFile(fixture.mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    activeMcp.mcpServers["smoke-server"] = { command: "user-modified-command" };
    activeMcp.mcpServers["later-user-server"] = { url: "http://localhost:8888" };
    await writeFile(fixture.mcpPath, `${JSON.stringify(activeMcp, null, 2)}\n`);

    const activeSettings = JSON.parse(await readFile(fixture.settingsPath, "utf8")) as {
      packages: unknown[];
      theme?: string;
    };
    activeSettings.packages.push("npm:user-package@1.2.3");
    activeSettings.theme = "user-theme";
    await writeFile(fixture.settingsPath, `${JSON.stringify(activeSettings, null, 2)}\n`);

    const result = await deactivatePackage({
      convertedDirOrPluginId: "smoke",
      project: fixture.project,
      force: true,
    });
    expect(result.ok).toBe(true);

    const restoredMcp = JSON.parse(await readFile(fixture.mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(restoredMcp.mcpServers).toEqual({
      existing: { url: "http://localhost:7777" },
      "later-user-server": { url: "http://localhost:8888" },
    });
    const restoredSettings = JSON.parse(await readFile(fixture.settingsPath, "utf8")) as {
      packages: unknown[];
      theme: string;
    };
    expect(restoredSettings.theme).toBe("user-theme");
    expect(restoredSettings.packages).toEqual(["npm:user-package@1.2.3"]);
    expect(await exists(fixture.receiptPath)).toBe(false);
  });

  test("preserves restrictive MCP and settings modes through activation and restore", async () => {
    await enableMcpRuntime(fixture);
    await mkdir(join(fixture.project, ".pi"), { recursive: true });
    await writeFile(
      fixture.mcpPath,
      `${JSON.stringify({ mcpServers: { existing: { url: "http://localhost:7777" } } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      fixture.settingsPath,
      `${JSON.stringify({ theme: "dark" }, null, 2)}\n`,
      { mode: 0o600 },
    );

    await activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project });
    if (process.platform !== "win32") {
      expect((await stat(fixture.mcpPath)).mode & 0o777).toBe(0o600);
      expect((await stat(fixture.settingsPath)).mode & 0o777).toBe(0o600);
    }
    const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8")) as {
      mcp?: { beforeMode?: number };
    };
    expect(receipt.mcp?.beforeMode).toBe(0o600);

    await deactivatePackage({ convertedDirOrPluginId: "smoke", project: fixture.project });
    if (process.platform !== "win32") {
      expect((await stat(fixture.mcpPath)).mode & 0o777).toBe(0o600);
      expect((await stat(fixture.settingsPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("checks converted package dependencies before writing project state", async () => {
    const packageJsonPath = join(fixture.convertedDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    packageJson.dependencies = { kleur: "^4.1.0" };
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    await expect(
      activatePackage({
        convertedDir: fixture.convertedDir,
        project: fixture.project,
        installRuntimes: true,
      }),
    ).rejects.toThrow(/Converted package dependencies.*npm install --ignore-scripts/s);
    expect(await exists(fixture.settingsPath)).toBe(false);
    expect(await exists(fixture.runtimePath)).toBe(false);
    expect(await exists(fixture.receiptPath)).toBe(false);

    const missingDoctor = await doctorPackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    const missingCheck = missingDoctor.checks.find((check) => check.id === "dependency-kleur");
    expect(missingCheck?.status).toBe("error");
    expect(missingCheck?.message).toContain("missing");
    expect(missingCheck?.detail).toMatchObject({
      spec: "^4.1.0",
      installCommand: expect.stringContaining("npm install --ignore-scripts"),
    });

    const dependencyPackageJson = join(
      fixture.convertedDir,
      "node_modules",
      "kleur",
      "package.json",
    );
    await mkdir(join(dependencyPackageJson, ".."), { recursive: true });
    await writeFile(
      dependencyPackageJson,
      `${JSON.stringify({ name: "kleur", version: "3.0.0" })}\n`,
    );
    await expect(
      activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project }),
    ).rejects.toThrow(/installed 3\.0\.0, expected \^4\.1\.0/);
    expect(await exists(fixture.settingsPath)).toBe(false);

    await writeFile(
      dependencyPackageJson,
      `${JSON.stringify({ name: "kleur", version: "4.1.5" })}\n`,
    );
    const activated = await activatePackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    expect(activated.ok).toBe(true);
    await deactivatePackage({ convertedDirOrPluginId: "smoke", project: fixture.project });
  });

  test("refuses to replace a differently versioned project runtime", async () => {
    await enableWebRuntime(fixture);
    const originalSettings = {
      packages: ["npm:pi-web-access@0.12.0"],
    };
    await mkdir(join(fixture.project, ".pi"), { recursive: true });
    await writeFile(fixture.settingsPath, `${JSON.stringify(originalSettings, null, 2)}\n`);
    const runtimePackageJson = join(
      fixture.project,
      ".pi",
      "npm",
      "node_modules",
      "pi-web-access",
      "package.json",
    );
    await mkdir(join(runtimePackageJson, ".."), { recursive: true });
    await writeFile(
      runtimePackageJson,
      `${JSON.stringify({ name: "pi-web-access", version: "0.12.0" })}\n`,
    );

    await expect(
      activatePackage({
        convertedDir: fixture.convertedDir,
        project: fixture.project,
        installRuntimes: true,
      }),
    ).rejects.toThrow(/Refusing to replace an existing project runtime automatically/);

    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toEqual(originalSettings);
    expect(JSON.parse(await readFile(runtimePackageJson, "utf8"))).toMatchObject({
      version: "0.12.0",
    });
    expect(await exists(fixture.runtimePath)).toBe(false);
    expect(await exists(fixture.receiptPath)).toBe(false);

    const doctor = await doctorPackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    const conflict = doctor.checks.find(
      (check) => check.id === "runtime-pi-web-access-identity",
    );
    expect(conflict?.status).toBe("error");
    expect(conflict?.message).toContain("npm:pi-web-access@0.12.0");
  });

  test("doctor statically verifies pi-web-access public web tool registrations", async () => {
    await installWebRuntimeFixture(fixture);
    await activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project });

    const doctor = await doctorPackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    const webTools = doctor.checks.find((check) => check.id === "web-tools");
    expect(webTools).toMatchObject({
      status: "ok",
      detail: {
        packagePath: expect.stringContaining(
          join("project", ".pi", "npm", "node_modules", "pi-web-access"),
        ),
        entrypoint: "./index.ts",
        tools: ["web_search", "fetch_content"],
        scope: "project",
        verification: "static-package-manifest-and-public-entrypoint",
      },
    });
    expect(doctor.ok, JSON.stringify(doctor.checks, null, 2)).toBe(true);
  });

  test("doctor reports a missing pi-web-access public extension entrypoint", async () => {
    await installWebRuntimeFixture(fixture, { entrySource: null });
    await activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project });

    const doctor = await doctorPackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    const webTools = doctor.checks.find((check) => check.id === "web-tools");
    expect(webTools?.status).toBe("error");
    expect(webTools?.message).toMatch(/public extension entrypoint does not exist/);
    expect(doctor.ok).toBe(false);
  });

  test("doctor reports a damaged pi-web-access extension that no longer registers the tools", async () => {
    await installWebRuntimeFixture(fixture, {
      entrySource: "export default function () { throw new Error('damaged'); }\n",
    });
    await activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project });

    const doctor = await doctorPackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    const webTools = doctor.checks.find((check) => check.id === "web-tools");
    expect(webTools?.status).toBe("error");
    expect(webTools?.message).toMatch(/does not statically declare web_search, fetch_content/);
    expect(doctor.ok).toBe(false);
  });

  test.each([
    {
      component: "direct hook",
      inventory:
        'const HOOKS = [{"event":"SessionStart","handlers":[{"type":"command","command":"missing-hook-command","args":["--check"],"shell":false}]}];\n',
      expected: /hook SessionStart handler\[0\]/,
    },
    {
      component: "monitor",
      inventory:
        'const MONITORS = [{"id":"health","command":"missing-monitor-command","args":["--check"]}];\n',
      expected: /monitor health/,
    },
    {
      component: "LSP server",
      inventory:
        'const LSP_SERVERS = [{"name":"typescript","command":"missing-lsp-command","args":["--stdio"]}];\n',
      expected: /LSP server typescript/,
    },
  ])("rejects a missing $component executable before project writes", async ({ inventory, expected }) => {
    const extensionPath = join(fixture.convertedDir, "extensions", "main.ts");
    await mkdir(join(fixture.convertedDir, "extensions"), { recursive: true });
    await writeFile(extensionPath, inventory);
    const packageJsonPath = join(fixture.convertedDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      pi: { extensions: string[] };
    };
    packageJson.pi.extensions = ["./extensions/main.ts"];
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    await expect(
      activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project }),
    ).rejects.toThrow(expected);
    expect(await exists(fixture.settingsPath)).toBe(false);
    expect(await exists(fixture.runtimePath)).toBe(false);
    expect(await exists(fixture.receiptPath)).toBe(false);
  });

  test("finds a generated LSP executable in activated original/bin", async () => {
    const extensionPath = join(fixture.convertedDir, "extensions", "main.ts");
    await mkdir(join(fixture.convertedDir, "extensions"), { recursive: true });
    await writeFile(
      extensionPath,
      'const LSP_SERVERS = [{"name":"local","command":"fixture-local-lsp","args":["--stdio"]}];\n',
    );
    const packageJsonPath = join(fixture.convertedDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      pi: { extensions: string[] };
    };
    packageJson.pi.extensions = ["./extensions/main.ts"];
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    await expect(
      activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project }),
    ).rejects.toThrow(/fixture-local-lsp.*not found or is not executable/);

    const executablePath = join(fixture.convertedDir, "original", "bin", "fixture-local-lsp");
    await mkdir(join(fixture.convertedDir, "original", "bin"), { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);
    const manifestPath = join(fixture.convertedDir, "activation-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      runtimeFiles: Array<Record<string, unknown>>;
    };
    manifest.runtimeFiles.push({
      source: "original/bin/fixture-local-lsp",
      target: ".pi/claude-pi-convert/smoke/runtime/original/bin/fixture-local-lsp",
      kind: "runtime",
      mode: 0o755,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const activated = await activatePackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    expect(activated.ok).toBe(true);
    await deactivatePackage({ convertedDirOrPluginId: "smoke", project: fixture.project });
  });

  test("preflights the original command embedded in a generated MCP launcher", async () => {
    const source = join(fixture.root, "mcp-launcher-source");
    const converted = join(fixture.root, "mcp-launcher-converted");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "Launcher Check" }, null, 2)}\n`,
    );
    await writeFile(
      join(source, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            local: { command: "\${CLAUDE_PLUGIN_ROOT}/bin/missing-server" },
          },
        },
        null,
        2,
      )}\n`,
    );
    await convertPlugin({ source, output: converted });

    await expect(
      activatePackage({ convertedDir: converted, project: fixture.project }),
    ).rejects.toThrow(/MCP launcher original server launcher-check-local/);
    expect(await exists(fixture.settingsPath)).toBe(false);
    expect(await exists(fixture.receiptPath)).toBe(false);
  });

  test("rejects a non-executable package bin and warns for raw shell hooks", async () => {
    const binPath = join(fixture.convertedDir, "original", "bin", "smoke-cli");
    await mkdir(join(fixture.convertedDir, "original", "bin"), { recursive: true });
    await writeFile(binPath, "#!/bin/sh\nexit 0\n");
    await chmod(binPath, 0o644);
    const extensionPath = join(fixture.convertedDir, "extensions", "main.ts");
    await mkdir(join(fixture.convertedDir, "extensions"), { recursive: true });
    await writeFile(
      extensionPath,
      'const HOOKS = [{"event":"SessionStart","handlers":[{"type":"command","command":"runtime-only-command --flag","shell":true}]}];\n',
    );
    const packageJsonPath = join(fixture.convertedDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      bin?: Record<string, string>;
      pi: { extensions: string[] };
    };
    packageJson.bin = { "smoke-cli": "./original/bin/smoke-cli" };
    packageJson.pi.extensions = ["./extensions/main.ts"];
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    await expect(
      activatePackage({ convertedDir: fixture.convertedDir, project: fixture.project }),
    ).rejects.toThrow(/Converted package bin smoke-cli.*not executable/);
    expect(await exists(fixture.settingsPath)).toBe(false);

    await chmod(binPath, 0o755);
    const activated = await activatePackage({
      convertedDir: fixture.convertedDir,
      project: fixture.project,
    });
    expect(activated.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("raw shell command")]),
    );
    await deactivatePackage({ convertedDirOrPluginId: "smoke", project: fixture.project });
  });
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "claude-pi-activation-test-"));
  const convertedDir = join(root, "converted");
  const project = join(root, "project");
  const binDir = join(root, "bin");
  const runtimeSource = join(convertedDir, "activation", "runtime", "launcher.mjs");
  const runtimePath = join(
    project,
    ".pi",
    "claude-pi-convert",
    "smoke",
    "runtime",
    "launcher.mjs",
  );
  const receiptPath = join(
    project,
    ".pi",
    "claude-pi-convert",
    "smoke",
    "receipt.json",
  );
  const settingsPath = join(project, ".pi", "settings.json");
  const mcpPath = join(project, ".pi", "mcp.json");
  const skillPath = join(project, ".pi", "skills", "smoke-audit", "SKILL.md");
  const skillAssetPath = join(
    project,
    ".pi",
    "skills",
    "smoke-audit",
    "references",
    "checklist.txt",
  );

  await mkdir(join(convertedDir, "activation", "runtime"), { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(root, "global-agent"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(convertedDir, "package.json"),
    `${JSON.stringify({ name: "smoke-pi", version: "1.0.0", pi: { extensions: [] } }, null, 2)}\n`,
  );
  await writeFile(
    join(convertedDir, "activation-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pluginId: "smoke",
        pluginSlug: "smoke",
        packageRoot: ".",
        agents: [],
        skillFiles: [
          {
            source: "skills/smoke-audit",
            target: ".pi/skills/smoke-audit",
            kind: "other",
          },
        ],
        runtimeFiles: [
          {
            source: "activation/runtime/launcher.mjs",
            target: ".pi/claude-pi-convert/smoke/runtime/launcher.mjs",
            kind: "runtime",
            mode: 0o755,
          },
        ],
        runtimeRequirements: [],
        webAccessRequired: false,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(runtimeSource, '#!/usr/bin/env node\nprocess.stdout.write("smoke\\n");\n');
  await chmod(runtimeSource, 0o755);
  await mkdir(join(convertedDir, "skills", "smoke-audit", "references"), { recursive: true });
  await writeFile(
    join(convertedDir, "skills", "smoke-audit", "SKILL.md"),
    "---\nname: smoke-audit\ndescription: Smoke skill\n---\n\n# Smoke skill\n",
  );
  await writeFile(
    join(convertedDir, "skills", "smoke-audit", "references", "checklist.txt"),
    "supporting asset\n",
  );
  const piPath = join(binDir, "pi");
  await writeFile(piPath, FAKE_PI);
  await chmod(piPath, 0o755);

  return {
    root,
    convertedDir,
    project,
    runtimePath,
    receiptPath,
    settingsPath,
    mcpPath,
    skillPath,
    skillAssetPath,
  };
}

async function enableMcpRuntime(fixture: Fixture): Promise<void> {
  const manifestPath = join(fixture.convertedDir, "activation-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.mcpConfig = {
    mcpServers: {
      "smoke-server": { command: "node", args: ["-e", "process.stdin.resume()"] },
    },
  };
  manifest.runtimeRequirements = [
    {
      id: "pi-mcp-adapter",
      source: "https://github.com/nicobailon/pi-mcp-adapter",
      packageName: "pi-mcp-adapter",
      version: "2.11.0",
      reason: "MCP test runtime",
      required: true,
    },
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const adapterDir = join(
    fixture.root,
    "global-agent",
    "npm",
    "node_modules",
    "pi-mcp-adapter",
  );
  await mkdir(adapterDir, { recursive: true });
  await writeFile(
    join(fixture.root, "global-agent", "settings.json"),
    `${JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.11.0"] }, null, 2)}\n`,
  );
  await writeFile(
    join(adapterDir, "package.json"),
    `${JSON.stringify({ name: "pi-mcp-adapter", version: "2.11.0" }, null, 2)}\n`,
  );
}

async function enableWebRuntime(fixture: Fixture): Promise<void> {
  const manifestPath = join(fixture.convertedDir, "activation-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.webAccessRequired = true;
  manifest.runtimeRequirements = [
    {
      id: "pi-web-access",
      source: "https://github.com/nicobailon/pi-web-access",
      packageName: "pi-web-access",
      version: "0.13.0",
      reason: "Web rollback test runtime",
      required: true,
      resourceFilter: { skills: [] },
    },
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function installWebRuntimeFixture(
  fixture: Fixture,
  options: { entrySource?: string | null; extensions?: unknown[] } = {},
): Promise<void> {
  await enableWebRuntime(fixture);
  const packageDir = join(
    fixture.project,
    ".pi",
    "npm",
    "node_modules",
    "pi-web-access",
  );
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: "pi-web-access",
        version: "0.13.0",
        pi: { extensions: options.extensions ?? ["./index.ts"], skills: ["./skills"] },
      },
      null,
      2,
    )}\n`,
  );
  const entrySource = options.entrySource === undefined ? FAKE_WEB_EXTENSION : options.entrySource;
  if (entrySource !== null) await writeFile(join(packageDir, "index.ts"), entrySource);
  await mkdir(join(fixture.project, ".pi"), { recursive: true });
  await writeFile(
    fixture.settingsPath,
    `${JSON.stringify(
      {
        packages: [
          {
            source: "npm:pi-web-access@0.13.0",
            skills: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
