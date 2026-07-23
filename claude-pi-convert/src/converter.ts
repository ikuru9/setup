import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  CONVERTER_VERSION,
  MIN_NODE_VERSION,
  RUNTIMES,
  TARGET_PI_VERSION,
  runtimeRequirement,
} from "./constants.js";
import {
  addTreeEntry,
  assertSafeRelativePath,
  collectSafeTree,
  isPathInside,
  pathExists,
  sha256,
  toPosixPath,
  writeTreeAtomically,
  type TreeEntry,
} from "./fs-utils.js";
import {
  asRecord,
  parseFrontmatter,
  parseStructuredText,
  stringifyFrontmatter,
  stringifyStructuredText,
} from "./frontmatter.js";
import {
  renderActivationReadme,
  agentPolicySentinel,
  renderAgentGuardExtension,
  renderMainExtension,
  renderMcpLauncher,
  type RuntimeHookHandlerSpec,
  type RuntimeHookSpec,
  type RuntimeLspServerSpec,
  type RuntimeMonitorSpec,
  type RuntimeTemplateSpec,
} from "./runtime-templates.js";
import type {
  ActivationFile,
  ActivationManifest,
  ComponentSummary,
  ConversionIssue,
  ConversionReport,
  ConversionStatus,
  ConvertOptions,
  ReportActivationAction,
  RuntimeRequirement,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

interface SourceIndex {
  root: string;
  entries: readonly TreeEntry[];
  byPath: ReadonlyMap<string, TreeEntry>;
}

interface AgentSpec {
  name: string;
  source: string;
  targetFile: string;
  content: string;
  mcpAllow: string[];
}

interface CommandSpec {
  name: string;
  source: string;
  description?: string;
  argumentHint?: string;
  prompt: string;
  allowedTools?: string[];
  mcpAllow?: string[];
  model?: string;
}

interface OutputStyleSpec {
  name: string;
  description?: string;
  prompt: string;
  forceForPlugin?: boolean;
  keepCodingInstructions?: boolean;
}

interface McpLauncherServer {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface McpConversion {
  config: UnknownRecord | undefined;
  launchers: McpLauncherServer[];
  envExample: string[];
  found: boolean;
}

interface HookConversion {
  hooks: RuntimeHookSpec[];
  found: boolean;
  needsSubagents: boolean;
}

interface IssueRecorder {
  add(
    component: string,
    status: ConversionStatus,
    message: string,
    options?: { source?: string; target?: string; detail?: unknown },
  ): void;
  list: ConversionIssue[];
}

const MANIFEST_CANDIDATES = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/plugin.jsonc",
  ".claude-plugin/plugin.yaml",
  ".claude-plugin/plugin.yml",
] as const;

const DIRECT_HOOK_EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "Stop",
  "StopFailure",
]);

const APPROXIMATE_HOOK_EVENTS = new Set([
  "Setup",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "PostToolBatch",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "MessageDisplay",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
]);

const UNSUPPORTED_HOOK_EVENTS = new Set([
  "UserPromptExpansion",
  "TeammateIdle",
  "Elicitation",
  "ElicitationResult",
  "WorktreeCreate",
  "WorktreeRemove",
]);

const EXACT_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: "read",
  Bash: "bash",
  Edit: "edit",
  Write: "write",
  Grep: "grep",
  Glob: "find",
  WebSearch: "web_search",
  WebFetch: "fetch_content",
};

const APPROXIMATE_TOOL_MAP: Readonly<Record<string, string>> = {
  Task: "Agent",
  Agent: "Agent",
};

