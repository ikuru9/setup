import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { convertPlugin } from "../src/converter.js";
import type { ActivationManifest } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/full-plugin/", import.meta.url));
const execFileAsync = promisify(execFile);
const TYPESCRIPT_CLI = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const WORKSPACE_NODE_MODULES = fileURLToPath(new URL("../node_modules/", import.meta.url));

async function snapshotTree(root: string): Promise<Array<[string, string, number]>> {
  const output: Array<[string, string, number]> = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort((a, b) => a.localeCompare(b, "en"))) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const info = await stat(absolute);
      if (info.isDirectory()) await visit(absolute);
      else output.push([relative, await readFile(absolute, "utf8"), info.mode & 0o777]);
    }
  }
  await visit(root);
  return output;
}

describe("converter", () => {
  it("converts the full fixture without executing it or retaining literal secrets", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-convert-"));
    const output = path.join(parent, "converted");

    const report = await convertPlugin({ source: FIXTURE, output });

    expect(report.pluginSlug).toBe("acme-review-tools");
    expect(report.target).toEqual({ node: ">=22.19.0", pi: "0.81.1" });
    expect(report.runtimeRequirements.map((runtime) => `${runtime.packageName}@${runtime.version}`))
      .toEqual([
        "@tintinweb/pi-subagents@0.14.2",
        "pi-mcp-adapter@2.11.0",
        "pi-web-access@0.13.0",
      ]);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.unsupportedFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ component: "hooks", status: "unsupported" })]),
    );
    expect(report.activationActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "install-package", target: ".pi/settings.json" }),
        expect.objectContaining({ kind: "merge-mcp", target: ".pi/mcp.json" }),
        expect.objectContaining({
          kind: "copy-file",
          target: ".pi/skills/acme-review-tools-audit",
        }),
      ]),
    );

    const activation = JSON.parse(
      await readFile(path.join(output, "activation-manifest.json"), "utf8"),
    ) as ActivationManifest;
    expect(activation.agents).toEqual([
      expect.objectContaining({
        target: ".pi/agents/acme-review-tools.review.security.md",
        kind: "agent",
      }),
    ]);
    expect(activation.runtimeFiles.every((file) =>
      file.target.startsWith(".pi/claude-pi-convert/acme-review-tools/runtime/"),
    )).toBe(true);
    expect(activation.skillFiles).toEqual([
      expect.objectContaining({
        source: "skills/acme-review-tools-audit",
        target: ".pi/skills/acme-review-tools-audit",
      }),
    ]);

    const agent = await readFile(
      path.join(output, "activation/agents/acme-review-tools.review.security.md"),
      "utf8",
    );
    expect(agent).toContain("tools: read,grep,find,ext:pi-mcp-adapter/mcp,ext:agent-guard/");
    expect(agent).toContain("extensions: agent-guard,main,pi-mcp-adapter");
    expect(agent).toContain("disallowed_tools: write,edit");
    expect(agent).not.toMatch(/^model:/m);
    expect(agent).toContain("thinking: high");
    expect(agent).toContain("skills: acme-review-tools-audit");

    const mainExtension = await readFile(path.join(output, "extensions/main.ts"), "utf8");
    expect(mainExtension).toContain('"matcher": "Bash"');
    expect(mainExtension).toContain('"server": "acme-review-tools-fixture"');
    expect(mainExtension).toContain('"tool": "scan"');

    const convertedSkill = await readFile(
      path.join(output, "skills", "acme-review-tools-audit", "SKILL.md"),
      "utf8",
    );
    expect(convertedSkill).toMatch(/^name: acme-review-tools-audit$/m);
    expect(convertedSkill).toMatch(/^disable-model-invocation: true$/m);

    const packageManifest = JSON.parse(await readFile(path.join(output, "package.json"), "utf8")) as {
      pi: { extensions: string[]; skills: string[]; themes: string[] };
    };
    expect(packageManifest.pi.extensions).toEqual([
      "./extensions/main.ts",
      "./extensions/agent-guard.ts",
    ]);
    expect(packageManifest.pi.skills).toEqual(["./skills"]);
    expect(packageManifest.pi.themes).toEqual(["./themes"]);
    expect(packageManifest).toMatchObject({
      peerDependencies: {
        "@earendil-works/pi-coding-agent": "*",
        "@earendil-works/pi-ai": "*",
        typebox: "*",
      },
      devDependencies: {
        "@earendil-works/pi-coding-agent": "0.81.1",
        "@earendil-works/pi-ai": "0.81.1",
        "@types/node": "24.10.1",
        typebox: "1.3.6",
        typescript: "5.9.3",
      },
      scripts: { typecheck: "tsc --noEmit" },
    });

    expect(JSON.parse(await readFile(path.join(output, "tsconfig.json"), "utf8"))).toMatchObject({
      compilerOptions: {
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
      },
      include: ["extensions/main.ts"],
    });
    const convertedTheme = JSON.parse(
      await readFile(path.join(output, "themes/acme-review-tools.dark.json"), "utf8"),
    ) as { name: string; colors: Record<string, unknown> };
    expect(convertedTheme.name).toBe("acme-review-tools.dark");
    expect(Object.keys(convertedTheme.colors).length).toBeGreaterThanOrEqual(51);
    expect(convertedTheme.colors).toMatchObject({
      accent: "#7aa2f7",
      error: "#f7768e",
      success: "#9ece6a",
    });
    expect(convertedTheme.colors).toHaveProperty("thinkingXhigh");
    expect(convertedTheme.colors).toHaveProperty("bashMode");

    const mcpText = JSON.stringify(activation.mcpConfig);
    expect(mcpText).toContain("acme-review-tools-fixture");
    expect(mcpText).toContain('"command":"node"');
    expect(mcpText).not.toContain("literal-secret-value");
    expect(await readFile(path.join(output, "activation/runtime/env.example"), "utf8"))
      .toMatch(/TOKEN|AUTHORIZATION/);

    const allOutput = JSON.stringify(await snapshotTree(output));
    expect(allOutput).not.toContain("literal-secret-value");
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "hooks", status: "unsupported" }),
      expect.objectContaining({ component: "hooks", status: "converted", source: "hooks/hooks.json" }),
      expect.objectContaining({ component: "lsp", status: "approximated" }),
      expect.objectContaining({ component: "monitors", status: "approximated" }),
    ]));
  });

  it("is byte-for-byte reproducible when replacing its own output", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-repeat-"));
    const output = path.join(parent, "converted");
    await convertPlugin({ source: FIXTURE, output });
    const first = await snapshotTree(output);
    await convertPlugin({ source: FIXTURE, output, force: true });
    expect(await snapshotTree(output)).toEqual(first);
  });

  it("refuses to overwrite an output it does not own", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-owner-"));
    const output = path.join(parent, "converted");
    await mkdir(output);
    await writeFile(path.join(output, "user.txt"), "mine");
    await expect(convertPlugin({ source: FIXTURE, output, force: true })).rejects.toThrow(/owned|marker/i);
  });

  it("refuses force replacement after owned output was edited or extended", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-owner-change-"));
    const modifiedOutput = path.join(parent, "modified");
    await convertPlugin({ source: FIXTURE, output: modifiedOutput });
    await writeFile(path.join(modifiedOutput, "extensions", "main.ts"), "// user edit\n");
    await expect(
      convertPlugin({ source: FIXTURE, output: modifiedOutput, force: true }),
    ).rejects.toThrow(/modified|ownership marker/i);

    const extendedOutput = path.join(parent, "extended");
    await convertPlugin({ source: FIXTURE, output: extendedOutput });
    await writeFile(path.join(extendedOutput, "notes.txt"), "user data\n");
    await expect(
      convertPlugin({ source: FIXTURE, output: extendedOutput, force: true }),
    ).rejects.toThrow(/unexpected|ownership marker/i);
  });

  it("plans a dry run without creating the output directory", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-dry-"));
    const output = path.join(parent, "converted");
    const report = await convertPlugin({ source: FIXTURE, output, dryRun: true });
    expect(report.output).toBe(output);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors replacement path rules, experimental components, and isolated agent extensions", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-custom-paths-"));
    const source = path.join(parent, "source");
    const output = path.join(parent, "output");
    const write = async (relative: string, content: string): Promise<void> => {
      const target = path.join(source, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    };
    await write(
      ".claude-plugin/plugin.json",
      `${JSON.stringify(
        {
          name: "custom-paths",
          commands: "./custom/commands/",
          agents: "./custom/agents/",
          skills: "./custom/skills/",
          outputStyles: "./custom/styles/",
          experimental: {
            themes: "./custom/themes/",
            monitors: [
              {
                name: "fast-monitor",
                description: "Clamped monitor",
                command: "node",
                args: ["-e", ""],
                intervalMs: 10,
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    await write("commands/default.md", "---\ndescription: ignored default\n---\nDEFAULT_COMMAND\n");
    await write("custom/commands/only.md", "---\ndescription: custom\n---\nCUSTOM_COMMAND\n");
    await write("agents/default.md", "---\ndescription: ignored default\ntools: Read\n---\nDefault\n");
    await write("custom/agents/builtin.md", "---\ndescription: builtins only\ntools: Read, Grep\n---\nBuiltin\n");
    await write("custom/agents/inherited.md", "---\ndescription: no tool override\n---\nInherited\n");
    await write("skills/default/SKILL.md", "---\nname: default\ndescription: default skill\n---\nDefault\n");
    await write("custom/skills/extra/SKILL.md", "---\nname: extra\ndescription: extra skill\n---\nExtra\n");
    await write("output-styles/default.md", "---\ndescription: ignored\n---\nDEFAULT_STYLE\n");
    await write(
      "custom/styles/only.md",
      "---\nname: concise\ndescription: custom\nkeep-coding-instructions: true\nforce-for-plugin: true\n---\nCUSTOM_STYLE\n",
    );
    await write("themes/default.json", JSON.stringify({ name: "ignored", base: "dark" }));
    await write(
      "custom/themes/light.json",
      JSON.stringify({
        name: "Custom Light",
        base: "light",
        overrides: { claude: "#123456", error: "#654321" },
      }),
    );
    await write(
      "custom/themes/invalid.json",
      JSON.stringify({ name: "Invalid", base: "solarized", overrides: { error: "#ffffff" } }),
    );
    await write(
      "monitors/monitors.json",
      JSON.stringify([{ name: "default-monitor", command: "node", args: ["-e", ""] }]),
    );

    const report = await convertPlugin({ source, output });
    const mainExtension = await readFile(path.join(output, "extensions/main.ts"), "utf8");
    expect(mainExtension).toContain("CUSTOM_COMMAND");
    expect(mainExtension).not.toContain("DEFAULT_COMMAND");
    expect(mainExtension).toContain("CUSTOM_STYLE");
    expect(mainExtension).not.toContain("DEFAULT_STYLE");
    expect(mainExtension).toContain('"name": "custom-paths.concise"');
    expect(mainExtension).toContain('"forceForPlugin": true');
    expect(mainExtension).toContain('"keepCodingInstructions": true');
    expect(mainExtension).toContain('"id": "fast-monitor"');
    expect(mainExtension).toContain('"intervalMs": 1000');
    expect(mainExtension).not.toContain("default-monitor");

    const activation = JSON.parse(
      await readFile(path.join(output, "activation-manifest.json"), "utf8"),
    ) as ActivationManifest;
    expect(activation.agents.map((agent) => agent.target).sort()).toEqual([
      ".pi/agents/custom-paths.custom.agents.builtin.md",
      ".pi/agents/custom-paths.custom.agents.inherited.md",
    ]);
    const builtinAgent = await readFile(
      path.join(output, "activation/agents/custom-paths.custom.agents.builtin.md"),
      "utf8",
    );
    expect(builtinAgent).toContain("extensions: main");
    const inheritedAgent = await readFile(
      path.join(output, "activation/agents/custom-paths.custom.agents.inherited.md"),
      "utf8",
    );
    expect(inheritedAgent).not.toMatch(/^extensions:/m);

    expect((await readdir(path.join(output, "skills"))).sort()).toEqual([
      "custom-paths-custom-skills-extra",
      "custom-paths-default",
    ]);
    expect(await readdir(path.join(output, "themes"))).toEqual([
      "custom-paths.custom.themes.light.json",
    ]);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "themes", status: "unsupported" }),
      ]),
    );
  });

  it("keeps hidden custom command directory segments when flattening command names", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-hidden-commands-"));
    const source = path.join(parent, "source");
    const output = path.join(parent, "output");
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(source, ".claude", "commands"), { recursive: true });
    await writeFile(
      path.join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "Agent Skills", commands: "./.claude/commands" })}\n`,
    );
    await writeFile(path.join(source, ".claude", "commands", "build.md"), "Build the project.\n");
    await writeFile(
      path.join(source, ".claude", "commands", "code-simplify.md"),
      "Simplify the selected code.\n",
    );

    await convertPlugin({ source, output });
    const extension = await readFile(path.join(output, "extensions/main.ts"), "utf8");
    expect(extension).toContain('"name": "build"');
    expect(extension).toContain('"name": "code-simplify"');

    const prefixedOutput = path.join(parent, "prefixed-output");
    await convertPlugin({ source, output: prefixedOutput, commandPrefix: true });
    const prefixedExtension = await readFile(path.join(prefixedOutput, "extensions/main.ts"), "utf8");
    expect(prefixedExtension).toContain('"name": "agent-skills.build"');
    expect(prefixedExtension).toContain('"name": "agent-skills.code-simplify"');
    // A consumer gets these from npm; link them here to typecheck the emitted
    // standalone extension without reaching the network.
    await symlink(WORKSPACE_NODE_MODULES, path.join(prefixedOutput, "node_modules"), "dir");
    await expect(execFileAsync(process.execPath, [TYPESCRIPT_CLI, "--project", path.join(prefixedOutput, "tsconfig.json")]))
      .resolves.toMatchObject({ stderr: "" });
  });

  it("accepts deprecated top-level theme and monitor paths while auditing manifest fields", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-top-level-"));
    const source = path.join(parent, "source");
    const output = path.join(parent, "output");
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(source, "custom"), { recursive: true });
    await writeFile(
      path.join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "top-level",
        defaultEnabled: false,
        themes: "./custom/theme.json",
        monitors: [{ name: "watch", command: "node", args: ["-e", ""] }],
        futureField: { retained: true },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(source, "custom", "theme.json"),
      `${JSON.stringify({ name: "Top", base: "dark", overrides: { accent: "#abcdef" } })}\n`,
    );

    const report = await convertPlugin({ source, output });
    expect(await readdir(path.join(output, "themes"))).toEqual(["top-level.custom.theme.json"]);
    const extension = await readFile(path.join(output, "extensions", "main.ts"), "utf8");
    expect(extension).toContain('"id": "watch"');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "themes", status: "approximated" }),
      expect.objectContaining({ component: "monitors", status: "approximated" }),
      expect.objectContaining({ component: "manifest", message: expect.stringContaining("futureField") }),
      expect.objectContaining({ component: "manifest", message: expect.stringContaining("defaultEnabled:false") }),
    ]));
    const packageManifest = JSON.parse(
      await readFile(path.join(output, "package.json"), "utf8"),
    ) as { claudePiConvert: { sourceDefaultEnabled: boolean } };
    expect(packageManifest.claudePiConvert.sourceDefaultEnabled).toBe(false);
  });
});
