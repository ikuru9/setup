import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertPlugin } from "../src/converter.js";
import type { ActivationManifest } from "../src/types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryPlugin(name: string): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(path.join(tmpdir(), `claude-pi-${name}-`));
  temporaryRoots.push(root);
  const source = path.join(root, "source");
  await mkdir(path.join(source, ".claude-plugin"), { recursive: true });
  await writeFile(
    path.join(source, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name }, null, 2)}\n`,
  );
  return { root, source };
}

async function allFileText(root: string): Promise<string> {
  const chunks: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) chunks.push(await readFile(target, "utf8"));
    }
  }
  await walk(root);
  return chunks.join("\n");
}

describe("converter security and portability", () => {
  it("copies static plugin assets referenced by a skill without importing another skill", async () => {
    const { root, source } = await temporaryPlugin("reference-assets");
    await mkdir(path.join(source, "skills", "main"), { recursive: true });
    await mkdir(path.join(source, "skills", "other"), { recursive: true });
    await mkdir(path.join(source, "references"), { recursive: true });
    await mkdir(path.join(source, "docs"), { recursive: true });
    await mkdir(path.join(source, "templates"), { recursive: true });
    await mkdir(path.join(source, "scripts"), { recursive: true });
    await writeFile(
      path.join(source, "skills", "main", "SKILL.md"),
      [
        "---\nname: main\ndescription: main\n---",
        "See `references/a.md`, [guide](docs/guide.md), `scripts/check.mjs`, and `../../templates/card.md`.",
        "Do not import `../other/SKILL.md`.",
      ].join("\n"),
    );
    await writeFile(path.join(source, "skills", "other", "SKILL.md"), "---\nname: other\n---\nOther\n");
    await writeFile(path.join(source, "references", "a.md"), "Accessibility\n");
    await writeFile(path.join(source, "docs", "guide.md"), "Guide\n");
    await writeFile(path.join(source, "templates", "card.md"), "Card\n");
    await writeFile(path.join(source, "scripts", "check.mjs"), "console.log('check');\n");

    const output = path.join(root, "output");
    const report = await convertPlugin({ source, output });
    const target = path.join(output, "skills", "reference-assets-main");
    await expect(readFile(path.join(target, "references", "a.md"), "utf8")).resolves.toBe("Accessibility\n");
    await expect(readFile(path.join(target, "docs", "guide.md"), "utf8")).resolves.toBe("Guide\n");
    await expect(readFile(path.join(target, "scripts", "check.mjs"), "utf8")).resolves.toBe("console.log('check');\n");
    await expect(readFile(path.join(target, "templates", "card.md"), "utf8")).resolves.toBe("Card\n");
    const skill = await readFile(path.join(target, "SKILL.md"), "utf8");
    expect(skill).toContain("references/a.md");
    expect(skill).toContain("docs/guide.md");
    expect(skill).toContain("scripts/check.mjs");
    expect(skill).toContain("templates/card.md");
    await expect(readFile(path.join(target, "other", "SKILL.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "skills", status: "preserved", message: expect.stringContaining("another skill") }),
    ]));
  });

  it("rejects custom component paths that escape the source", async () => {
    const { root, source } = await temporaryPlugin("traversal-fixture");
    await writeFile(
      path.join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "traversal-fixture", skills: "../outside" }, null, 2)}\n`,
    );

    await expect(
      convertPlugin({ source, output: path.join(root, "output") }),
    ).rejects.toThrow(/skills path escapes the plugin root/);
  });

  it("rejects case-insensitive source collisions when the filesystem permits creating them", async () => {
    const { root, source } = await temporaryPlugin("source-collision");
    const agents = path.join(source, "agents");
    await mkdir(agents);
    await writeFile(path.join(agents, "Alpha.md"), "---\ndescription: first\n---\nFirst\n");
    await writeFile(path.join(agents, "alpha.md"), "---\ndescription: second\n---\nSecond\n");
    const names = await readdir(agents);
    if (names.length < 2) return; // Default macOS volumes are commonly case-insensitive.

    await expect(
      convertPlugin({ source, output: path.join(root, "output") }),
    ).rejects.toThrow(/Case-insensitive source path collision/);
  });

  it("rejects distinct source names that flatten to the same generated agent name", async () => {
    const { root, source } = await temporaryPlugin("generated-collision");
    const agents = path.join(source, "agents");
    await mkdir(agents);
    await writeFile(path.join(agents, "one+two.md"), "---\ndescription: first\n---\nFirst\n");
    await writeFile(path.join(agents, "one two.md"), "---\ndescription: second\n---\nSecond\n");

    await expect(
      convertPlugin({ source, output: path.join(root, "output") }),
    ).rejects.toThrow(/Generated agent name collision/);
  });

  it("excludes VCS and installed dependency trees and scans extensionless text secrets", async () => {
    const { root, source } = await temporaryPlugin("excluded-trees");
    const hiddenSecret = "hidden-vcs-password";
    await mkdir(path.join(source, ".git"));
    await writeFile(
      path.join(source, ".git", "config"),
      `remote = https://user:${hiddenSecret}@example.invalid/repo.git\n`,
    );
    await mkdir(path.join(source, "node_modules", "fixture"), { recursive: true });
    await writeFile(path.join(source, "node_modules", "fixture", "index.js"), hiddenSecret);
    await writeFile(path.join(source, "Dockerfile"), `API_TOKEN=${hiddenSecret}\n`);

    const output = path.join(root, "output");
    const report = await convertPlugin({ source, output });
    const text = await allFileText(output);
    expect(text).not.toContain(hiddenSecret);
    await expect(readFile(path.join(output, "original", ".git", "config"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(output, "original", "node_modules", "fixture", "index.js"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "security", source: ".git" }),
      expect.objectContaining({ component: "security", source: "node_modules" }),
    ]));
  });

  it("redacts literal secrets by default and preserves them only when explicitly requested", async () => {
    const { root, source } = await temporaryPlugin("secret-fixture");
    const literalSecret = "literal-super-secret-value";
    const equalsSecret = "literal-equals-secret-value";
    const querySecret = "literal-query-secret-value";
    const userSecret = "literal-url-password";
    await writeFile(
      path.join(source, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            remote: {
              url: "https://example.invalid/mcp",
              headers: { Authorization: `Bearer ${literalSecret}` },
              env: { API_TOKEN: literalSecret, FROM_ENV: "\${FROM_ENV}" },
            },
            stdio: {
              command: "node",
              args: ["server.mjs", "--token", literalSecret, `--api-key=${equalsSecret}`],
            },
            credentialUrl: {
              url: `https://user:${userSecret}@example.invalid/mcp?api_key=${querySecret}`,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(source, "commands"));
    await writeFile(
      path.join(source, "commands", "secret.md"),
      `---\ndescription: secret scan\n---\nUse Bearer ${literalSecret}.\n`,
    );
    await mkdir(path.join(source, "agents"));
    await writeFile(
      path.join(source, "agents", "secret.md"),
      `---\ndescription: secret agent\ntools: Read\n---\nNever print sk-${literalSecret}.\n`,
    );
    await mkdir(path.join(source, "skills", "secret", "references"), { recursive: true });
    await writeFile(
      path.join(source, "skills", "secret", "SKILL.md"),
      `---\nname: secret\ndescription: secret skill\n---\nAPI_TOKEN=${literalSecret}\n`,
    );
    await writeFile(
      path.join(source, "skills", "secret", "references", "credentials.txt"),
      `Authorization=Bearer ${literalSecret}\n`,
    );
    await mkdir(path.join(source, "hooks"));
    await writeFile(
      path.join(source, "hooks", "hooks.json"),
      `${JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{
              type: "http",
              url: "https://example.invalid/hook",
              headers: { Authorization: `Bearer ${literalSecret}` },
            }],
          }],
        },
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(source, ".lsp.json"),
      `${JSON.stringify({
        fixture: {
          command: "node",
          extensionToLanguage: { ".ts": "typescript" },
          env: { API_TOKEN: literalSecret },
        },
      }, null, 2)}\n`,
    );
    await mkdir(path.join(source, "monitors"));
    await writeFile(
      path.join(source, "monitors", "status.json"),
      `${JSON.stringify({ name: "status", command: "node", args: ["-e", ""], env: { API_TOKEN: literalSecret } }, null, 2)}\n`,
    );

    const safeOutput = path.join(root, "safe-output");
    await convertPlugin({ source, output: safeOutput });
    const safeText = await allFileText(safeOutput);
    for (const secret of [literalSecret, equalsSecret, querySecret, userSecret]) {
      expect(safeText).not.toContain(secret);
    }
    expect(safeText).toContain("${SECRET_FIXTURE_REMOTE_HEADERS_AUTHORIZATION}");
    expect(safeText).toContain("${SECRET_FIXTURE_REMOTE_ENV_API_TOKEN}");
    expect(safeText).toMatch(/--api-key=\$\{SECRET_FIXTURE_STDIO_ARGS_3_API_KEY\}/);
    expect(safeText).toContain("${SECRET_FIXTURE_CREDENTIALURL_URL}");
    const safeReport = JSON.parse(
      await readFile(path.join(safeOutput, "conversion-report.json"), "utf8"),
    ) as { issues: Array<{ component: string; status: string }> };
    expect(safeReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "security", status: "approximated" }),
    ]));

    const unsafeOutput = path.join(root, "unsafe-output");
    await convertPlugin({ source, output: unsafeOutput, includeSecrets: true });
    const unsafeText = await allFileText(unsafeOutput);
    for (const secret of [literalSecret, equalsSecret, querySecret, userSecret]) {
      expect(unsafeText).toContain(secret);
    }
  });

  it("keeps an explicitly empty agent tool list empty", async () => {
    const { root, source } = await temporaryPlugin("empty-tools");
    await mkdir(path.join(source, "agents"));
    await writeFile(
      path.join(source, "agents", "isolated.md"),
      "---\nname: old-name\ndescription: no authority\ntools: []\n---\nDo nothing.\n",
    );

    const output = path.join(root, "output");
    await convertPlugin({ source, output });
    const agent = await readFile(
      path.join(output, "activation", "agents", "empty-tools.isolated.md"),
      "utf8",
    );
    expect(agent).toMatch(/^name: empty-tools\.isolated$/m);
    expect(agent).toMatch(/^tools: none$/m);
    expect(agent).toMatch(/^extensions: main$/m);
  });

  it("converts user config, package runtime metadata, root skills, and scoped MCP names safely", async () => {
    const { root, source } = await temporaryPlugin("metadata-fixture");
    const sensitiveDefault = "sensitive-user-config-default";
    const metadataSecret = "metadata-url-secret";
    const shapedSecret = "sk-metadata-secret-123456";
    const envSecret = "literal-dotenv-secret";
    await writeFile(
      path.join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: "metadata-fixture",
          description: shapedSecret,
          author: { name: "Fixture", token: shapedSecret },
          keywords: ["converter", `Bearer ${shapedSecret}`],
          dependencies: ["shared-plugin", { name: "review-suite", version: "^1.0.0" }],
          homepage: `https://example.invalid/?api_key=${metadataSecret}`,
          repository: { type: "git", url: `https://user:${metadataSecret}@example.invalid/repo.git` },
          bin: { "metadata-cli": "./scripts/cli.mjs" },
          assets: ["./assets/data.txt"],
          userConfig: {
            apiKey: {
              type: "string",
              description: "API credential",
              required: true,
              default: sensitiveDefault,
            },
            attempts: { type: "number", default: 3, minimum: 1 },
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(source, "scripts"));
    await writeFile(path.join(source, "scripts", "cli.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeFile(
      path.join(source, "package.json"),
      `${JSON.stringify({ dependencies: { kleur: "4.1.5" } }, null, 2)}\n`,
    );
    await mkdir(path.join(source, "assets"));
    await writeFile(path.join(source, "assets", "data.txt"), "asset\n");
    await mkdir(path.join(source, "docs"));
    await writeFile(path.join(source, "docs", "template.md"), "support template\n");
    await writeFile(path.join(source, ".env"), `API_TOKEN=${envSecret}\nSAFE_VALUE=kept\n`);
    await writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: root-audit\ndescription: Root skill\nallowed-tools: mcp__plugin_metadata_fixture_scan__run\n---\nUse ${user_config.apiKey}. Run ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs and write ${CLAUDE_PLUGIN_DATA}/state.json from ${CLAUDE_PROJECT_DIR}; skill root: ${CLAUDE_SKILL_DIR}.\n",
    );
    await mkdir(path.join(source, "agents"));
    await writeFile(
      path.join(source, "agents", "review.md"),
      [
        "---",
        "description: Scoped reviewer",
        "tools: Read, WebSearch, mcp__plugin_metadata_fixture_scan__run",
        "disallowedTools: WebSearch, mcp__plugin_metadata_fixture_scan__run",
        "skills: root-audit",
        "---",
        "Call mcp__plugin_metadata_fixture_scan__run.",
        "",
      ].join("\n"),
    );
    await mkdir(path.join(source, "commands"));
    await writeFile(
      path.join(source, "commands", "scan.md"),
      [
        "---",
        "description: Guarded scan",
        "allowed-tools: mcp__plugin_metadata_fixture_scan__run",
        "---",
        "Scan $ARGUMENTS.",
        "",
      ].join("\n"),
    );

    const output = path.join(root, "output");
    await convertPlugin({ source, output });
    const allOutput = await allFileText(output);
    expect(allOutput).not.toContain(sensitiveDefault);
    expect(allOutput).not.toContain(metadataSecret);
    expect(allOutput).not.toContain(shapedSecret);
    expect(allOutput).not.toContain(envSecret);
    expect(allOutput).toContain("SAFE_VALUE=kept");

    const packageManifest = JSON.parse(await readFile(path.join(output, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      bin: Record<string, string>;
      claudePiConvert: {
        assets: string[];
        pluginDependencies: unknown[];
        sourceNpmDependencies: string[];
      };
    };
    expect(packageManifest.dependencies).toEqual({ kleur: "4.1.5" });
    expect(packageManifest.bin).toEqual({ "metadata-cli": "./original/scripts/cli.mjs" });
    expect(packageManifest.claudePiConvert.assets).toEqual(["./original/assets/data.txt"]);
    expect(packageManifest.claudePiConvert.pluginDependencies).toEqual([
      "shared-plugin",
      { name: "review-suite", version: "^1.0.0" },
    ]);
    expect(packageManifest.claudePiConvert).toMatchObject({
      sourceNpmDependencies: ["kleur"],
    });

    const schema = JSON.parse(
      await readFile(path.join(output, "config", "user-config.schema.json"), "utf8"),
    ) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(schema.properties.apiKey).toMatchObject({ type: "string", writeOnly: true });
    expect(schema.properties.apiKey).not.toHaveProperty("default");
    expect(schema.required).toEqual(["apiKey"]);
    expect(await readFile(path.join(output, "config", "user-config.env.example"), "utf8"))
      .toContain("CLAUDE_PLUGIN_OPTION_APIKEY=");

    const activation = JSON.parse(
      await readFile(path.join(output, "activation-manifest.json"), "utf8"),
    ) as ActivationManifest;
    expect(activation.skillFiles).toEqual([
      expect.objectContaining({
        source: "skills/metadata-fixture-root-audit",
        target: ".pi/skills/metadata-fixture-root-audit",
      }),
    ]);
    const agent = await readFile(
      path.join(output, "activation", "agents", "metadata-fixture.review.md"),
      "utf8",
    );
    expect(agent).toMatch(/^skills: metadata-fixture-root-audit$/m);
    expect(agent).toMatch(/^disallowed_tools: web_search,mcp$/m);
    expect(agent).toContain("metadata-fixture-scan/run");
    expect(agent).not.toContain("metadata-fixture-plugin-metadata-fixture-scan");
    const mainExtension = await readFile(path.join(output, "extensions", "main.ts"), "utf8");
    expect(mainExtension).toContain('"mcpAllow": [');
    expect(mainExtension).toContain('"metadata-fixture-scan/run"');
    const skill = await readFile(
      path.join(output, "skills", "metadata-fixture-root-audit", "SKILL.md"),
      "utf8",
    );
    expect(skill).not.toMatch(/^allowed-tools:/m);
    expect(skill).toContain(".pi/claude-pi-convert/metadata-fixture/runtime/original/scripts/cli.mjs");
    expect(skill).toContain(".pi/claude-pi-convert/metadata-fixture/runtime/data/state.json");
    expect(skill).toContain("skill root: .pi/skills/metadata-fixture-root-audit");
    expect(skill).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(await readFile(
      path.join(output, "skills", "metadata-fixture-root-audit", "scripts", "cli.mjs"),
      "utf8",
    )).toContain("#!/usr/bin/env node");
    expect(await readFile(
      path.join(output, "skills", "metadata-fixture-root-audit", "docs", "template.md"),
      "utf8",
    )).toContain("support template");
    const binShim = path.join(output, "activation", "runtime", "bin", "metadata-cli");
    expect(await readFile(binShim, "utf8")).toContain("../original/scripts/cli.mjs");
    expect((await stat(binShim)).mode & 0o777).toBe(0o755);
    const conversionReport = JSON.parse(
      await readFile(path.join(output, "conversion-report.json"), "utf8"),
    ) as { issues: Array<{ status: string; message: string }> };
    expect(conversionReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "unsupported",
        message: expect.stringContaining("plugin dependencies"),
      }),
    ]));
  });

  it("caps flattened agent filenames at 128 characters including the extension", async () => {
    const { root, source } = await temporaryPlugin("long-agent-fixture");
    const nested = path.join(source, "agents", "nested");
    await mkdir(nested, { recursive: true });
    const longName = `${"security-review-".repeat(10)}agent.md`;
    await writeFile(
      path.join(nested, longName),
      "---\ndescription: Review a deliberately long agent name\ntools: Read\n---\nReview.\n",
    );

    const output = path.join(root, "output");
    await convertPlugin({ source, output });
    const generated = await readdir(path.join(output, "activation", "agents"));
    expect(generated).toHaveLength(1);
    expect(Buffer.byteLength(generated[0] ?? "", "utf8")).toBeLessThanOrEqual(128);
  });

  it("keeps Claude dynamic shell context inert and reports it as unsupported", async () => {
    const { root, source } = await temporaryPlugin("dynamic-context");
    await mkdir(path.join(source, "commands"));
    await writeFile(
      path.join(source, "commands", "inspect.md"),
      "---\ndescription: inspect\n---\nVersion: !`node --version`\n\n```!\necho never-run\n```\n",
    );

    const output = path.join(root, "output");
    const report = await convertPlugin({ source, output });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        component: "commands",
        status: "unsupported",
        message: expect.stringContaining("dynamic shell expansion"),
      }),
    ]));
    const extension = await readFile(path.join(output, "extensions", "main.ts"), "utf8");
    expect(extension).toContain("!`node --version`");
    expect(extension).toContain("echo never-run");
  });
});