export async function convertPlugin(options: ConvertOptions): Promise<ConversionReport> {
  const source = await realpath(path.resolve(options.source));
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) throw new Error(`Source is not a directory: ${source}`);

  const defaultOutput = path.join(path.dirname(source), `${path.basename(source)}-pi`);
  const output = path.resolve(options.output ?? defaultOutput);
  if (isPathInside(source, output) || isPathInside(output, source)) {
    throw new Error("Source and output directories must not contain one another");
  }

  const excludedSourceRoots = new Set([".git", ".hg", ".svn", "node_modules"]);
  const excludedPresent: string[] = [];
  for (const excluded of excludedSourceRoots) {
    if (await pathExists(path.join(source, excluded))) excludedPresent.push(excluded);
  }
  const sourceEntries = await collectSafeTree(source, { exclude: excludedSourceRoots });
  const sourceIndex = indexSource(source, sourceEntries);
  const manifestEntry = findFirst(sourceIndex, MANIFEST_CANDIDATES);
  const manifest = manifestEntry
    ? asRecord(parseEntry(manifestEntry), manifestEntry.path)
    : ({} as UnknownRecord);
  const experimental = isRecord(manifest.experimental) ? manifest.experimental : {};
  const themesManifestValue = experimental.themes ?? manifest.themes;
  const monitorsManifestValue = experimental.monitors ?? manifest.monitors;

  const issues = createIssueRecorder();
  for (const excluded of excludedPresent) {
    issues.add(
      "security",
      "approximated",
      `Excluded ${excluded} from the portable output; dependency metadata is analyzed separately`,
      { source: excluded },
    );
  }
  const manifestName = readString(manifest.name);
  const unsafeManifestName = options.includeSecrets !== true &&
    manifestName !== undefined &&
    containsSecretsDeep(manifestName);
  if (unsafeManifestName) {
    issues.add("security", "approximated", "Ignored a secret-shaped plugin name");
  }
  const rawName = unsafeManifestName ? path.basename(source) : manifestName ?? path.basename(source);
  const pluginSlug = slugify(rawName);
  const pluginId = pluginSlug;
  const rawDisplayName = readString(manifest.displayName);
  const displayName = options.includeSecrets !== true && rawDisplayName && containsSecretsDeep(rawDisplayName)
    ? rawName
    : rawDisplayName ?? rawName;
  issues.add(
    "manifest",
    manifestEntry ? "converted" : "approximated",
    manifestEntry
      ? "Converted Claude plugin metadata to a Pi package manifest"
      : "No .claude-plugin/plugin manifest was found; inferred metadata from the directory name",
    manifestEntry ? { source: manifestEntry.path, target: "package.json" } : { target: "package.json" },
  );

  const outputTree = new Map<string, TreeEntry>();
  const activationAgents: ActivationFile[] = [];
  const activationSkillFiles: ActivationFile[] = [];
  const activationRuntimeFiles: ActivationFile[] = [];
  const preservedSecretExamples = new Set<string>();

  if (manifest.themes !== undefined) {
    issues.add(
      "themes",
      "approximated",
      experimental.themes === undefined
        ? "Accepted the deprecated top-level themes declaration"
        : "Ignored the deprecated top-level themes declaration in favor of experimental.themes",
      { ...(manifestEntry ? { source: manifestEntry.path } : {}), detail: manifest.themes },
    );
  }
  if (manifest.monitors !== undefined) {
    issues.add(
      "monitors",
      "approximated",
      experimental.monitors === undefined
        ? "Accepted the deprecated top-level monitors declaration"
        : "Ignored the deprecated top-level monitors declaration in favor of experimental.monitors",
      { ...(manifestEntry ? { source: manifestEntry.path } : {}), detail: manifest.monitors },
    );
  }

  // Preserve the complete, statically-read source. Internal symlinks have
  // already been dereferenced by collectSafeTree and external links rejected.
  for (const entry of sourceEntries) {
    const preservedPath = `original/${entry.path}`;
    let preservedContent: string | Uint8Array = entry.content;
    if (!options.includeSecrets && /\.(?:json|jsonc|yaml|yml)$/i.test(entry.path)) {
      try {
        const parsed = parseEntry(entry);
        if (isRecord(parsed)) {
          const discoveredSecrets = new Set<string>();
          const redacted = redactSecrets(parsed, pluginSlug, false, discoveredSecrets);
          if (discoveredSecrets.size > 0) {
            preservedContent = stringifyStructuredText(redacted, path.posix.extname(entry.path));
            for (const example of discoveredSecrets) preservedSecretExamples.add(example);
            issues.add("security", "approximated", "Redacted secrets from a preserved structured source file", {
              source: entry.path,
              target: preservedPath,
            });
          }
        }
      } catch {
        // The component-specific parser will report malformed known config.
        // Unknown supporting files remain byte-for-byte preserved.
      }
    } else if (!options.includeSecrets && isSecretScannableText(entry.path, entry.content)) {
      const discoveredSecrets = new Set<string>();
      const redacted = redactPlainTextSecrets(
        Buffer.from(entry.content).toString("utf8"),
        `${pluginSlug}_${entry.path}`,
        discoveredSecrets,
      );
      if (discoveredSecrets.size > 0) {
        preservedContent = redacted;
        for (const example of discoveredSecrets) preservedSecretExamples.add(example);
        issues.add("security", "approximated", "Redacted secrets from a preserved text source file", {
          source: entry.path,
          target: preservedPath,
        });
      }
    }
    addTreeEntry(outputTree, preservedPath, preservedContent, entry.mode);
    activationRuntimeFiles.push({
      source: preservedPath,
      target: `.pi/claude-pi-convert/${pluginId}/runtime/original/${entry.path}`,
      kind: "runtime",
      mode: entry.mode,
    });
  }

  const agentFiles = discoverMarkdownComponents(
    sourceIndex,
    declaredPaths(manifest.agents, "agents", issues),
    manifest.agents === undefined ? ["agents"] : [],
    (entry) => entry.path.toLocaleLowerCase("en-US").endsWith(".md"),
    "agents",
    issues,
  );
  const agentNameMap = new Map<string, string>();
  const agentAliases = new Map<string, string[]>();
  for (const entry of agentFiles) {
    const logicalName = relativeComponentPath(entry.path, "agents").replace(/\.md$/i, "");
    const generatedName = flattenedName(pluginSlug, logicalName);
    agentNameMap.set(logicalName, generatedName);
    agentNameMap.set(`agents/${logicalName}.md`, generatedName);
    const declaredName = readString(parseFrontmatter(entry.content.toString(), entry.path).attributes.name);
    for (const alias of new Set([
      path.posix.basename(logicalName),
      ...(declaredName ? [declaredName] : []),
    ])) {
      const candidates = agentAliases.get(alias) ?? [];
      candidates.push(generatedName);
      agentAliases.set(alias, candidates);
    }
  }
  for (const [alias, candidates] of agentAliases) {
    if (candidates.length === 1 && candidates[0] !== undefined) {
      agentNameMap.set(alias, candidates[0]);
    }
  }

  const skillFiles = discoverMarkdownComponents(
    sourceIndex,
    declaredPaths(manifest.skills, "skills", issues),
    manifest.skills === undefined ? ["skills", "SKILL.md"] : ["skills"],
    (entry) => path.posix.basename(entry.path).toLocaleLowerCase("en-US") === "skill.md",
    "skills",
    issues,
  );
  let webAccessRequired = false;
  let subagentToolRequired = false;
  const skillRoots = new Set<string>();
  const allSkillRoots = new Set(skillFiles.map((file) => path.posix.dirname(file.path)));
  const skillNameMap = new Map<string, string>();
  const generatedSkillTargets = new Map<string, string>();
  for (const skillFile of skillFiles) {
    const skillRoot = path.posix.dirname(skillFile.path);
    const parsed = parseFrontmatter(skillFile.content.toString(), skillFile.path);
    const declaredSkillName = readString(parsed.attributes.name);
    const logicalSkillName = skillRoot === "."
      ? declaredSkillName ?? "root"
      : relativeComponentPath(skillRoot, "skills");
    const flatName = flattenedSkillName(pluginSlug, logicalSkillName);
    const targetRoot = `skills/${flatName}`;
    if (skillRoots.has(skillRoot)) continue;
    skillRoots.add(skillRoot);
    assertUniqueGeneratedName(generatedSkillTargets, targetRoot, skillFile.path, "skill");
    const supportingEntries = skillRoot === "."
      ? rootSkillSupportingEntries(sourceIndex, skillFile, manifest)
      : entriesBelow(sourceIndex, skillRoot);
    for (const entry of supportingEntries) {
      const relative = path.posix.relative(skillRoot, entry.path);
      const portableContent = options.includeSecrets
        ? entry.content
        : redactPortableEntry(
            entry,
            `${pluginSlug}_${flatName}_${relative}`,
            preservedSecretExamples,
          );
      if (!options.includeSecrets && !sameTreeContent(entry.content, portableContent)) {
        issues.add("security", "approximated", "Redacted secrets from a generated skill asset", {
          source: entry.path,
          target: `${targetRoot}/${relative}`,
        });
      }
      addTreeEntry(outputTree, `${targetRoot}/${relative}`, portableContent, entry.mode);
    }
    const externalAssets = collectExternalSkillAssets(
      sourceIndex,
      skillFile,
      parsed.body,
      skillRoot,
      allSkillRoots,
      targetRoot,
      issues,
    );
    for (const asset of externalAssets.entries) {
      const existing = outputTree.get(asset.target);
      if (existing && !sameTreeContent(existing.content, asset.entry.content)) {
        throw new Error(`External skill asset conflicts with an existing skill file: ${asset.target}`);
      }
      if (!existing) {
        const portableContent = options.includeSecrets
          ? asset.entry.content
          : redactPortableEntry(
              asset.entry,
              `${pluginSlug}_${flatName}_${asset.target}`,
              preservedSecretExamples,
            );
        addTreeEntry(outputTree, asset.target, portableContent, asset.entry.mode);
      }
    }
    const mapped = mapSkillFrontmatter(parsed.attributes, pluginSlug, issues, skillFile.path);
    mapped.name = flatName;
    const transformedBody = transformAgentReferences(
      transformReferences(externalAssets.body, pluginSlug),
      agentNameMap,
    ).replaceAll("${CLAUDE_SKILL_DIR}", `.pi/skills/${flatName}`);
    if (usesDynamicShellExpansion(parsed.body)) {
      issues.add(
        "skills",
        "unsupported",
        "Claude dynamic shell expansion was preserved as inert Markdown and was not executed",
        { source: skillFile.path },
      );
    }
    webAccessRequired ||= usesWebTools(skillFile.content.toString());
    subagentToolRequired ||= usesSubagentTools(skillFile.content.toString());
    const generatedSkill = stringifyFrontmatter(mapped, transformedBody);
    const safeGeneratedSkill = options.includeSecrets
      ? generatedSkill
      : redactGeneratedMarkdown(
          generatedSkill,
          `${pluginSlug}_${flatName}_skill`,
          preservedSecretExamples,
        );
    if (!options.includeSecrets && safeGeneratedSkill !== generatedSkill) {
      issues.add("security", "approximated", "Redacted secrets from a generated Pi skill", {
        source: skillFile.path,
        target: `${targetRoot}/SKILL.md`,
      });
    }
    addTreeEntry(
      outputTree,
      `${targetRoot}/SKILL.md`,
      safeGeneratedSkill,
      skillFile.mode,
    );
    activationSkillFiles.push({
      source: targetRoot,
      target: `.pi/skills/${flatName}`,
      kind: "other",
      mode: skillFile.mode,
    });
    const skillAliases = new Set([
      logicalSkillName,
      path.posix.basename(logicalSkillName),
      ...(declaredSkillName ? [declaredSkillName] : []),
    ]);
    for (const alias of skillAliases) skillNameMap.set(alias, flatName);
    issues.add("skills", "converted", "Converted Claude skill to a Pi skill", {
      source: skillFile.path,
      target: `${targetRoot}/SKILL.md`,
    });
  }

  const agents: AgentSpec[] = [];
  const generatedAgentTargets = new Map<string, string>();
  for (const agentFile of agentFiles) {
    const convertedAgent = convertAgent(agentFile, pluginSlug, agentNameMap, skillNameMap, issues);
    const agent = options.includeSecrets
      ? convertedAgent
      : {
          ...convertedAgent,
          content: redactGeneratedMarkdown(
            convertedAgent.content,
            `${pluginSlug}_${convertedAgent.name}_agent`,
            preservedSecretExamples,
          ),
        };
    if (!options.includeSecrets && agent.content !== convertedAgent.content) {
      issues.add("security", "approximated", "Redacted secrets from a generated Pi agent", {
        source: agentFile.path,
        target: `activation/agents/${agent.targetFile}`,
      });
    }
    assertUniqueGeneratedName(generatedAgentTargets, agent.targetFile, agentFile.path, "agent");
    agents.push(agent);
    webAccessRequired ||= usesWebTools(agentFile.content.toString());
    subagentToolRequired ||= usesSubagentTools(agentFile.content.toString());
    const outputPath = `activation/agents/${agent.targetFile}`;
    addTreeEntry(outputTree, outputPath, agent.content, agentFile.mode);
    activationAgents.push({
      source: outputPath,
      target: `.pi/agents/${agent.targetFile}`,
      kind: "agent",
      mode: agentFile.mode,
    });
  }

  const commandFiles = discoverMarkdownComponents(
    sourceIndex,
    declaredPaths(manifest.commands, "commands", issues),
    manifest.commands === undefined ? ["commands"] : [],
    (entry) => entry.path.toLocaleLowerCase("en-US").endsWith(".md"),
    "commands",
    issues,
  );
  const generatedCommandNames = new Map<string, string>();
  const commands: CommandSpec[] = commandFiles.map((entry) => {
    const parsed = parseFrontmatter(entry.content.toString(), entry.path);
    webAccessRequired ||= usesWebTools(entry.content.toString());
    subagentToolRequired ||= usesSubagentTools(entry.content.toString());
    const attributes = parsed.attributes;
    const relativeCommandPath = commandLogicalName(entry.path);
    const command: CommandSpec = {
      name: flattenedName(
        options.commandPrefix === true ? pluginSlug : "",
        options.commandPrefix === true
          ? relativeCommandPath
          : path.posix.basename(relativeCommandPath),
      ),
      source: entry.path,
      prompt: transformAgentReferences(transformReferences(parsed.body, pluginSlug), agentNameMap),
    };
    if (usesDynamicShellExpansion(parsed.body)) {
      issues.add(
        "commands",
        "unsupported",
        "Claude dynamic shell expansion was preserved as inert prompt text and was not executed",
        { source: entry.path },
      );
    }
    assertUniqueGeneratedName(generatedCommandNames, command.name, entry.path, "command");
    const description = readString(attributes.description);
    const argumentHint = readString(attributes["argument-hint"] ?? attributes.argumentHint);
    const model = readString(attributes.model);
    const rawAllowedTools = attributes["allowed-tools"] ?? attributes.allowedTools;
    const toolsWereSpecified = rawAllowedTools !== undefined;
    const tools = readToolList(rawAllowedTools);
    if (description !== undefined) command.description = description;
    if (argumentHint !== undefined) command.argumentHint = argumentHint;
    if (model !== undefined && model !== "inherit") {
      command.model = model;
      if (/^(?:sonnet|haiku|opus)$/i.test(model)) {
        issues.add(
          "commands",
          "approximated",
          `Claude model alias ${model} is resolved against the available Pi model catalog at invocation time`,
          { source: entry.path },
        );
      }
    }
    if (toolsWereSpecified) {
      const mcpAllow: string[] = [];
      command.allowedTools = tools.map((tool) => {
        const mapped = mapTool(tool, pluginSlug);
        if (mapped.mcpAllow) mcpAllow.push(mapped.mcpAllow);
        if (mapped.status !== "converted") {
          issues.add("commands", mapped.status, mapped.message, { source: entry.path, detail: tool });
        }
        return mapped.target;
      });
      if (mcpAllow.length > 0) command.mcpAllow = [...new Set(mcpAllow)].sort();
    }
    const knownCommandFields = new Set([
      "description",
      "argument-hint",
      "argumentHint",
      "model",
      "allowed-tools",
      "allowedTools",
    ]);
    for (const key of Object.keys(attributes)) {
      if (!knownCommandFields.has(key)) {
        const unsupported = ["hooks", "disable-model-invocation", "user-invocable"].includes(key);
        issues.add(
          "commands",
          unsupported ? "unsupported" : "preserved",
          `${unsupported ? "Cannot apply" : "Preserved"} Claude command field: ${key}`,
          { source: entry.path, detail: { [key]: attributes[key] } },
        );
      }
    }
    issues.add("commands", "converted", "Converted Claude command to a Pi slash command", {
      source: entry.path,
      target: `/${command.name}`,
    });
    return command;
  });

  const hookConversion = convertHooks(sourceIndex, manifest, pluginSlug, agentNameMap, issues);
  if (hookConversion.hooks && usesWebTools(JSON.stringify(hookConversion.hooks))) {
    webAccessRequired = true;
  }
  const mcpConversion = convertMcp(
    sourceIndex,
    manifest,
    pluginSlug,
    pluginId,
    options.includeSecrets === true,
    issues,
  );
  const hasMcpToolReferences = sourceEntries.some((entry) =>
    /\bmcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+\b/.test(entry.content.toString()),
  );

  const lspConfig = convertLspConfig(sourceIndex, manifest.lspServers, issues);
  const lspServers = normalizeLspServers(lspConfig, issues);
  if (lspServers.length > 0) {
    issues.add("lsp", "approximated", "Generated a Pi stdio JSON-RPC LSP bridge", {
      target: "extensions/main.ts",
    });
  }

  const outputStyles = convertOutputStyles(sourceIndex, manifest, pluginSlug, agentNameMap, issues);
  const monitors = convertMonitors(sourceIndex, monitorsManifestValue, skillNameMap, issues);
  if (monitors.length > 0) {
    issues.add("monitors", "approximated", "Converted monitors to session-scoped Pi watchers", {
      target: "extensions/main.ts",
    });
  }

  const themeCount = convertThemes(
    sourceIndex,
    themesManifestValue,
    pluginSlug,
    outputTree,
    issues,
  );
  convertUserConfiguration(sourceIndex, manifest, pluginSlug, outputTree, issues);
  reportPreservedConfiguration(sourceIndex, manifest, issues);
  auditManifestFields(manifest, manifestEntry?.path, issues);

  const runtimeRequirements: RuntimeRequirement[] = [];
  if (agents.length > 0 || hookConversion.needsSubagents || subagentToolRequired) {
    runtimeRequirements.push(
      runtimeRequirement("subagents", "Converted Claude agents, Agent tools, or agent lifecycle hooks"),
    );
  }
  if (mcpConversion.found || hasMcpToolReferences) {
    runtimeRequirements.push(runtimeRequirement("mcp", "Converted MCP servers or MCP tool references"));
    if (!mcpConversion.found && hasMcpToolReferences) {
      issues.add("mcp", "preserved", "MCP tool references were found without an MCP server configuration");
    }
  }
  if (webAccessRequired) {
    runtimeRequirements.push(runtimeRequirement("web", "Converted WebSearch or WebFetch tool usage"));
    issues.add("web", "converted", "Mapped Claude web tools to pi-web-access without enabling librarian skills", {
      target: "extensions/main.ts",
    });
  }

  const runtimeSpec: RuntimeTemplateSpec = {
    pluginId,
    pluginSlug,
    displayName,
    commands,
    outputStyles,
    ...(hookConversion.hooks.length > 0 ? { hooks: hookConversion.hooks } : {}),
    ...(webAccessRequired ? { webAccess: true } : {}),
    ...(lspServers.length > 0 ? { lspServers } : {}),
    ...(monitors.length > 0 ? { monitors } : {}),
    ...(agents.length > 0
      ? {
          agentPolicies: agents.map((agent) => ({
            name: agent.name,
            mcpAllow: agent.mcpAllow,
          })),
        }
      : {}),
    ...(mcpConversion.found
      ? {
          mcpServers: mcpConversion.launchers,
          runtimeDirFromLauncher: "./original/",
        }
      : {}),
    runtimeRequirements,
  };

  const runtimeEnvExamples = new Set([
    ...mcpConversion.envExample,
    ...preservedSecretExamples,
  ]);
  const referencedRuntimeSpec = replaceUserConfigReferences(
    runtimeSpec,
    pluginSlug,
  ) as RuntimeTemplateSpec;
  const renderSpec = options.includeSecrets
    ? referencedRuntimeSpec
    : (redactEmbeddedTextSecrets(
        redactSecrets(
          referencedRuntimeSpec as unknown as UnknownRecord,
          `${pluginSlug}_runtime`,
          false,
          runtimeEnvExamples,
        ),
        `${pluginSlug}_runtime_text`,
        runtimeEnvExamples,
      ) as unknown as RuntimeTemplateSpec);
  if (
    !options.includeSecrets &&
    JSON.stringify(renderSpec) !== JSON.stringify(referencedRuntimeSpec)
  ) {
    issues.add(
      "security",
      "approximated",
      "Redacted secrets from generated command, hook, LSP, monitor, or output-style runtime data",
      { target: "extensions/main.ts" },
    );
  }

  addTreeEntry(outputTree, "extensions/main.ts", renderMainExtension(renderSpec), 0o644);
  if (agents.some((agent) => agent.mcpAllow.length > 0) || hookConversion.needsSubagents) {
    addTreeEntry(outputTree, "extensions/agent-guard.ts", renderAgentGuardExtension(renderSpec), 0o644);
  }
  if (mcpConversion.launchers.length > 0) {
    const launcherPath = "activation/runtime/mcp-launcher.mjs";
    addTreeEntry(outputTree, launcherPath, renderMcpLauncher(renderSpec), 0o755);
    activationRuntimeFiles.push({
      source: launcherPath,
      target: `.pi/claude-pi-convert/${pluginId}/runtime/mcp-launcher.mjs`,
      kind: "runtime",
      mode: 0o755,
    });
  }
  addTreeEntry(outputTree, "activation/runtime/data/.keep", "", 0o600);
  activationRuntimeFiles.push({
    source: "activation/runtime/data/.keep",
    target: `.pi/claude-pi-convert/${pluginId}/runtime/data/.keep`,
    kind: "runtime",
    mode: 0o600,
  });
  if (runtimeEnvExamples.size > 0) {
    addTreeEntry(
      outputTree,
      "activation/runtime/env.example",
      `${[...runtimeEnvExamples].sort().join("\n")}\n`,
      0o600,
    );
  }

  const piPackage = createPiPackageManifest(
    manifest,
    pluginSlug,
    displayName,
    skillFiles.length > 0,
    themeCount > 0,
    agents.some((agent) => agent.mcpAllow.length > 0) || hookConversion.needsSubagents,
    options.includeSecrets === true,
    issues,
  );
  applyManifestRuntimeMetadata(
    piPackage,
    manifest,
    sourceIndex,
    options.includeSecrets === true,
    issues,
  );
  if (isRecord(piPackage.bin)) {
    for (const [name, rawTarget] of Object.entries(piPackage.bin)) {
      if (typeof rawTarget !== "string" || !rawTarget.startsWith("./original/")) continue;
      const originalTarget = rawTarget.slice("./original/".length);
      const shimPath = `activation/runtime/bin/${name}`;
      addTreeEntry(
        outputTree,
        shimPath,
        renderRuntimeBinShim(pluginId, originalTarget),
        0o755,
      );
      activationRuntimeFiles.push({
        source: shimPath,
        target: `.pi/claude-pi-convert/${pluginId}/runtime/bin/${name}`,
        kind: "runtime",
        mode: 0o755,
      });
    }
  }
  addTreeEntry(outputTree, "package.json", `${JSON.stringify(piPackage, null, 2)}\n`, 0o644);
  addTreeEntry(outputTree, "tsconfig.json", `${JSON.stringify(createGeneratedTsConfig(), null, 2)}\n`, 0o644);

  const activationManifest: ActivationManifest = {
    schemaVersion: 1,
    pluginId,
    pluginSlug,
    packageRoot: ".",
    agents: activationAgents,
    ...(activationSkillFiles.length > 0 ? { skillFiles: activationSkillFiles } : {}),
    runtimeFiles: activationRuntimeFiles,
    ...(mcpConversion.config ? { mcpConfig: mcpConversion.config } : {}),
    runtimeRequirements,
    webAccessRequired,
  };
  addTreeEntry(
    outputTree,
    "activation-manifest.json",
    `${JSON.stringify(activationManifest, null, 2)}\n`,
    0o644,
  );
  addTreeEntry(outputTree, "ACTIVATE.md", renderActivationReadme(renderSpec), 0o644);

  const reportIssues = options.includeSecrets
    ? issues.list
    : issues.list.map((issue) =>
        issue.detail === undefined
          ? issue
          : { ...issue, detail: redactReportDetail(issue.detail) },
      );
  const report: ConversionReport = {
    schemaVersion: 1,
    converterVersion: CONVERTER_VERSION,
    createdAt: reproducibleTimestamp(manifestEntry, sourceStat.mtime),
    source: options.sourceDisplay ?? source,
    output,
    pluginId,
    pluginSlug,
    target: {
      node: `>=${MIN_NODE_VERSION}` as ">=22.19.0",
      pi: TARGET_PI_VERSION as "0.81.1",
    },
    runtimeRequirements,
    components: summarizeComponents(reportIssues),
    issues: reportIssues,
    warnings: reportIssues.filter((issue) =>
      issue.status === "approximated" || issue.status === "preserved"
    ),
    unsupportedFields: reportIssues.filter((issue) => issue.status === "unsupported"),
    activationActions: createReportActivationActions(
      output,
      activationManifest,
    ),
    activationManifest: "activation-manifest.json",
  };
  addTreeEntry(outputTree, "conversion-report.json", `${JSON.stringify(report, null, 2)}\n`, 0o644);
  addTreeEntry(outputTree, "conversion-report.md", renderReport(report), 0o644);

  const ownershipMarker = ".claude-pi-convert-ownership.json";
  const ownership = {
    schemaVersion: 1,
    converterVersion: CONVERTER_VERSION,
    output,
    owner: pluginId,
    files: [...outputTree.values()]
      .sort((left, right) => left.path.localeCompare(right.path, "en"))
      .map((entry) => ({
        path: entry.path,
        sha256: sha256(entry.content),
        mode: entry.mode,
      })),
  };
  addTreeEntry(outputTree, ownershipMarker, `${JSON.stringify(ownership, null, 2)}\n`, 0o600);

  await writeTreeAtomically(output, outputTree.values(), {
    force: options.force === true,
    dryRun: options.dryRun === true,
    ownershipMarker,
    expectedOwnership: { output, owner: pluginId },
  });
  return report;
}

function indexSource(root: string, entries: readonly TreeEntry[]): SourceIndex {
  return { root, entries, byPath: new Map(entries.map((entry) => [entry.path, entry])) };
}

function findFirst(index: SourceIndex, candidates: readonly string[]): TreeEntry | undefined {
  for (const candidate of candidates) {
    const entry = index.byPath.get(candidate);
    if (entry) return entry;
  }
  return undefined;
}

function parseEntry(entry: TreeEntry): unknown {
  return parseStructuredText(entry.content.toString(), path.posix.extname(entry.path), entry.path);
}

function entriesBelow(index: SourceIndex, directory: string): TreeEntry[] {
  const prefix = directory === "." ? "" : `${directory.replace(/\/$/, "")}/`;
  return index.entries.filter((entry) => entry.path.startsWith(prefix));
}

interface ExternalSkillAssetPlan {
  body: string;
  entries: Array<{ entry: TreeEntry; target: string }>;
}

/**
 * Make a converted skill self-contained when its Markdown points at a static
 * plugin asset outside its own directory. Other skills are deliberately not
 * imported: skill-to-skill dependencies remain visible to the user instead of
 * silently duplicating a second skill inside the first one.
 */
function collectExternalSkillAssets(
  index: SourceIndex,
  skillFile: TreeEntry,
  bodyContent: string,
  skillRoot: string,
  allSkillRoots: ReadonlySet<string>,
  targetRoot: string,
  issues: IssueRecorder,
): ExternalSkillAssetPlan {
  const references = staticSkillPathReferences(bodyContent);
  const copied = new Map<string, { entry: TreeEntry; target: string }>();
  let body = bodyContent;

  for (const reference of references) {
    const sourcePath = resolveSkillAssetReference(index, skillRoot, reference);
    if (!sourcePath) continue;
    if (isAnotherSkillPath(sourcePath, skillRoot, allSkillRoots)) {
      issues.add("skills", "preserved", "Did not copy a reference to another skill", {
        source: skillFile.path,
        detail: reference,
      });
      continue;
    }
    const sourceEntries = sourcePath.endsWith("/")
      ? entriesBelow(index, sourcePath.slice(0, -1))
      : index.byPath.has(sourcePath)
        ? [index.byPath.get(sourcePath) as TreeEntry]
        : entriesBelow(index, sourcePath);
    if (sourceEntries.length === 0) continue;

    const sourceIsInsideSkill = sourceEntries.every((entry) =>
      skillRoot === "." || entry.path === skillRoot || entry.path.startsWith(`${skillRoot}/`),
    );
    if (sourceIsInsideSkill) continue;

    const normalizedReference = reference.replace(/^\.\//, "");
    const useOriginalRelativePath = !normalizedReference.split("/").includes("..");
    const targetBase = useOriginalRelativePath
      ? normalizedReference.replace(/\/$/, "")
      : sourcePath.replace(/\/$/, "");
    const sourceBase = sourceEntries.length === 1 && sourceEntries[0]?.path === sourcePath
      ? sourcePath
      : sourcePath.replace(/\/$/, "");
    for (const entry of sourceEntries) {
      const suffix = entry.path === sourceBase ? "" : path.posix.relative(sourceBase, entry.path);
      const target = `${targetRoot}/${targetBase}${suffix ? `/${suffix}` : ""}`;
      copied.set(target, { entry, target });
    }
    const replacement = useOriginalRelativePath ? normalizedReference : targetBase;
    if (replacement !== reference) body = body.replaceAll(reference, replacement);
    issues.add("skills", "converted", "Copied an externally referenced plugin asset into the skill", {
      source: sourcePath,
      target: `${targetRoot}/${targetBase}`,
    });
  }
  return { body, entries: [...copied.values()] };
}

function staticSkillPathReferences(content: string): string[] {
  const found = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim().replace(/^<|>$/g, "");
    if (!trimmed || trimmed.includes("${") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("/")) return;
    const pathOnly = trimmed.split(/[?#]/, 1)[0] ?? "";
    if (!pathOnly.includes("/") || /[\\\s]/.test(pathOnly)) return;
    if (!/^(?:\.?\.?\/|[A-Za-z0-9_.-]+\/)/.test(pathOnly)) return;
    found.add(pathOnly);
  };
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) add(match[1] ?? "");
  for (const match of content.matchAll(/`([^`]+)`/g)) add(match[1] ?? "");
  for (const match of content.matchAll(/(?:^|[\s(`"'])(\.?\.?\/[A-Za-z0-9_./-]+|(?:references|docs|templates|scripts)\/[A-Za-z0-9_./-]+)/gm)) {
    add(match[1] ?? "");
  }
  return [...found].sort((left, right) => right.length - left.length || left.localeCompare(right, "en"));
}

function resolveSkillAssetReference(index: SourceIndex, skillRoot: string, reference: string): string | undefined {
  const fromSkill = path.posix.normalize(path.posix.join(skillRoot, reference));
  const candidates = [fromSkill, path.posix.normalize(reference.replace(/^\.\//, ""))]
    .filter((candidate) => candidate !== "." && !candidate.startsWith("../"));
  return candidates.find((candidate) =>
    index.byPath.has(candidate) || index.entries.some((entry) => entry.path.startsWith(`${candidate.replace(/\/$/, "")}/`)),
  );
}

function isAnotherSkillPath(pathValue: string, currentSkillRoot: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (root === currentSkillRoot || root === ".") continue;
    if (pathValue === root || pathValue.startsWith(`${root}/`)) return true;
  }
  return false;
}

function rootSkillSupportingEntries(
  index: SourceIndex,
  skillFile: TreeEntry,
  manifest: UnknownRecord,
): TreeEntry[] {
  // A root SKILL.md is a valid single-skill plugin. Pi relocates it into a
  // named skill directory, so copy sibling support files while excluding
  // Claude's own component/config trees. This keeps arbitrary relative links
  // such as docs/template.md working without nesting agents or hooks in a Pi
  // skill.
  const reservedRoots = new Set([
    ".claude-plugin",
    "agents",
    "commands",
    "skills",
    "hooks",
    "output-styles",
    "themes",
    "monitors",
    "channels",
  ]);
  const declaredValues = [
    manifest.agents,
    manifest.commands,
    manifest.skills,
    manifest.hooks,
    manifest.mcpServers,
    manifest.outputStyles,
    manifest.lspServers,
    manifest.themes,
    manifest.monitors,
    ...(isRecord(manifest.experimental)
      ? [manifest.experimental.themes, manifest.experimental.monitors]
      : []),
  ];
  for (const value of declaredValues) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== "string") continue;
      const normalized = item
        .replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, "")
        .replace(/^\.\//, "")
        .replaceAll("\\", "/");
      const root = normalized.split("/").filter(Boolean)[0];
      if (root && root !== "SKILL.md") reservedRoots.add(root);
    }
  }
  const reservedFiles = new Set([
    ".mcp.json",
    ".mcp.jsonc",
    "mcp.json",
    "mcp.jsonc",
    ".lsp.json",
    "lsp.json",
    "hooks.json",
    "hooks.jsonc",
    "settings.json",
    "settings.jsonc",
    "monitors.json",
    "channels.json",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ]);
  return index.entries.filter((entry) => {
    if (entry.path === skillFile.path) return true;
    if (reservedFiles.has(entry.path)) return false;
    if (/^\.env(?:\..+)?$/i.test(path.posix.basename(entry.path))) return false;
    const root = entry.path.split("/")[0] ?? entry.path;
    return !reservedRoots.has(root);
  });
}

function entryMatchesPath(entry: TreeEntry, componentPath: string): boolean {
  return entry.path === componentPath || entry.path.startsWith(`${componentPath.replace(/\/$/, "")}/`);
}

function declaredPaths(value: unknown, component: string, issues: IssueRecorder): string[] {
  if (value === undefined || value === null || isRecord(value)) return [];
  const values = Array.isArray(value) ? value : [value];
  const output: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") {
      issues.add(component, "preserved", "Ignored a non-string custom component path", {
        detail: item,
      });
      continue;
    }
    const pluginRootPath = /^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/.test(item);
    const withoutRoot = item
      .replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, "")
      .replace(/^\.\//, "");
    const safePath = assertSafeRelativePath(withoutRoot, `${component} path`);
    if (!pluginRootPath && !item.startsWith("./")) {
      throw new Error(`${component} path must be relative to the plugin root and start with ./: ${item}`);
    }
    output.push(safePath);
  }
  return [...new Set(output)];
}

function discoverMarkdownComponents(
  index: SourceIndex,
  declared: readonly string[],
  conventional: readonly string[],
  predicate: (entry: TreeEntry) => boolean,
  component: string,
  issues: IssueRecorder,
): TreeEntry[] {
  const explicitMatches = new Set<string>();
  for (const configuredPath of declared) {
    const matches = index.entries.filter(
      (entry) => entryMatchesPath(entry, configuredPath) && predicate(entry),
    );
    if (matches.length === 0) {
      issues.add(component, "preserved", "Configured component path was not found", {
        source: configuredPath,
      });
    }
    for (const match of matches) explicitMatches.add(match.path);
  }
  for (const conventionalPath of conventional) {
    for (const entry of index.entries) {
      if (entryMatchesPath(entry, conventionalPath) && predicate(entry)) {
        explicitMatches.add(entry.path);
      }
    }
  }
  return [...explicitMatches]
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((entryPath) => index.byPath.get(entryPath))
    .filter((entry): entry is TreeEntry => entry !== undefined);
}

function relativeComponentPath(filePath: string, conventionalRoot: string): string {
  if (filePath === conventionalRoot) return path.posix.basename(filePath);
  if (filePath.startsWith(`${conventionalRoot}/`)) {
    return filePath.slice(conventionalRoot.length + 1);
  }
  return filePath;
}

/** Claude's conventional hidden command directory is not part of a command name. */
function commandLogicalName(filePath: string): string {
  const relative = relativeComponentPath(filePath, "commands").replace(/\.md$/i, "");
  return relative.replace(/^\.claude\/commands\//, "");
}

function flattenedName(pluginSlug: string, logicalName: string): string {
  const stem = withoutTerminalExtension(logicalName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => slugify(part))
    .join(".");
  const base = [pluginSlug, stem || "component"].filter(Boolean).join(".");
  if (base.length <= 125) return base;
  return `${base.slice(0, 108).replace(/[.-]+$/, "")}-${shortHash(base)}`;
}

function flattenedSkillName(pluginSlug: string, logicalName: string): string {
  const normalizedLogicalName = withoutTerminalExtension(logicalName)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[^.]+$/, "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .join("-");
  const base = `${pluginSlug}-${normalizedLogicalName || "skill"}`
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "") || "claude-plugin-skill";
  if (base.length <= 64) return base;
  return `${base.slice(0, 55).replace(/-+$/g, "")}-${shortHash(base)}`;
}

/** Strip only a basename extension; hidden directory names are path segments, not extensions. */
function withoutTerminalExtension(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const extension = path.posix.extname(normalized);
  return extension ? normalized.slice(0, -extension.length) : normalized;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]{2,}/g, "-");
  return (slug || "claude-plugin").slice(0, 64).replace(/[._-]+$/g, "") || "claude-plugin";
}

function shortHash(value: string): string {
  // Deterministic FNV-1a is sufficient for filename disambiguation and avoids
  // coupling generated resource names to platform crypto availability.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mapSkillFrontmatter(
  source: UnknownRecord,
  pluginSlug: string,
  issues: IssueRecorder,
  sourcePath: string,
): UnknownRecord {
  const output: UnknownRecord = {};
  const direct = [
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "disable-model-invocation",
  ];
  for (const key of direct) if (source[key] !== undefined) output[key] = source[key];
  if (readString(output.description) === undefined) {
    output.description = `Converted Claude skill from ${sourcePath}`;
    issues.add("skills", "approximated", "Synthesized the description required for Pi skill discovery", {
      source: sourcePath,
    });
  }
  const tools = readToolList(source["allowed-tools"] ?? source.allowedTools);
  if (tools.length > 0) {
    const mappedTools = tools
      .map((tool): string | undefined => {
        const mapped = mapTool(tool, pluginSlug);
        if (mapped.status !== "converted") {
          issues.add("skills", mapped.status, mapped.message, { source: sourcePath, detail: tool });
        }
        if (mapped.mcpAllow) {
          issues.add(
            "skills",
            "approximated",
            "Omitted MCP proxy from skill pre-approval because Pi cannot enforce a per-skill server/tool policy",
            { source: sourcePath, detail: mapped.mcpAllow },
          );
          return undefined;
        }
        return mapped.target;
      })
      .filter((tool): tool is string => tool !== undefined);
    if (mappedTools.length > 0) output["allowed-tools"] = mappedTools
      .join(" ");
  }
  const unsupported = [
    "user-invocable",
    "argument-hint",
    "context",
    "agent",
    "hooks",
  ];
  for (const key of unsupported) {
    if (source[key] !== undefined) {
      issues.add("skills", "preserved", `Preserved unsupported Claude skill field: ${key}`, {
        source: sourcePath,
        detail: { [key]: source[key] },
      });
    }
  }
  if (source.model !== undefined) {
    issues.add("skills", "approximated", "Skill-level model selection is applied at invocation time", {
      source: sourcePath,
    });
    output.metadata = {
      ...(isRecord(output.metadata) ? output.metadata : {}),
      "claude-pi-convert/model": source.model,
    };
  }
  const knownSkillFields = new Set([
    ...direct,
    "allowed-tools",
    "allowedTools",
    ...unsupported,
    "model",
  ]);
  for (const key of Object.keys(source)) {
    if (!knownSkillFields.has(key)) {
      issues.add("skills", "preserved", `Preserved unrecognized skill frontmatter field: ${key}`, {
        source: sourcePath,
        detail: { [key]: source[key] },
      });
    }
  }
  return output;
}

function convertAgent(
  entry: TreeEntry,
  pluginSlug: string,
  agentNameMap: ReadonlyMap<string, string>,
  skillNameMap: ReadonlyMap<string, string>,
  issues: IssueRecorder,
): AgentSpec {
  const parsed = parseFrontmatter(entry.content.toString(), entry.path);
  const source = parsed.attributes;
  const toolsWereSpecified = source.tools !== undefined;
  const logicalName = relativeComponentPath(entry.path, "agents").replace(/\.md$/i, "");
  const name = agentNameMap.get(logicalName) ?? flattenedName(pluginSlug, logicalName);
  const output: UnknownRecord = { name };
  const mcpAllow: string[] = [];
  const requiredExtensions = new Set<string>();

  const declaredName = readString(source.name);
  if (declaredName && declaredName !== name) {
    issues.add(
      "agents",
      "approximated",
      `Renamed agent ${declaredName} to the collision-safe Pi name ${name}`,
      { source: entry.path, target: `.pi/agents/${name}.md` },
    );
  }

  if (source.description !== undefined) output.description = source.description;
  const tools = readToolList(source.tools);
  if (tools.length > 0) {
    const mappedTools: string[] = [];
    for (const tool of tools) {
      const mapped = mapAgentTool(tool, pluginSlug);
      if (!mapped) {
        issues.add("agents", "unsupported", `Dropped unsupported nested delegation tool ${tool}`, {
          source: entry.path,
        });
        continue;
      }
      if (!mappedTools.includes(mapped.target)) mappedTools.push(mapped.target);
      if (mapped.mcpAllow) mcpAllow.push(mapped.mcpAllow);
      if (mapped.target.startsWith("ext:pi-mcp-adapter/")) {
        requiredExtensions.add("pi-mcp-adapter");
      }
      if (mapped.target.startsWith("ext:pi-web-access/")) {
        requiredExtensions.add("pi-web-access");
      }
      if (mapped.status !== "converted") {
        issues.add("agents", mapped.status, mapped.message, { source: entry.path, detail: tool });
      }
    }
    output.tools = mappedTools.length > 0 ? mappedTools.join(",") : "none";
  } else if (toolsWereSpecified) {
    // An explicitly empty Claude tool list means no tools. Leaving the field
    // absent would make pi-subagents fall back to its built-in tool set and
    // silently widen the agent's authority.
    output.tools = "none";
  }
  const disallowed = readToolList(source.disallowedTools ?? source.disallowed_tools);
  if (disallowed.length > 0) {
    const mappedDisallowed = disallowed
      .map((tool) => mapAgentTool(tool, pluginSlug)?.target)
      // pi-subagents compares disallowed_tools against registered tool names,
      // not the extension-qualified allow-list syntax.
      .map((tool) => tool?.replace(/^ext:[^/]+\//, ""))
      .filter((tool): tool is string => tool !== undefined);
    if (mappedDisallowed.length > 0) output.disallowed_tools = mappedDisallowed.join(",");
  }
  if (source.model !== undefined && source.model !== "inherit") output.model = source.model;
  if (source.maxTurns !== undefined || source.max_turns !== undefined) {
    output.max_turns = source.maxTurns ?? source.max_turns;
    issues.add("agents", "approximated", "Mapped Claude turn limit to pi-subagents max_turns", {
      source: entry.path,
    });
  }
  if (source.effort !== undefined || source.thinking !== undefined) {
    output.thinking = source.effort ?? source.thinking;
    issues.add("agents", "approximated", "Mapped Claude effort to pi-subagents thinking", {
      source: entry.path,
    });
  }
  if (source.skills !== undefined) {
    const skills = readToolList(source.skills);
    if (skills.length > 0) {
      output.skills = skills
        .map((skill) => {
          const mapped = skillNameMap.get(skill);
          if (!mapped) {
            issues.add("agents", "preserved", `Agent references an unresolved skill: ${skill}`, {
              source: entry.path,
            });
          }
          return mapped ?? skill;
        })
        .join(",");
    }
  }
  if (source.memory !== undefined) {
    output.memory = source.memory;
    issues.add("agents", "approximated", "Memory uses pi-subagents scope and write semantics", {
      source: entry.path,
    });
  }
  if (source.background !== undefined || source.runInBackground !== undefined) {
    output.run_in_background = source.background ?? source.runInBackground;
  }
  if (source.isolation !== undefined) {
    output.isolation = source.isolation;
    issues.add("agents", "approximated", "Worktree isolation follows pi-subagents commit behavior", {
      source: entry.path,
    });
  }
  for (const key of ["permissionMode", "permission-mode", "nested", "nestedAgents"]) {
    if (source[key] !== undefined) {
      issues.add("agents", "unsupported", `pi-subagents does not exactly support ${key}`, {
        source: entry.path,
        detail: { [key]: source[key] },
      });
    }
  }
  const known = new Set([
    "name",
    "description",
    "tools",
    "disallowedTools",
    "disallowed_tools",
    "model",
    "maxTurns",
    "max_turns",
    "effort",
    "thinking",
    "skills",
    "memory",
    "background",
    "runInBackground",
    "isolation",
    "permissionMode",
    "permission-mode",
    "nested",
    "nestedAgents",
  ]);
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      issues.add("agents", "preserved", `Preserved unrecognized agent frontmatter field: ${key}`, {
        source: entry.path,
      });
    }
  }

  if (mcpAllow.length > 0) {
    const toolsCsv = typeof output.tools === "string" && output.tools ? output.tools.split(",") : [];
    toolsCsv.push(`ext:agent-guard/${agentPolicySentinel(name)}`);
    output.tools = [...new Set(toolsCsv)].join(",");
    requiredExtensions.add("agent-guard");
  }
  if (toolsWereSpecified) {
    // Explicit pi-subagents extension filtering would otherwise prevent this
    // package's generated hook bridge from running inside the child agent.
    requiredExtensions.add("main");
    output.extensions = requiredExtensions.size > 0
      ? [...requiredExtensions].sort().join(",")
      : false;
  }

  const body = transformAgentReferences(transformReferences(parsed.body, pluginSlug), agentNameMap);
  issues.add("agents", "converted", "Converted Claude agent to pi-subagents format", {
    source: entry.path,
    target: `.pi/agents/${name}.md`,
  });
  return {
    name,
    source: entry.path,
    targetFile: `${name}.md`,
    content: stringifyFrontmatter(output, body),
    mcpAllow: [...new Set(mcpAllow)].sort(),
  };
}

function mapAgentTool(
  sourceTool: string,
  pluginSlug: string,
):
  | {
      target: string;
      status: ConversionStatus;
      message: string;
      mcpAllow?: string;
      web?: boolean;
    }
  | undefined {
  const trimmed = sourceTool.trim();
  const qualifierAt = trimmed.indexOf("(");
  const base = qualifierAt >= 0 ? trimmed.slice(0, qualifierAt) : trimmed;
  const qualifier = qualifierAt >= 0 ? trimmed.slice(qualifierAt) : "";
  if (base === "Task" || base === "Agent") return undefined;
  const mcp = parseMcpToolReference(base, pluginSlug);
  if (mcp) {
    const { server, tool } = mcp;
    return {
      target: "ext:pi-mcp-adapter/mcp",
      status: "approximated",
      message: "Mapped a Claude MCP tool to the guarded pi-mcp-adapter extension tool",
      mcpAllow: `${pluginSlug}-${slugify(server)}/${tool}`,
    };
  }
  if (base === "WebSearch") {
    return {
      target: "ext:pi-web-access/web_search",
      status: qualifier ? "approximated" : "converted",
      message: qualifier
        ? "Mapped WebSearch but dropped its unsupported invocation qualifier"
        : "Mapped WebSearch to the pi-web-access extension tool",
      web: true,
    };
  }
  if (base === "WebFetch") {
    return {
      target: "ext:pi-web-access/fetch_content",
      status: qualifier ? "approximated" : "converted",
      message: qualifier
        ? "Mapped WebFetch but dropped its unsupported invocation qualifier"
        : "Mapped WebFetch to the pi-web-access extension tool",
      web: true,
    };
  }
  if (base === "get_search_content") {
    return {
      target: "ext:pi-web-access/get_search_content",
      status: qualifier ? "approximated" : "converted",
      message: qualifier
        ? "Kept search result retrieval but dropped its unsupported invocation qualifier"
        : "Kept pi-web-access search result retrieval",
      web: true,
    };
  }
  return mapTool(sourceTool, pluginSlug);
}

function mapTool(
  sourceTool: string,
  pluginSlug: string,
): { target: string; status: ConversionStatus; message: string; mcpAllow?: string } {
  const trimmed = sourceTool.trim();
  const qualifierAt = trimmed.indexOf("(");
  const base = qualifierAt >= 0 ? trimmed.slice(0, qualifierAt) : trimmed;
  const qualifier = qualifierAt >= 0 ? trimmed.slice(qualifierAt) : "";
  const mcp = parseMcpToolReference(base, pluginSlug);
  if (mcp) {
    const { server, tool } = mcp;
    return {
      target: "mcp",
      status: "approximated",
      message: "Mapped a Claude MCP tool to the guarded pi-mcp-adapter proxy",
      mcpAllow: `${pluginSlug}-${slugify(server)}/${tool}`,
    };
  }
  const exact = EXACT_TOOL_MAP[base];
  if (exact) {
    return {
      target: exact,
      status: qualifier ? "approximated" : "converted",
      message: qualifier
        ? `Mapped ${base} to ${exact} but dropped its unsupported fine-grained qualifier`
        : `Mapped ${base} to ${exact}`,
    };
  }
  const approximate = APPROXIMATE_TOOL_MAP[base];
  if (approximate) {
    return {
      target: approximate,
      status: "approximated",
      message: `Mapped ${base} to pi-subagents ${approximate}`,
    };
  }
  return { target: trimmed, status: "preserved", message: `Preserved unknown tool ${base}` };
}

function transformReferences(content: string, pluginSlug: string): string {
  let output = replaceUserConfigReferences(content, pluginSlug) as string;
  output = output
    .replaceAll(
      "${CLAUDE_PLUGIN_ROOT}",
      `.pi/claude-pi-convert/${pluginSlug}/runtime/original`,
    )
    .replaceAll(
      "${CLAUDE_PLUGIN_DATA}",
      `.pi/claude-pi-convert/${pluginSlug}/runtime/data`,
    )
    .replaceAll("${CLAUDE_PROJECT_DIR}", ".");
  for (const [source, target] of Object.entries(EXACT_TOOL_MAP)) {
    if (source === "WebSearch" || source === "WebFetch") {
      output = output.replace(new RegExp(`\\b${escapeRegExp(source)}\\b`, "g"), target);
    } else {
      output = output.replace(new RegExp(`\`${escapeRegExp(source)}\``, "g"), `\`${target}\``);
    }
  }
  for (const [source, target] of Object.entries(APPROXIMATE_TOOL_MAP)) {
    output = output.replace(new RegExp(`\`${escapeRegExp(source)}\``, "g"), `\`${target}\``);
  }
  output = output.replace(
    /\bmcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)\b/g,
    (match) => {
      const parsed = parseMcpToolReference(match, pluginSlug);
      return parsed ? `mcp (${pluginSlug}-${slugify(parsed.server)}/${parsed.tool})` : match;
    },
  );
  if (/\b(?:web_search|fetch_content)\b/.test(output)) {
    output +=
      "\n\n<!-- claude-pi-convert: use pi-web-access with workflow: \"none\" for Claude-compatible direct web operations. -->\n";
  }
  return output;
}

function transformAgentReferences(
  content: string,
  agentNameMap: ReadonlyMap<string, string>,
): string {
  let output = content;
  const mappings = [...agentNameMap.entries()].sort(([left], [right]) => right.length - left.length);
  for (const [source, target] of mappings) {
    output = output.replace(
      new RegExp(`(?<![A-Za-z0-9_.\\/-])${escapeRegExp(source)}(?![A-Za-z0-9_.\\/-])`, "g"),
      target,
    );
  }
  return output;
}

function replaceUserConfigReferences(value: unknown, pluginSlug: string): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{user_config\.([A-Za-z_][A-Za-z0-9_.-]*)\}/gi,
      (_match, key: string) => `\${${userConfigEnvName(pluginSlug, key)}}`,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceUserConfigReferences(item, pluginSlug));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        replaceUserConfigReferences(child, pluginSlug),
      ]),
    );
  }
  return value;
}

function userConfigEnvName(pluginSlug: string, key: string): string {
  void pluginSlug;
  return `CLAUDE_PLUGIN_OPTION_${envName(key)}`;
}

function parseMcpToolReference(
  value: string,
  pluginSlug: string,
): { server: string; tool: string } | undefined {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_*?-]+)$/.exec(value);
  if (!match) return undefined;
  let server = match[1] ?? "server";
  const tool = match[2] ?? "*";
  const scopedPrefix = `plugin_${pluginSlug.replace(/[-.]+/g, "_")}_`;
  if (server.toLocaleLowerCase("en-US").startsWith(scopedPrefix.toLocaleLowerCase("en-US"))) {
    server = server.slice(scopedPrefix.length) || "server";
  }
  return { server, tool };
}

function usesWebTools(content: string): boolean {
  return /\b(?:WebSearch|WebFetch|web_search|fetch_content)\b/.test(content);
}

function usesSubagentTools(content: string): boolean {
  return /\b(?:Task|Agent)\b/.test(content);
}

function usesDynamicShellExpansion(content: string): boolean {
  return /(?:^|\n)[ \t]*!`[^`\r\n]+`/.test(content) ||
    /(?:^|\n)[ \t]*`{3,}!/.test(content);
}

function readToolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  return value
    .split(/,(?![^()]*\))|\s+(?![^()]*\))/)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function convertHooks(
  index: SourceIndex,
  manifest: UnknownRecord,
  pluginSlug: string,
  agentNameMap: ReadonlyMap<string, string>,
  issues: IssueRecorder,
): HookConversion {
  const sources: Array<{ source: string; value: unknown }> = [];
  if (isRecord(manifest.hooks)) sources.push({ source: "plugin manifest hooks", value: manifest.hooks });
  for (const configuredPath of declaredPaths(manifest.hooks, "hooks", issues)) {
    const entry = index.byPath.get(configuredPath);
    if (entry) sources.push({ source: entry.path, value: parseEntry(entry) });
  }
  for (const candidate of ["hooks/hooks.json", "hooks/hooks.jsonc", "hooks.json", "hooks.jsonc"]) {
    const entry = index.byPath.get(candidate);
    if (entry) sources.push({ source: entry.path, value: parseEntry(entry) });
  }
  if (sources.length === 0) return { hooks: [], found: false, needsSubagents: false };

  const convertedHooks: RuntimeHookSpec[] = [];
  let needsSubagents = false;
  for (const source of dedupeConfigSources(sources)) {
    const record = asRecord(source.value, source.source);
    const hooks = isRecord(record.hooks) ? record.hooks : record;
    for (const [event, handlers] of Object.entries(hooks)) {
      const status: ConversionStatus = DIRECT_HOOK_EVENTS.has(event)
        ? "converted"
        : APPROXIMATE_HOOK_EVENTS.has(event)
          ? "approximated"
          : UNSUPPORTED_HOOK_EVENTS.has(event)
            ? "unsupported"
            : "preserved";
      if (["SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"].includes(event)) {
        needsSubagents = true;
      }
      issues.add(
        "hooks",
        status,
        hookStatusMessage(event, status),
        { source: source.source },
      );
      if (status !== "unsupported") {
        const normalized = normalizeHookBlocks(
          event,
          handlers,
          pluginSlug,
          agentNameMap,
          source.source,
          issues,
        );
        convertedHooks.push(...normalized.hooks);
        needsSubagents ||= normalized.needsSubagents;
      }
    }
  }
  return { hooks: mergeRuntimeHooks(convertedHooks), found: true, needsSubagents };
}

function hookStatusMessage(event: string, status: ConversionStatus): string {
  if (status === "converted") return `Mapped ${event} to a direct Pi extension event`;
  if (status === "approximated") return `Mapped ${event} using Pi aggregation, UI, watcher, or subagent events`;
  if (status === "unsupported") return `Pi has no safe equivalent for ${event}`;
  return `Preserved unrecognized Claude hook event ${event}`;
}

function normalizeHookBlocks(
  event: string,
  value: unknown,
  pluginSlug: string,
  agentNameMap: ReadonlyMap<string, string>,
  source: string,
  issues: IssueRecorder,
): { hooks: RuntimeHookSpec[]; needsSubagents: boolean } {
  const blocks = Array.isArray(value) ? value : [value];
  const hooks: RuntimeHookSpec[] = [];
  let needsSubagents = false;
  for (const blockValue of blocks) {
    if (!isRecord(blockValue)) {
      issues.add("hooks", "preserved", "Ignored a non-object hook matcher block", {
        source,
        detail: blockValue,
      });
      continue;
    }
    const rawMatcher = readString(blockValue.matcher);
    const rawHandlers = blockValue.hooks ?? blockValue.handlers ?? blockValue;
    if (rawHandlers !== blockValue) {
      for (const key of Object.keys(blockValue)) {
        if (!["matcher", "hooks", "handlers"].includes(key)) {
          issues.add("hooks", "preserved", `Preserved unrecognized hook block field: ${key}`, {
            source,
            detail: { [key]: blockValue[key] },
          });
        }
      }
    }
    const handlerValues = Array.isArray(rawHandlers) ? rawHandlers : [rawHandlers];
    const normalizedHandlers: RuntimeHookHandlerSpec[] = [];
    for (const rawHandler of handlerValues) {
      const handler = normalizeHookHandler(rawHandler, pluginSlug, agentNameMap, source, issues);
      if (!handler) continue;
      normalizedHandlers.push(handler);
      needsSubagents ||= handler.type === "agent";
    }
    if (normalizedHandlers.length === 0) continue;
    for (const matcher of normalizeHookMatchers(rawMatcher, pluginSlug, event, agentNameMap)) {
      hooks.push({ event, ...matcher, handlers: [...normalizedHandlers] });
    }
  }
  return { hooks, needsSubagents };
}

function normalizeHookMatchers(
  rawMatcher: string | undefined,
  pluginSlug: string,
  event: string,
  agentNameMap: ReadonlyMap<string, string>,
): Array<Pick<RuntimeHookSpec, "matcher" | "mcpMatcher">> {
  if (!rawMatcher) return [{}];
  const alternatives = rawMatcher.split("|").map((part) => part.trim()).filter(Boolean);
  const canSplitLiteralAlternatives = alternatives.length > 1 && alternatives.every((part) =>
    parseMcpToolReference(part, pluginSlug) !== undefined || /^[A-Za-z0-9_*?-]+$/.test(part)
  );
  const candidates = canSplitLiteralAlternatives ? alternatives : [rawMatcher];
  return candidates.map((candidate) => {
    const mcp = parseMcpToolReference(candidate, pluginSlug);
    if (mcp) {
      return {
        mcpMatcher: {
          server: `${pluginSlug}-${slugify(mcp.server)}`,
          tool: mcp.tool,
        },
      };
    }
    const lifecycleMatcher = ["SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"].includes(event)
      ? mapAgentReference(candidate, agentNameMap)
      : candidate;
    return { matcher: transformHookMatcher(lifecycleMatcher) };
  });
}

function transformHookMatcher(matcher: string): string {
  // The generated hook runtime reconstructs Claude names for built-in Pi
  // tools. MCP is the exception because the adapter exposes one proxy tool.
  return matcher.replace(/\bmcp__[A-Za-z0-9_-]+__[A-Za-z0-9_*?-]+\b/g, "mcp");
}

function normalizeHookHandler(
  value: unknown,
  pluginSlug: string,
  agentNameMap: ReadonlyMap<string, string>,
  source: string,
  issues: IssueRecorder,
): RuntimeHookHandlerSpec | undefined {
  if (!isRecord(value)) {
    issues.add("hooks", "preserved", "Ignored a non-object hook handler", { source, detail: value });
    return undefined;
  }
  if (value.if !== undefined) {
    issues.add(
      "hooks",
      "unsupported",
      "Preserved a conditional hook handler because running it without its Claude permission-rule filter would broaden side effects",
      { source, detail: { if: value.if } },
    );
    return undefined;
  }
  const inferredType = value.command !== undefined ? "command" : value.prompt !== undefined ? "prompt" : undefined;
  const type = readString(value.type) ?? inferredType;
  if (type === "mcp_tool") {
    issues.add(
      "hooks",
      "unsupported",
      "Preserved MCP hook handler because pi-mcp-adapter has no public programmatic hook API",
      { source },
    );
    return undefined;
  }
  if (type !== "command" && type !== "prompt" && type !== "agent" && type !== "http") {
    issues.add("hooks", "unsupported", `Unsupported Claude hook handler type: ${type ?? "unknown"}`, {
      source,
    });
    return undefined;
  }
  const knownHandlerFields = new Set([
    "type",
    "command",
    "args",
    "prompt",
    "url",
    "method",
    "headers",
    "timeout",
    "timeoutMs",
    "cwd",
    "env",
    "async",
    "agentType",
    "agent",
    "description",
    "model",
  ]);
  for (const key of Object.keys(value)) {
    if (!knownHandlerFields.has(key)) {
      issues.add("hooks", "preserved", `Preserved unrecognized hook handler field: ${key}`, {
        source,
        detail: { [key]: value[key] },
      });
    }
  }
  const timeoutMs = normalizeTimeout(value.timeoutMs, value.timeout);
  const env = readStringRecord(value.env);
  if (type === "http") {
    const url = readString(value.url);
    if (!url) {
      issues.add("hooks", "preserved", "HTTP hook is missing url", { source });
      return undefined;
    }
    const headers = readStringRecord(value.headers);
    return {
      type,
      url,
      ...(readString(value.method) !== undefined
        ? { method: (readString(value.method) as string).toLocaleUpperCase("en-US") }
        : {}),
      ...(headers ? { headers } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(typeof value.async === "boolean" ? { async: value.async } : {}),
    };
  }
  if (type === "command") {
    const command = readString(value.command);
    if (!command) {
      issues.add("hooks", "preserved", "Command hook is missing command", { source });
      return undefined;
    }
    const args = readStringArray(value.args);
    return {
      type,
      command,
      ...(args.length > 0 ? { args, shell: false } : { shell: true }),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(readString(value.cwd) !== undefined ? { cwd: readString(value.cwd) as string } : {}),
      ...(env ? { env } : {}),
      ...(typeof value.async === "boolean" ? { async: value.async } : {}),
    };
  }
  const prompt = readString(value.prompt);
  if (!prompt) {
    issues.add("hooks", "preserved", `${type} hook is missing prompt`, { source });
    return undefined;
  }
  if (type === "prompt") {
    return {
      type,
      prompt: transformAgentReferences(transformReferences(prompt, pluginSlug), agentNameMap),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(readString(value.model) !== undefined ? { model: readString(value.model) as string } : {}),
    };
  }
  return {
    type,
    prompt: transformAgentReferences(transformReferences(prompt, pluginSlug), agentNameMap),
    ...(readString(value.agentType ?? value.agent) !== undefined
      ? {
          agentType: mapAgentReference(
            readString(value.agentType ?? value.agent) as string,
            agentNameMap,
          ),
        }
      : {}),
    ...(readString(value.description) !== undefined
      ? { description: readString(value.description) as string }
      : {}),
    ...(readString(value.model) !== undefined ? { model: readString(value.model) as string } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function mapAgentReference(
  source: string,
  agentNameMap: ReadonlyMap<string, string>,
): string {
  const normalized = source.replace(/^\.\//, "").replace(/^agents\//, "").replace(/\.md$/i, "");
  return agentNameMap.get(source) ?? agentNameMap.get(normalized) ?? source;
}

function mergeRuntimeHooks(hooks: readonly RuntimeHookSpec[]): RuntimeHookSpec[] {
  const merged = new Map<string, RuntimeHookSpec>();
  for (const hook of hooks) {
    const key = `${hook.event}\0${hook.matcher ?? ""}\0${JSON.stringify(hook.mcpMatcher ?? null)}`;
    const previous = merged.get(key);
    if (previous) previous.handlers.push(...hook.handlers);
    else merged.set(key, { ...hook, handlers: [...hook.handlers] });
  }
  return [...merged.values()];
}

function convertMcp(
  index: SourceIndex,
  manifest: UnknownRecord,
  pluginSlug: string,
  pluginId: string,
  includeSecrets: boolean,
  issues: IssueRecorder,
): McpConversion {
  const sources: Array<{ source: string; value: unknown }> = [];
  if (isRecord(manifest.mcpServers)) {
    sources.push({ source: "plugin manifest mcpServers", value: { mcpServers: manifest.mcpServers } });
  }
  for (const configuredPath of declaredPaths(manifest.mcpServers, "mcp", issues)) {
    const entry = index.byPath.get(configuredPath);
    if (entry) sources.push({ source: entry.path, value: parseEntry(entry) });
    else issues.add("mcp", "preserved", "Configured MCP file was not found", { source: configuredPath });
  }
  for (const candidate of [".mcp.json", ".mcp.jsonc", "mcp.json", "mcp.jsonc"]) {
    const entry = index.byPath.get(candidate);
    if (entry) sources.push({ source: entry.path, value: parseEntry(entry) });
  }
  if (sources.length === 0) {
    return { config: undefined, launchers: [], envExample: [], found: false };
  }

  const servers: UnknownRecord = {};
  const topLevel: UnknownRecord = {};
  const launchers: McpLauncherServer[] = [];
  const envExample = new Set<string>();
  for (const source of dedupeConfigSources(sources)) {
    const record = asRecord(source.value, source.source);
    if (isRecord(record.mcpServers)) {
      for (const [key, value] of Object.entries(record)) {
        if (key === "mcpServers" || key === "$schema") continue;
        if (topLevel[key] !== undefined && JSON.stringify(topLevel[key]) !== JSON.stringify(value)) {
          issues.add("mcp", "preserved", `Conflicting top-level MCP setting was not overwritten: ${key}`, {
            source: source.source,
          });
          continue;
        }
        topLevel[key] = value;
      }
    }
    const rawServers = isRecord(record.mcpServers) ? record.mcpServers : record;
    for (const [rawName, rawConfig] of Object.entries(rawServers)) {
      if (!isRecord(rawConfig)) {
        issues.add("mcp", "unsupported", "MCP server configuration must be an object", {
          source: source.source,
          detail: rawName,
        });
        continue;
      }
      const name = `${pluginSlug}-${slugify(rawName)}`;
      if (isWebSocketMcp(rawConfig)) {
        issues.add("mcp", "unsupported", "pi-mcp-adapter does not support WebSocket transport", {
          source: source.source,
          detail: rawName,
        });
        continue;
      }
      const envExampleCount = envExample.size;
      const referencedConfig = replaceUserConfigReferences(rawConfig, pluginSlug) as UnknownRecord;
      let config = redactSecrets(
        referencedConfig,
        `${pluginSlug}_${rawName}`,
        includeSecrets,
        envExample,
      );
      if (envExample.size > envExampleCount) {
        issues.add("mcp", "approximated", "Replaced literal MCP secrets with environment references", {
          source: source.source,
          detail: rawName,
        });
      }
      if (usesClaudeRuntimePath(config)) {
        const command = readString(config.command);
        if (!command) {
          issues.add("mcp", "unsupported", "Claude runtime path variables require a stdio MCP command", {
            source: source.source,
            detail: rawName,
          });
          continue;
        }
        const args = Array.isArray(config.args)
          ? config.args.filter((item): item is string => typeof item === "string")
          : [];
        const launcher: McpLauncherServer = { name, command, args };
        const cwd = readString(config.cwd);
        if (cwd !== undefined) launcher.cwd = cwd;
        const env = readStringRecord(config.env);
        if (env) launcher.env = env;
        launchers.push(launcher);
        config = {
          ...config,
          command: "node",
          args: [
            `.pi/claude-pi-convert/${pluginId}/runtime/mcp-launcher.mjs`,
            name,
          ],
        };
        delete config.cwd;
        issues.add("mcp", "approximated", "Generated a relocatable launcher for Claude runtime path variables", {
          source: source.source,
          target: "activation/runtime/mcp-launcher.mjs",
          detail: rawName,
        });
      } else {
        issues.add("mcp", "converted", "Converted and namespaced MCP server configuration", {
          source: source.source,
          target: `.pi/mcp.json#mcpServers.${name}`,
        });
      }
      if (servers[name] !== undefined && JSON.stringify(servers[name]) !== JSON.stringify(config)) {
        issues.add("mcp", "unsupported", "Conflicting MCP server definitions have the same name", {
          source: source.source,
          detail: rawName,
        });
        continue;
      }
      servers[name] = config;
    }
  }
  const safeTopLevel = includeSecrets
    ? topLevel
    : redactSecrets(topLevel, `${pluginSlug}_mcp`, false, envExample);
  return {
    config: { ...safeTopLevel, mcpServers: servers },
    launchers,
    envExample: [...envExample],
    found: true,
  };
}

function isWebSocketMcp(config: UnknownRecord): boolean {
  const type = readString(config.type)?.toLocaleLowerCase("en-US");
  const url = readString(config.url)?.toLocaleLowerCase("en-US");
  return type === "ws" || type === "websocket" || url?.startsWith("ws:") === true || url?.startsWith("wss:") === true;
}

function usesClaudeRuntimePath(value: unknown): boolean {
  if (typeof value === "string") {
    return /\$\{CLAUDE_(?:PLUGIN_ROOT|PLUGIN_DATA|PROJECT_DIR)\}/.test(value);
  }
  if (Array.isArray(value)) return value.some(usesClaudeRuntimePath);
  if (isRecord(value)) return Object.values(value).some(usesClaudeRuntimePath);
  return false;
}

function redactSecrets(
  value: UnknownRecord,
  prefix: string,
  includeSecrets: boolean,
  examples: Set<string>,
): UnknownRecord {
  if (includeSecrets) return structuredClone(value) as UnknownRecord;

  function placeholder(pathParts: string[], label: string): string {
    const variable = envName([prefix, ...pathParts, label].join("_"));
    examples.add(`${variable}=`);
    return `\${${variable}}`;
  }

  function secretFlagName(value: string): string | undefined {
    const match = /^--?([^=]+)(?:=(.*))?$/.exec(value);
    if (!match || !isSecretKey(match[1] ?? "")) return undefined;
    return match[1];
  }

  function redactArgumentList(items: unknown[], pathParts: string[]): unknown[] {
    const result = [...items];
    for (let index = 0; index < result.length; index += 1) {
      const item = result[index];
      if (typeof item !== "string") {
        result[index] = visit(item, [...pathParts, String(index)]);
        continue;
      }
      const flagName = secretFlagName(item);
      if (flagName) {
        const equalsAt = item.indexOf("=");
        if (equalsAt >= 0) {
          const literal = item.slice(equalsAt + 1);
          if (literal && !isEnvironmentReference(literal)) {
            result[index] = `${item.slice(0, equalsAt + 1)}${placeholder(
              [...pathParts, String(index)],
              flagName,
            )}`;
          }
        } else {
          const next = result[index + 1];
          if (typeof next === "string" && !isEnvironmentReference(next)) {
            result[index + 1] = placeholder(
              [...pathParts, String(index + 1)],
              flagName,
            );
            index += 1;
          }
        }
        continue;
      }
      if (containsUrlCredentials(item) || looksLikeSecretLiteral(item)) {
        result[index] = placeholder([...pathParts, String(index)], "secret");
      }
    }
    return result;
  }

  function visit(child: unknown, pathParts: string[]): unknown {
    if (Array.isArray(child)) {
      return pathParts.at(-1)?.toLocaleLowerCase("en-US") === "args"
        ? redactArgumentList(child, pathParts)
        : child.map((item, index) =>
            typeof item === "string" &&
            !isEnvironmentReference(item) &&
            (containsUrlCredentials(item) || looksLikeSecretLiteral(item))
              ? placeholder([...pathParts, String(index)], "secret")
              : visit(item, [...pathParts, String(index)])
          );
    }
    if (!isRecord(child)) return child;
    const result: UnknownRecord = {};
    const parentKey = pathParts.at(-1) ?? "";
    const sensitiveRecord = child.sensitive === true || child.secret === true || isSecretKey(parentKey);
    for (const [key, nested] of Object.entries(child)) {
      if (
        typeof nested === "string" &&
        !isEnvironmentReference(nested) &&
        (isSecretKey(key) || (sensitiveRecord && /^(?:default|value|example)$/i.test(key)))
      ) {
        result[key] = placeholder(pathParts, key);
      } else if (
        typeof nested === "string" &&
        !isEnvironmentReference(nested) &&
        (containsUrlCredentials(nested) || looksLikeSecretLiteral(nested))
      ) {
        result[key] = placeholder(pathParts, key || "secret");
      } else {
        result[key] = visit(nested, [...pathParts, key]);
      }
    }
    return result;
  }
  return visit(value, []) as UnknownRecord;
}

function isSecretScannableText(filePath: string, content: Uint8Array): boolean {
  if (content.includes(0)) return false;
  void filePath;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function redactPlainTextSecrets(
  content: string,
  prefix: string,
  examples: Set<string>,
): string {
  let sequence = 0;
  const placeholder = (label: string): string => {
    sequence += 1;
    const variable = envName(`${prefix}_${label}_${sequence}`);
    examples.add(`${variable}=`);
    return `\${${variable}}`;
  };
  let output = content.replace(
    /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)([^\r\n]*)$/gm,
    (match, start: string, key: string, separator: string, value: string) => {
      const trimmed = value.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (
        !trimmed ||
        isEnvironmentReference(trimmed) ||
        (!isSecretKey(key) && !containsUrlCredentials(trimmed) && !looksLikeSecretLiteral(trimmed))
      ) {
        return match;
      }
      return `${start}${key}${separator}${placeholder(key)}`;
    },
  );
  output = output.replace(
    /https?:\/\/[^\s'"<>]+/gi,
    (candidate) => containsUrlCredentials(candidate) ? placeholder("url") : candidate,
  );
  output = output.replace(
    /(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi,
    () => placeholder("secret"),
  );
  return output;
}

function redactPortableEntry(
  entry: TreeEntry,
  prefix: string,
  examples: Set<string>,
): string | Uint8Array {
  if (/\.(?:json|jsonc|yaml|yml)$/i.test(entry.path)) {
    try {
      const parsed = parseEntry(entry);
      const wrapper = redactSecrets({ value: parsed }, prefix, false, examples);
      return stringifyStructuredText(wrapper.value, path.posix.extname(entry.path));
    } catch {
      // Supporting files that are not valid structured data remain usable and
      // still receive the conservative plain-text scanner below.
    }
  }
  if (isSecretScannableText(entry.path, entry.content)) {
    return redactPlainTextSecrets(entry.content.toString(), prefix, examples);
  }
  return entry.content;
}

function redactGeneratedMarkdown(
  content: string,
  prefix: string,
  examples: Set<string>,
): string {
  const parsed = parseFrontmatter(content, `${prefix}.md`);
  const wrapper = redactSecrets(
    { frontmatter: parsed.attributes },
    `${prefix}_frontmatter`,
    false,
    examples,
  );
  const attributes = isRecord(wrapper.frontmatter) ? wrapper.frontmatter : {};
  const body = redactPlainTextSecrets(parsed.body, `${prefix}_body`, examples);
  return stringifyFrontmatter(attributes, body);
}

function redactEmbeddedTextSecrets(
  value: unknown,
  prefix: string,
  examples: Set<string>,
  pathParts: string[] = [],
): unknown {
  if (typeof value === "string") {
    return redactPlainTextSecrets(
      value,
      envName([prefix, ...pathParts].join("_")) || "CLAUDE_PI_RUNTIME",
      examples,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactEmbeddedTextSecrets(item, prefix, examples, [...pathParts, String(index)])
    );
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactEmbeddedTextSecrets(child, prefix, examples, [...pathParts, key]),
    ]),
  );
}

function sameTreeContent(left: string | Uint8Array, right: string | Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function isSecretKey(key: string): boolean {
  return /(?:token|secret|password|passwd|api[-_]?key|authorization|bearer|client[-_]?secret)/i.test(key);
}

function isEnvironmentReference(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) || /^\$env:[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function containsUrlCredentials(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    for (const [key, nested] of parsed.searchParams) {
      if (isSecretKey(key) && nested && !isEnvironmentReference(nested)) return true;
    }
  } catch {
    // An invalid URL will be handled as an ordinary string. We intentionally
    // avoid guessing because false positives can make commands unusable.
  }
  return false;
}

function looksLikeSecretLiteral(value: string): boolean {
  return /^(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.test(
    value.trim(),
  );
}

function containsSecretsDeep(value: unknown): boolean {
  if (typeof value === "string") {
    return containsUrlCredentials(value) || looksLikeSecretLiteral(value);
  }
  if (Array.isArray(value)) return value.some(containsSecretsDeep);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    (isSecretKey(key) && typeof child === "string" && !isEnvironmentReference(child)) ||
    containsSecretsDeep(child)
  );
}

function envName(value: string): string {
  return value.toLocaleUpperCase("en-US").replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function redactReportDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReportDetail);
  if (typeof value === "string") {
    let output = value.replace(
      /https?:\/\/[^\s'"<>]+/gi,
      (candidate) => containsUrlCredentials(candidate) ? "[redacted-url]" : candidate,
    );
    output = output.replace(
      /(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi,
      "[redacted]",
    );
    output = output.replace(
      /(\b(?:token|secret|password|passwd|api[-_]?key|authorization|bearer|client[-_]?secret)\s*=\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
    output = output.replace(
      /(--?(?:token|secret|password|passwd|api[-_]?key|authorization|bearer|client[-_]?secret)(?:=|\s+))[^\s]+/gi,
      "$1[redacted]",
    );
    return output;
  }
  if (!isRecord(value)) return value;
  const sensitiveRecord = value.sensitive === true || value.secret === true;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSecretKey(key) || (sensitiveRecord && /^(?:default|value|example)$/i.test(key))
        ? "[redacted]"
        : redactReportDetail(child),
    ]),
  );
}

function convertLspConfig(
  index: SourceIndex,
  manifestValue: unknown,
  issues: IssueRecorder,
): UnknownRecord | undefined {
  const configs: Array<{ source: string; value: UnknownRecord }> = [];
  for (const candidate of [".lsp.json", "lsp.json"]) {
    const entry = index.byPath.get(candidate);
    if (entry) configs.push({ source: entry.path, value: asRecord(parseEntry(entry), entry.path) });
  }
  if (isRecord(manifestValue)) {
    configs.push({ source: "plugin manifest lspServers", value: manifestValue });
  } else {
    for (const configured of declaredPaths(manifestValue, "lsp", issues)) {
      const entry = index.byPath.get(configured);
      if (!entry) {
        issues.add("lsp", "preserved", "Configured LSP component file was not found", {
          source: configured,
        });
        continue;
      }
      configs.push({ source: entry.path, value: asRecord(parseEntry(entry), entry.path) });
    }
  }
  if (configs.length === 0) return undefined;
  const merged: UnknownRecord = {};
  for (const config of dedupeConfigSources(configs)) {
    const servers = isRecord(config.value.lspServers) ? config.value.lspServers : config.value;
    for (const [name, server] of Object.entries(servers)) {
      if (merged[name] !== undefined && JSON.stringify(merged[name]) !== JSON.stringify(server)) {
        issues.add("lsp", "approximated", `Later LSP definition replaced an earlier server: ${name}`, {
          source: config.source,
        });
      }
      merged[name] = server;
    }
  }
  return merged;
}

function normalizeLspServers(
  config: UnknownRecord | undefined,
  issues: IssueRecorder,
): RuntimeLspServerSpec[] {
  if (!config) return [];
  const candidate = isRecord(config.lspServers) ? config.lspServers : config;
  const output: RuntimeLspServerSpec[] = [];
  for (const [name, rawValue] of Object.entries(candidate)) {
    if (!isRecord(rawValue)) {
      issues.add("lsp", "preserved", "Ignored a non-object LSP server definition", { detail: name });
      continue;
    }
    const command = readString(rawValue.command);
    if (!command) {
      issues.add("lsp", "unsupported", "LSP server is missing a stdio command", { detail: name });
      continue;
    }
    const transport = readString(rawValue.transport)?.toLocaleLowerCase("en-US");
    if (transport && transport !== "stdio") {
      issues.add("lsp", "unsupported", `Only stdio LSP transport is supported: ${name}`, {
        detail: transport,
      });
      continue;
    }
    const args = readStringArray(rawValue.args);
    const env = readStringRecord(rawValue.env);
    const explicitExtensions = readStringArray(rawValue.extensions);
    const declaredExtensionMap = readStringRecord(rawValue.extensionToLanguage);
    const legacyLanguageId = readString(rawValue.languageId);
    const extensionMap = declaredExtensionMap ?? (
      explicitExtensions.length > 0 && legacyLanguageId
        ? Object.fromEntries(explicitExtensions.map((extension) => [extension, legacyLanguageId]))
        : undefined
    );
    if (!extensionMap || Object.keys(extensionMap).length === 0) {
      issues.add(
        "lsp",
        "unsupported",
        `LSP server ${name} is missing the required extensionToLanguage mapping`,
      );
      continue;
    }
    if (!declaredExtensionMap) {
      issues.add(
        "lsp",
        "approximated",
        `Synthesized extensionToLanguage for legacy LSP server ${name}`,
      );
    }
    const extensions = Object.keys(extensionMap);
    const languageIds = [...new Set(Object.values(extensionMap))];
    const knownLspFields = new Set([
      "command",
      "args",
      "cwd",
      "env",
      "transport",
      "extensions",
      "extensionToLanguage",
      "languageId",
      "initializationOptions",
      "settings",
    ]);
    for (const key of Object.keys(rawValue)) {
      if (!knownLspFields.has(key)) {
        issues.add("lsp", "preserved", `Preserved unsupported LSP field: ${key}`, {
          detail: { server: name, value: rawValue[key] },
        });
      }
    }
    output.push({
      name: slugify(name),
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(readString(rawValue.cwd) !== undefined ? { cwd: readString(rawValue.cwd) as string } : {}),
      ...(env ? { env } : {}),
      extensions,
      extensionToLanguage: extensionMap,
      ...(readString(rawValue.languageId) !== undefined
        ? { languageId: readString(rawValue.languageId) as string }
        : languageIds.length === 1 && languageIds[0] !== undefined
          ? { languageId: languageIds[0] }
          : {}),
      ...(rawValue.initializationOptions !== undefined
        ? { initializationOptions: rawValue.initializationOptions }
        : {}),
      ...(rawValue.settings !== undefined ? { settings: rawValue.settings } : {}),
    });
  }
  return output;
}

function normalizeMonitors(
  config: UnknownRecord | undefined,
  skillNameMap: ReadonlyMap<string, string>,
  issues: IssueRecorder,
): RuntimeMonitorSpec[] {
  if (!config) return [];
  const rawMonitors = config.monitors ?? config;
  const entries: Array<[string, unknown]> = isRecord(rawMonitors) && readString(rawMonitors.command)
    ? [[readString(rawMonitors.id) ?? "monitor", rawMonitors]]
    : Array.isArray(rawMonitors)
    ? rawMonitors.map((value, index) => [String(index + 1), value])
    : isRecord(rawMonitors)
      ? Object.entries(rawMonitors)
      : [];
  const output: RuntimeMonitorSpec[] = [];
  for (const [key, rawValue] of entries) {
    if (!isRecord(rawValue)) {
      issues.add("monitors", "preserved", "Ignored a non-object monitor definition", { detail: key });
      continue;
    }
    const command = readString(rawValue.command);
    if (!command) {
      issues.add("monitors", "unsupported", "Monitor is missing an executable command", { detail: key });
      continue;
    }
    if (command.includes("${user_config.")) {
      issues.add("monitors", "unsupported", "Claude rejects user_config interpolation in monitor shell commands", {
        detail: key,
      });
      continue;
    }
    const args = readStringArray(rawValue.args);
    const env = readStringRecord(rawValue.env);
    const intervalMs = normalizeInterval(rawValue.intervalMs, rawValue.interval);
    const timeoutMs = normalizeTimeout(rawValue.timeoutMs, rawValue.timeout);
    const rawWhen = readString(rawValue.when) ?? "always";
    const when = rawWhen.startsWith("on-skill-invoke:")
      ? `on-skill-invoke:${skillNameMap.get(rawWhen.slice("on-skill-invoke:".length)) ?? rawWhen.slice("on-skill-invoke:".length)}`
      : rawWhen;
    if (when !== "always" && !/^on-skill-invoke:[A-Za-z0-9._-]+$/.test(when)) {
      issues.add("monitors", "unsupported", `Unsupported monitor activation rule: ${when}`, {
        detail: key,
      });
      continue;
    }
    output.push({
      id: slugify(readString(rawValue.id) ?? readString(rawValue.name) ?? key),
      command,
      ...(readString(rawValue.label ?? rawValue.name) !== undefined
        ? { label: readString(rawValue.label ?? rawValue.name) as string }
        : {}),
      ...(readString(rawValue.description) !== undefined
        ? { description: readString(rawValue.description) as string }
        : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(readString(rawValue.cwd) !== undefined ? { cwd: readString(rawValue.cwd) as string } : {}),
      ...(env ? { env } : {}),
      when,
      ...(intervalMs === undefined ? { persistent: true } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(typeof rawValue.runOnStart === "boolean" ? { runOnStart: rawValue.runOnStart } : {}),
      ...(typeof rawValue.notifyOnFailure === "boolean"
        ? { notifyOnFailure: rawValue.notifyOnFailure }
        : {}),
    });
  }
  return output;
}

function convertMonitors(
  index: SourceIndex,
  manifestValue: unknown,
  skillNameMap: ReadonlyMap<string, string>,
  issues: IssueRecorder,
): RuntimeMonitorSpec[] {
  const configs: UnknownRecord[] = [];
  if (isRecord(manifestValue) || Array.isArray(manifestValue)) {
    if (Array.isArray(manifestValue)) configs.push({ monitors: manifestValue });
    else configs.push(manifestValue);
  }
  const declared =
    typeof manifestValue === "string" ||
    (Array.isArray(manifestValue) && manifestValue.every((item) => typeof item === "string"))
      ? declaredPaths(manifestValue, "monitors", issues)
      : [];
  const paths = new Set<string>();
  for (const configured of declared) {
    let found = false;
    for (const entry of index.entries) {
      if (entryMatchesPath(entry, configured) && /\.(?:json|jsonc|yaml|yml)$/i.test(entry.path)) {
        paths.add(entry.path);
        found = true;
      }
    }
    if (!found) issues.add("monitors", "preserved", "Configured monitor path was not found", { source: configured });
  }
  if (manifestValue === undefined) {
    for (const entry of index.entries) {
      if (
        (entry.path === "monitors/monitors.json" || entry.path === "monitors.json" || entry.path.startsWith("monitors/")) &&
        /\.(?:json|jsonc|yaml|yml)$/i.test(entry.path)
      ) {
        paths.add(entry.path);
      }
    }
  }
  for (const monitorPath of [...paths].sort((a, b) => a.localeCompare(b, "en"))) {
    const entry = index.byPath.get(monitorPath);
    if (!entry) continue;
    configs.push(asRecord(parseEntry(entry), entry.path));
  }
  return configs.flatMap((config) => normalizeMonitors(config, skillNameMap, issues));
}

function convertOutputStyles(
  index: SourceIndex,
  manifest: UnknownRecord,
  pluginSlug: string,
  agentNameMap: ReadonlyMap<string, string>,
  issues: IssueRecorder,
): OutputStyleSpec[] {
  const files = discoverMarkdownComponents(
    index,
    declaredPaths(manifest.outputStyles, "output-styles", issues),
    manifest.outputStyles === undefined ? ["output-styles"] : [],
    (entry) => entry.path.toLocaleLowerCase("en-US").endsWith(".md"),
    "output-styles",
    issues,
  );
  const generatedNames = new Map<string, string>();
  let forcedStyleSeen = false;
  return files.map((entry) => {
    const parsed = parseFrontmatter(entry.content.toString(), entry.path);
    const declaredName = readString(parsed.attributes.name);
    const style: OutputStyleSpec = {
      name: flattenedName(
        pluginSlug,
        declaredName ?? relativeComponentPath(entry.path, "output-styles"),
      ),
      prompt: transformAgentReferences(transformReferences(parsed.body, pluginSlug), agentNameMap),
    };
    assertUniqueGeneratedName(generatedNames, style.name, entry.path, "output style");
    const description = readString(parsed.attributes.description);
    if (description !== undefined) style.description = description;
    const keepCodingInstructions =
      parsed.attributes["keep-coding-instructions"] ?? parsed.attributes.keepCodingInstructions;
    const forceForPlugin =
      parsed.attributes["force-for-plugin"] ?? parsed.attributes.forceForPlugin;
    if (typeof keepCodingInstructions === "boolean") {
      style.keepCodingInstructions = keepCodingInstructions;
    }
    if (forceForPlugin === true) {
      style.forceForPlugin = true;
      if (forcedStyleSeen) {
        issues.add(
          "output-styles",
          "approximated",
          "Only the first force-for-plugin output style can be the deterministic Pi session default",
          { source: entry.path },
        );
      }
      forcedStyleSeen = true;
    }
    if (keepCodingInstructions !== true) {
      issues.add(
        "output-styles",
        "approximated",
        "Pi can append this output style but cannot remove its built-in coding instructions",
        { source: entry.path },
      );
    }
    const knownFields = new Set([
      "name",
      "description",
      "keep-coding-instructions",
      "keepCodingInstructions",
      "force-for-plugin",
      "forceForPlugin",
    ]);
    for (const key of Object.keys(parsed.attributes)) {
      if (!knownFields.has(key)) {
        issues.add(
          "output-styles",
          "preserved",
          `Preserved unrecognized output style field: ${key}`,
          { source: entry.path, detail: { [key]: parsed.attributes[key] } },
        );
      }
    }
    issues.add("output-styles", "approximated", "Converted output style to a session prompt modifier", {
      source: entry.path,
      target: "extensions/main.ts",
    });
    return style;
  });
}

function convertThemes(
  index: SourceIndex,
  manifestValue: unknown,
  pluginSlug: string,
  outputTree: Map<string, TreeEntry>,
  issues: IssueRecorder,
): number {
  const declared = declaredPaths(manifestValue, "themes", issues);
  const files = new Map<string, TreeEntry>();
  const generatedTargets = new Map<string, string>();
  let convertedCount = 0;
  const locations = manifestValue === undefined ? ["themes"] : declared;
  for (const location of locations) {
    for (const entry of index.entries) {
      if (entryMatchesPath(entry, location) && /\.(?:json|jsonc)$/i.test(entry.path)) {
        files.set(entry.path, entry);
      }
    }
  }
  for (const entry of [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    try {
      const sourceTheme = asRecord(parseEntry(entry), entry.path);
      const generatedName = flattenedName(pluginSlug, relativeComponentPath(entry.path, "themes"));
      const target = `themes/${generatedName}.json`;
      assertUniqueGeneratedName(generatedTargets, target, entry.path, "theme");
      const theme = convertClaudeTheme(sourceTheme, generatedName, entry.path, issues);
      if (!theme) continue;
      addTreeEntry(outputTree, target, `${JSON.stringify(theme, null, 2)}\n`, entry.mode);
      convertedCount += 1;
      issues.add("themes", "approximated", "Expanded Claude theme overrides over a complete Pi base theme", {
        source: entry.path,
        target,
      });
    } catch (error) {
      issues.add("themes", "preserved", "Theme could not be normalized and remains under original/", {
        source: entry.path,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return convertedCount;
}

type PiThemeBase = "dark" | "light";
type PiThemeColorValue = string | number;

const PI_THEME_COLOR_KEYS = new Set([
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg",
  "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel",
  "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
  "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded",
  "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
  "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType",
  "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow",
  "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
]);

const CLAUDE_THEME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ["accent", "customMessageLabel"],
  primary: ["accent"],
  secondary: ["muted"],
  permission: ["warning"],
};

function convertClaudeTheme(
  source: UnknownRecord,
  generatedName: string,
  sourcePath: string,
  issues: IssueRecorder,
): UnknownRecord | undefined {
  const requestedBase = readString(source.base)?.toLocaleLowerCase("en-US");
  const inferredBase: PiThemeBase = /light/i.test(readString(source.name) ?? sourcePath)
    ? "light"
    : "dark";
  if (requestedBase !== undefined && requestedBase !== "dark" && requestedBase !== "light") {
    issues.add("themes", "unsupported", `Unsupported Claude theme base: ${requestedBase}`, {
      source: sourcePath,
    });
    return undefined;
  }
  const base = (requestedBase ?? inferredBase) as PiThemeBase;
  const colors = createPiBaseTheme(base);
  const rawOverrides = {
    ...(isRecord(source.colors) ? source.colors : {}),
    ...(isRecord(source.overrides) ? source.overrides : {}),
  };
  const ignored: string[] = [];
  const invalid: string[] = [];
  for (const [sourceKey, rawValue] of Object.entries(rawOverrides)) {
    const targets = PI_THEME_COLOR_KEYS.has(sourceKey)
      ? [sourceKey]
      : CLAUDE_THEME_ALIASES[sourceKey] ?? [];
    if (targets.length === 0) {
      ignored.push(sourceKey);
      continue;
    }
    if (!isPiThemeColorValue(rawValue)) {
      invalid.push(sourceKey);
      continue;
    }
    for (const target of targets) colors[target] = rawValue;
  }
  if (ignored.length > 0) {
    issues.add("themes", "preserved", "Preserved Claude-only theme tokens that Pi cannot represent", {
      source: sourcePath,
      detail: ignored.sort(),
    });
  }
  if (invalid.length > 0) {
    issues.add("themes", "preserved", "Ignored theme colors that are invalid for Pi", {
      source: sourcePath,
      detail: invalid.sort(),
    });
  }
  return {
    $schema:
      "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
    name: generatedName,
    colors,
  };
}

function isPiThemeColorValue(value: unknown): value is PiThemeColorValue {
  return (
    (typeof value === "string" && (value === "" || /^#[0-9A-Fa-f]{6}$/.test(value))) ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
  );
}

function createPiBaseTheme(base: PiThemeBase): UnknownRecord {
  const dark = base === "dark";
  const accent = dark ? "#8abeb7" : "#5a8080";
  const blue = dark ? "#5f87ff" : "#547da7";
  const green = dark ? "#b5bd68" : "#588458";
  const red = dark ? "#cc6666" : "#aa5555";
  const yellow = dark ? "#ffff00" : "#9a7326";
  const text = dark ? "#d4d4d4" : "#1f2328";
  const muted = dark ? "#808080" : "#6c6c6c";
  const dim = dark ? "#666666" : "#767676";
  const borderMuted = dark ? "#505050" : "#b0b0b0";
  const selectedBg = dark ? "#3a3a4a" : "#d0d0e0";
  const userBg = dark ? "#343541" : "#e8e8e8";
  const customBg = dark ? "#2d2838" : "#ede7f6";
  const pendingBg = dark ? "#282832" : "#e8e8f0";
  const successBg = dark ? "#283228" : "#e8f0e8";
  const errorBg = dark ? "#3c2828" : "#f0e8e8";
  return {
    accent,
    border: blue,
    borderAccent: accent,
    borderMuted,
    success: green,
    error: red,
    warning: yellow,
    muted,
    dim,
    text,
    thinkingText: muted,
    selectedBg,
    userMessageBg: userBg,
    userMessageText: text,
    customMessageBg: customBg,
    customMessageText: text,
    customMessageLabel: dark ? "#9575cd" : "#7e57c2",
    toolPendingBg: pendingBg,
    toolSuccessBg: successBg,
    toolErrorBg: errorBg,
    toolTitle: text,
    toolOutput: muted,
    mdHeading: yellow,
    mdLink: blue,
    mdLinkUrl: dim,
    mdCode: accent,
    mdCodeBlock: green,
    mdCodeBlockBorder: muted,
    mdQuote: muted,
    mdQuoteBorder: muted,
    mdHr: muted,
    mdListBullet: accent,
    toolDiffAdded: green,
    toolDiffRemoved: red,
    toolDiffContext: muted,
    syntaxComment: dark ? "#6A9955" : "#008000",
    syntaxKeyword: dark ? "#569CD6" : "#0000FF",
    syntaxFunction: dark ? "#DCDCAA" : "#795E26",
    syntaxVariable: dark ? "#9CDCFE" : "#001080",
    syntaxString: dark ? "#CE9178" : "#A31515",
    syntaxNumber: dark ? "#B5CEA8" : "#098658",
    syntaxType: dark ? "#4EC9B0" : "#267F99",
    syntaxOperator: text,
    syntaxPunctuation: text,
    thinkingOff: borderMuted,
    thinkingMinimal: dim,
    thinkingLow: blue,
    thinkingMedium: accent,
    thinkingHigh: dark ? "#b294bb" : "#875f87",
    thinkingXhigh: dark ? "#d183e8" : "#8b008b",
    thinkingMax: dark ? "#ff5fff" : "#af005f",
    bashMode: green,
  };
}

function convertUserConfiguration(
  index: SourceIndex,
  manifest: UnknownRecord,
  pluginSlug: string,
  outputTree: Map<string, TreeEntry>,
  issues: IssueRecorder,
): void {
  const sources: Array<{ source: string; value: UnknownRecord }> = [];
  if (isRecord(manifest.userConfig)) {
    sources.push({ source: "plugin manifest userConfig", value: manifest.userConfig });
  }
  for (const candidate of ["userConfig.json", "userConfig.jsonc", "user-config.json", "user-config.jsonc"]) {
    const entry = index.byPath.get(candidate);
    if (!entry) continue;
    const parsed = asRecord(parseEntry(entry), entry.path);
    sources.push({
      source: entry.path,
      value: isRecord(parsed.userConfig)
        ? parsed.userConfig
        : isRecord(parsed.properties)
          ? parsed.properties
          : parsed,
    });
  }
  if (sources.length === 0) return;

  const definitions: UnknownRecord = {};
  for (const source of dedupeConfigSources(sources)) {
    for (const [key, definition] of Object.entries(source.value)) {
      if (definitions[key] !== undefined && JSON.stringify(definitions[key]) !== JSON.stringify(definition)) {
        issues.add("settings", "unsupported", `Conflicting userConfig option was not replaced: ${key}`, {
          source: source.source,
        });
        continue;
      }
      definitions[key] = definition;
    }
  }

  const properties: UnknownRecord = {};
  const example: UnknownRecord = {};
  const required: string[] = [];
  const envExamples: string[] = [];
  for (const [key, rawDefinition] of Object.entries(definitions).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    if (!isRecord(rawDefinition)) {
      issues.add("settings", "preserved", `Ignored non-object userConfig option: ${key}`);
      continue;
    }
    const sourceType = readString(rawDefinition.type)?.toLocaleLowerCase("en-US") ?? "string";
    const multiple = rawDefinition.multiple === true || sourceType.endsWith("[]");
    const scalarType = sourceType.replace(/\[\]$/, "");
    const jsonType = scalarType === "number" || scalarType === "integer"
      ? scalarType
      : scalarType === "boolean"
        ? "boolean"
        : "string";
    if (!["string", "number", "integer", "boolean", "file", "directory"].includes(scalarType)) {
      issues.add("settings", "approximated", `Represented unknown userConfig type as string: ${key}`, {
        detail: sourceType,
      });
    }
    const scalarSchema: UnknownRecord = { type: jsonType };
    const description = readString(rawDefinition.description);
    if (description !== undefined) scalarSchema.description = description;
    if (scalarType === "file" || scalarType === "directory") {
      scalarSchema["x-claude-path-kind"] = scalarType;
    }
    const optionValues = Array.isArray(rawDefinition.options)
      ? rawDefinition.options
          .map((option) => isRecord(option) ? option.value : option)
          .filter((option): option is string | number | boolean =>
            typeof option === "string" || typeof option === "number" || typeof option === "boolean"
          )
      : Array.isArray(rawDefinition.enum)
        ? rawDefinition.enum.filter((option): option is string | number | boolean =>
            typeof option === "string" || typeof option === "number" || typeof option === "boolean"
          )
        : [];
    if (optionValues.length > 0) scalarSchema.enum = optionValues;
    if (typeof rawDefinition.minimum === "number" || typeof rawDefinition.min === "number") {
      scalarSchema.minimum = rawDefinition.minimum ?? rawDefinition.min;
    }
    if (typeof rawDefinition.maximum === "number" || typeof rawDefinition.max === "number") {
      scalarSchema.maximum = rawDefinition.maximum ?? rawDefinition.max;
    }
    const sensitive = rawDefinition.sensitive === true ||
      rawDefinition.secret === true ||
      isSecretKey(key) ||
      (typeof rawDefinition.default === "string" &&
        (looksLikeSecretLiteral(rawDefinition.default) || containsUrlCredentials(rawDefinition.default)));
    if (sensitive) {
      scalarSchema.writeOnly = true;
      scalarSchema["x-sensitive"] = true;
    }
    const propertySchema: UnknownRecord = multiple
      ? { type: "array", items: scalarSchema }
      : scalarSchema;
    const hasSafeDefault = rawDefinition.default !== undefined && !sensitive;
    if (hasSafeDefault) propertySchema.default = rawDefinition.default;
    properties[key] = propertySchema;
    if (rawDefinition.required === true) required.push(key);

    const variable = userConfigEnvName(pluginSlug, key);
    const safeDefault = hasSafeDefault && !isRecord(rawDefinition.default)
      ? String(rawDefinition.default)
      : "";
    envExamples.push(`${variable}=${safeDefault}`);
    example[key] = hasSafeDefault ? rawDefinition.default : `\${${variable}}`;
  }

  const schema: UnknownRecord = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${pluginSlug} converted user configuration`,
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
  addTreeEntry(outputTree, "config/user-config.schema.json", `${JSON.stringify(schema, null, 2)}\n`, 0o644);
  addTreeEntry(outputTree, "config/user-config.example.json", `${JSON.stringify(example, null, 2)}\n`, 0o600);
  addTreeEntry(
    outputTree,
    "config/user-config.env.example",
    `${envExamples.sort((left, right) => left.localeCompare(right, "en")).join("\n")}\n`,
    0o600,
  );
  addTreeEntry(
    outputTree,
    "config/README.md",
    [
      `# ${pluginSlug} user configuration`,
      "",
      "Claude `${user_config.KEY}` references were converted to environment-variable references.",
      "Copy `user-config.env.example` into your project environment and fill in required or sensitive values.",
      "`user-config.schema.json` documents types and constraints; `user-config.example.json` is not loaded automatically.",
      "",
    ].join("\n"),
    0o644,
  );
  issues.add("settings", "approximated", "Converted userConfig to a JSON schema and environment-based example", {
    target: "config/user-config.schema.json",
  });
}

function reportPreservedConfiguration(
  index: SourceIndex,
  manifest: UnknownRecord,
  issues: IssueRecorder,
): void {
  for (const candidate of ["settings.json", "settings.jsonc"]) {
    if (index.byPath.has(candidate)) {
      issues.add("settings", "approximated", "Preserved settings as activation guidance; only safe Pi values are applied", {
        source: candidate,
      });
    }
  }
  if (manifest.settings !== undefined) {
    issues.add("settings", "approximated", "Preserved manifest settings for project activation guidance");
  }
  const channelFiles = index.entries.filter(
    (entry) => entry.path === "channels.json" || entry.path.startsWith("channels/"),
  );
  if (manifest.channels !== undefined || channelFiles.length > 0) {
    issues.add("channels", "unsupported", "Pi has no equivalent for Claude plugin channels; originals were preserved");
  }
}

function auditManifestFields(
  manifest: UnknownRecord,
  source: string | undefined,
  issues: IssueRecorder,
): void {
  const known = new Set([
    "$schema",
    "name",
    "displayName",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "defaultEnabled",
    "skills",
    "commands",
    "agents",
    "hooks",
    "mcpServers",
    "outputStyles",
    "lspServers",
    "userConfig",
    "channels",
    "dependencies",
    "experimental",
    "settings",
    "themes",
    "monitors",
    "bin",
    "assets",
  ]);
  for (const key of Object.keys(manifest)) {
    if (!known.has(key)) {
      issues.add("manifest", "preserved", `Preserved unrecognized manifest field: ${key}`, {
        ...(source ? { source } : {}),
        detail: { [key]: manifest[key] },
      });
    }
  }
  if (isRecord(manifest.experimental)) {
    for (const key of Object.keys(manifest.experimental)) {
      if (!new Set(["themes", "monitors"]).has(key)) {
        issues.add(
          "manifest",
          "preserved",
          `Preserved unrecognized experimental manifest field: ${key}`,
          { ...(source ? { source } : {}), detail: { [key]: manifest.experimental[key] } },
        );
      }
    }
  }
}

function applyManifestRuntimeMetadata(
  target: UnknownRecord,
  source: UnknownRecord,
  index: SourceIndex,
  includeSecrets: boolean,
  issues: IssueRecorder,
): void {
  if (source.dependencies !== undefined) {
    const metadata = isRecord(target.claudePiConvert) ? target.claudePiConvert : {};
    const dependencyValue = { pluginDependencies: source.dependencies };
    metadata.pluginDependencies = includeSecrets
      ? structuredClone(source.dependencies)
      : redactSecrets(
          dependencyValue,
          `${readString(source.name) ?? "claude_plugin"}_dependencies`,
          false,
          new Set<string>(),
        ).pluginDependencies;
    target.claudePiConvert = metadata;
    issues.add(
      "manifest",
      "unsupported",
      Array.isArray(source.dependencies)
        ? "Claude plugin dependencies cannot be resolved automatically as Pi package dependencies"
        : "Preserved nonstandard Claude dependency metadata without treating it as npm dependencies",
      { detail: source.dependencies },
    );
  }

  const sourcePackageEntry = index.byPath.get("package.json");
  if (sourcePackageEntry) {
    try {
      const sourcePackage = asRecord(parseEntry(sourcePackageEntry), sourcePackageEntry.path);
      const externalRuntimes = new Set<string>(
        Object.values(RUNTIMES).map((runtime) => runtime.packageName),
      );
      const sourceDependencies = {
        ...(isRecord(sourcePackage.dependencies) ? sourcePackage.dependencies : {}),
        ...(isRecord(sourcePackage.optionalDependencies) ? sourcePackage.optionalDependencies : {}),
      };
      const dependencies: Record<string, string> = {};
      for (const [name, rawVersion] of Object.entries(sourceDependencies)) {
        if (externalRuntimes.has(name)) {
          issues.add(
            "manifest",
            "preserved",
            `Left external Pi runtime ${name} to the exact activation requirement instead of bundling it`,
            { source: sourcePackageEntry.path },
          );
          continue;
        }
        if (typeof rawVersion !== "string" || !rawVersion.trim()) {
          issues.add("manifest", "preserved", `Ignored invalid npm dependency ${name}`, {
            source: sourcePackageEntry.path,
          });
          continue;
        }
        if (
          !includeSecrets &&
          (containsUrlCredentials(rawVersion) || looksLikeSecretLiteral(rawVersion))
        ) {
          issues.add("security", "approximated", `Omitted credential-bearing npm dependency ${name}`, {
            source: sourcePackageEntry.path,
          });
          continue;
        }
        dependencies[name] = rawVersion;
      }
      if (Object.keys(dependencies).length > 0) {
        target.dependencies = dependencies;
        const metadata = isRecord(target.claudePiConvert) ? target.claudePiConvert : {};
        metadata.sourceNpmDependencies = Object.keys(dependencies).sort();
        target.claudePiConvert = metadata;
        issues.add(
          "manifest",
          "approximated",
          "Copied source npm runtime dependencies; install them in the converted package before activation",
          { source: sourcePackageEntry.path, target: "package.json" },
        );
      }
    } catch (error) {
      issues.add("manifest", "preserved", "Could not normalize source package.json dependencies", {
        source: sourcePackageEntry.path,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const binEntries: Array<[string, unknown]> = typeof source.bin === "string"
    ? [[readString(source.name) ?? "claude-plugin", source.bin]]
    : isRecord(source.bin)
      ? Object.entries(source.bin)
      : [];
  const convertedBins: Record<string, string> = {};
  for (const [name, rawPath] of binEntries) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      issues.add("manifest", "unsupported", `Rejected unsafe bin name: ${name}`);
      continue;
    }
    if (typeof rawPath !== "string") {
      issues.add("manifest", "preserved", `Ignored non-string bin path for ${name}`);
      continue;
    }
    const withoutRoot = rawPath
      .replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, "")
      .replace(/^\.\//, "");
    let safePath: string;
    try {
      safePath = assertSafeRelativePath(withoutRoot, `bin ${name}`);
    } catch (error) {
      issues.add("manifest", "unsupported", `Rejected unsafe bin path for ${name}`, {
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!index.byPath.has(safePath)) {
      issues.add("manifest", "preserved", `Bin target was not found: ${safePath}`);
      continue;
    }
    convertedBins[name] = `./original/${safePath}`;
  }
  if (Object.keys(convertedBins).length > 0) {
    target.bin = convertedBins;
    issues.add("manifest", "converted", "Remapped plugin bin entries to preserved package runtime assets");
  } else if (source.bin !== undefined && binEntries.length === 0) {
    issues.add("manifest", "preserved", "Preserved malformed bin metadata only under original/");
  }

  if (source.assets !== undefined) {
    const assetEntries: Array<[string, unknown]> = Array.isArray(source.assets)
      ? source.assets.map((asset, index) => [String(index), asset])
      : isRecord(source.assets)
        ? Object.entries(source.assets)
        : [["asset", source.assets]];
    const assets: UnknownRecord = {};
    for (const [name, rawPath] of assetEntries) {
      if (typeof rawPath !== "string") continue;
      try {
        const safePath = assertSafeRelativePath(
          rawPath.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]?/, "").replace(/^\.\//, ""),
          `asset ${name}`,
        );
        if (index.byPath.has(safePath) || index.entries.some((entry) => entry.path.startsWith(`${safePath}/`))) {
          assets[name] = `./original/${safePath}`;
        }
      } catch {
        issues.add("manifest", "unsupported", `Rejected unsafe asset path for ${name}`);
      }
    }
    const metadata = isRecord(target.claudePiConvert) ? target.claudePiConvert : {};
    metadata.assets = Array.isArray(source.assets) ? Object.values(assets) : assets;
    target.claudePiConvert = metadata;
    issues.add("manifest", "preserved", "Recorded asset metadata; complete source assets are available under original/");
  }
}

function renderRuntimeBinShim(pluginId: string, originalTarget: string): string {
  return `#!/usr/bin/env node
// Generated by claude-pi-convert for ${pluginId}.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL(${JSON.stringify(`../original/${originalTarget}`)}, import.meta.url));
const useNode = /\\.(?:[cm]?js|ts)$/i.test(target);
const child = spawn(useNode ? process.execPath : target, useNode ? [target, ...process.argv.slice(2)] : process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: false,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => {
  process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
});
`;
}

function createPiPackageManifest(
  sourceManifest: UnknownRecord,
  pluginSlug: string,
  displayName: string,
  hasSkills: boolean,
  hasThemes: boolean,
  hasAgentGuard: boolean,
  includeSecrets: boolean,
  issues: IssueRecorder,
): UnknownRecord {
  const sourceVersion = readString(sourceManifest.version);
  const version = sourceVersion && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(sourceVersion)
    ? sourceVersion
    : "0.0.0";
  const extensions = ["./extensions/main.ts"];
  if (hasAgentGuard) extensions.push("./extensions/agent-guard.ts");
  const output: UnknownRecord = {
    name: `${pluginSlug}-pi`,
    version,
    description: (() => {
      const description = readString(sourceManifest.description);
      if (description && !includeSecrets && containsSecretsDeep(description)) {
        issues.add("security", "approximated", "Omitted a secret-shaped package description");
        return `${displayName}, converted from Claude Code for Pi`;
      }
      return description ?? `${displayName}, converted from Claude Code for Pi`;
    })(),
    type: "module",
    engines: { node: `>=${MIN_NODE_VERSION}` },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-ai": "*",
      typebox: "*",
    },
    devDependencies: {
      "@earendil-works/pi-coding-agent": TARGET_PI_VERSION,
      "@earendil-works/pi-ai": TARGET_PI_VERSION,
      "@types/node": "24.10.1",
      typebox: "1.3.6",
      typescript: "5.9.3",
    },
    scripts: {
      typecheck: "tsc --noEmit",
    },
    pi: {
      extensions,
      ...(hasSkills ? { skills: ["./skills"] } : {}),
      ...(hasThemes ? { themes: ["./themes"] } : {}),
    },
    claudePiConvert: {
      schemaVersion: 1,
      sourceName: pluginSlug,
      targetPi: TARGET_PI_VERSION,
      ...(typeof sourceManifest.defaultEnabled === "boolean"
        ? { sourceDefaultEnabled: sourceManifest.defaultEnabled }
        : {}),
    },
  };
  if (sourceManifest.defaultEnabled === false) {
    issues.add(
      "manifest",
      "approximated",
      "Claude defaultEnabled:false is represented by the converter's explicit activate step",
    );
  } else if (
    sourceManifest.defaultEnabled !== undefined &&
    typeof sourceManifest.defaultEnabled !== "boolean"
  ) {
    issues.add("manifest", "preserved", "Preserved malformed defaultEnabled metadata");
  }
  for (const key of ["license", "homepage"] as const) {
    const value = readString(sourceManifest[key]);
    if (value !== undefined) {
      if (!includeSecrets && (containsUrlCredentials(value) || looksLikeSecretLiteral(value))) {
        issues.add("security", "approximated", `Omitted credential-bearing package metadata: ${key}`);
      } else {
        output[key] = value;
      }
    }
  }
  if (typeof sourceManifest.repository === "string" || isRecord(sourceManifest.repository)) {
    if (!includeSecrets && containsSecretsDeep(sourceManifest.repository)) {
      issues.add("security", "approximated", "Omitted credential-bearing package repository metadata");
    } else {
      output.repository = sourceManifest.repository;
    }
  }
  if (typeof sourceManifest.author === "string" || isRecord(sourceManifest.author)) {
    if (!includeSecrets && containsSecretsDeep(sourceManifest.author)) {
      issues.add("security", "approximated", "Omitted credential-bearing package author metadata");
    } else {
      output.author = sourceManifest.author;
    }
  }
  if (
    Array.isArray(sourceManifest.keywords) &&
    sourceManifest.keywords.every((keyword) => typeof keyword === "string")
  ) {
    const keywords = includeSecrets
      ? sourceManifest.keywords
      : sourceManifest.keywords.filter((keyword) => !containsSecretsDeep(keyword));
    if (keywords.length !== sourceManifest.keywords.length) {
      issues.add("security", "approximated", "Omitted secret-shaped package keywords");
    }
    if (keywords.length > 0) output.keywords = keywords;
  }
  return output;
}

function createGeneratedTsConfig(): UnknownRecord {
  return {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      // Pi extension events intentionally expose dynamic plugin payloads. Their
      // runtime boundary is represented by DynamicRecord in the generated code.
      noImplicitAny: false,
      useUnknownInCatchVariables: false,
      noUncheckedIndexedAccess: false,
      exactOptionalPropertyTypes: false,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
    },
    include: ["extensions/main.ts"],
    // agent-guard consumes generic public pi-subagents event-bus payloads and
    // is covered by the runtime smoke tests. main.ts is the standalone entrypoint.
    exclude: ["extensions/agent-guard.ts"],
  };
}

function createIssueRecorder(): IssueRecorder {
  const list: ConversionIssue[] = [];
  return {
    list,
    add(component, status, message, options = {}) {
      list.push({ component, status, message, ...options });
    },
  };
}

function summarizeComponents(issues: readonly ConversionIssue[]): ComponentSummary[] {
  const summaries = new Map<string, ComponentSummary>();
  for (const issue of issues) {
    const summary = summaries.get(issue.component) ?? {
      component: issue.component,
      converted: 0,
      approximated: 0,
      preserved: 0,
      unsupported: 0,
    };
    summary[issue.status] += 1;
    summaries.set(issue.component, summary);
  }
  return [...summaries.values()].sort((a, b) => a.component.localeCompare(b.component, "en"));
}

function createReportActivationActions(
  output: string,
  manifest: ActivationManifest,
): ReportActivationAction[] {
  const actions: ReportActivationAction[] = [
    { kind: "install-package", source: output, target: ".pi/settings.json" },
    { kind: "merge-settings", source: output, target: ".pi/settings.json" },
  ];
  for (const requirement of manifest.runtimeRequirements.filter((runtime) => runtime.required)) {
    actions.push({
      kind: "install-runtime",
      source: `npm:${requirement.packageName}@${requirement.version}`,
      target: ".pi/settings.json",
    });
  }
  for (const file of [
    ...manifest.agents,
    ...(manifest.skillFiles ?? []),
    ...manifest.runtimeFiles,
  ]) {
    actions.push({ kind: "copy-file", source: file.source, target: file.target });
  }
  if (manifest.mcpConfig) {
    actions.push({ kind: "merge-mcp", source: "activation-manifest.json", target: ".pi/mcp.json" });
  }
  return actions;
}

function renderReport(report: ConversionReport): string {
  const lines = [
    `# Conversion report: ${report.pluginId}`,
    "",
    `- Source: \`${report.source}\``,
    `- Output: \`${report.output}\``,
    `- Target: Pi ${report.target.pi}, Node ${report.target.node}`,
    "",
    "## Runtime requirements",
    "",
  ];
  if (report.runtimeRequirements.length === 0) lines.push("None.");
  for (const runtime of report.runtimeRequirements) {
    lines.push(`- \`${runtime.packageName}@${runtime.version}\`: ${runtime.reason}`);
  }
  lines.push("", "## Component summary", "", "| Component | Converted | Approx. | Preserved | Unsupported |", "|---|---:|---:|---:|---:|");
  for (const component of report.components) {
    lines.push(
      `| ${component.component} | ${component.converted} | ${component.approximated} | ${component.preserved} | ${component.unsupported} |`,
    );
  }
  lines.push("", "## Details", "");
  for (const issue of report.issues) {
    lines.push(
      `- **${issue.status}** \`${issue.component}\`${issue.source ? ` (${issue.source})` : ""}: ${issue.message}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function reproducibleTimestamp(manifest: TreeEntry | undefined, fallback: Date): string {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) {
    const milliseconds = Number(epoch) * 1000;
    if (Number.isFinite(milliseconds) && milliseconds <= 8.64e15) {
      return new Date(milliseconds).toISOString();
    }
  }
  // TreeEntry intentionally excludes mutable timestamps. A stable fallback
  // keeps repeated conversions byte-identical; the source path is retained in
  // the report for traceability.
  void manifest;
  void fallback;
  return "1970-01-01T00:00:00.000Z";
}

function dedupeConfigSources<T extends { source: string; value: unknown }>(sources: T[]): T[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.source}\0${JSON.stringify(source.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertUniqueGeneratedName(
  seen: Map<string, string>,
  generatedName: string,
  source: string,
  component: string,
): void {
  const key = generatedName.normalize("NFC").toLocaleLowerCase("en-US");
  const previous = seen.get(key);
  if (previous && previous !== source) {
    throw new Error(
      `Generated ${component} name collision for ${generatedName}: ${previous} and ${source}`,
    );
  }
  seen.set(key, source);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeTimeout(timeoutMs: unknown, timeoutSeconds: unknown): number | undefined {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.round(timeoutMs);
  }
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.round(timeoutSeconds * 1000);
  }
  return undefined;
}

function normalizeInterval(intervalMs: unknown, intervalSeconds: unknown): number | undefined {
  if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0) {
    return Math.max(1_000, Math.round(intervalMs));
  }
  if (typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds > 0) {
    return Math.max(1_000, Math.round(intervalSeconds * 1000));
  }
  return undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
