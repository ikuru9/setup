import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";

import { MIN_NODE_VERSION, RUNTIMES, TARGET_PI_VERSION } from "./constants.js";
import type {
  ActivateOptions,
  AppliedPackageChange,
  AppliedValueChange,
  ActivationFile,
  ActivationManifest,
  ActivationReceipt,
  DeactivateOptions,
  DoctorCheck,
  DoctorOptions,
  DoctorReport,
  McpReceipt,
  OperationResult,
  ReceiptFileChange,
  RuntimeRequirement,
  SettingsReceipt,
} from "./types.js";

const MANIFEST_FILE = "activation-manifest.json";
const RECEIPT_FILE = "receipt.json";
const SETTINGS_RELATIVE_PATH = ".pi/settings.json";
const MCP_RELATIVE_PATH = ".pi/mcp.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const MAX_COMMAND_OUTPUT = 1024 * 1024;

interface FileSnapshot {
  exists: boolean;
  content?: Buffer;
  mode?: number;
}

interface PreparedFile {
  entry: ActivationFile;
  sourcePath: string;
  targetPath: string;
  targetRelative: string;
  content: Buffer;
  mode: number;
  sourceMode: number;
}

interface RuntimeState {
  source: string;
  configured: boolean;
  installed: boolean;
  installedName?: string;
  installedVersion?: string;
  filterMatches: boolean;
  scope?: "project" | "global";
  packagePath: string;
}

const REQUIRED_WEB_TOOLS = ["web_search", "fetch_content"] as const;
const PI_WEB_ACCESS_PUBLIC_ENTRYPOINT = "index.ts";

interface RestorePlan {
  result: FileSnapshot;
  changed: boolean;
  warnings: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface DependencyCheck {
  name: string;
  spec: string;
  packagePath: string;
  status: "ok" | "missing" | "mismatch" | "unsupported";
  installedVersion?: string;
  message: string;
}

interface StaticCommandSpec {
  label: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell: boolean;
}

interface ExecutablePreflightContext {
  packageRoot: string;
  originalRoot: string;
  activationRuntimeRoot: string;
  project: string;
  manifest: ActivationManifest;
  files: PreparedFile[];
}

class FileTransaction {
  readonly #snapshots = new Map<string, FileSnapshot>();

  async capture(path: string): Promise<FileSnapshot> {
    const existing = this.#snapshots.get(path);
    if (existing) return existing;
    const snapshot = await snapshotFile(path);
    this.#snapshots.set(path, snapshot);
    return snapshot;
  }

  async write(path: string, content: Buffer | string, mode = 0o644): Promise<void> {
    await this.capture(path);
    await atomicWrite(path, content, mode);
  }

  async remove(path: string): Promise<void> {
    await this.capture(path);
    if (await pathExists(path)) await unlink(path);
  }

  async rollback(): Promise<string[]> {
    const failures: string[] = [];
    const entries = [...this.#snapshots.entries()].reverse();
    for (const [path, snapshot] of entries) {
      try {
        if (snapshot.exists) {
          if (!snapshot.content) throw new Error("rollback snapshot has no content");
          await atomicWrite(path, snapshot.content, snapshot.mode ?? 0o644);
        } else if (await pathExists(path)) {
          const info = await lstat(path);
          if (!info.isFile() && !info.isSymbolicLink()) {
            throw new Error("refusing to remove a non-file rollback target");
          }
          await unlink(path);
        }
      } catch (error) {
        failures.push(`${path}: ${errorMessage(error)}`);
      }
    }
    return failures;
  }
}

class NpmCacheTransaction {
  readonly #npmPath: string;
  readonly #temporaryRoot: string;
  readonly #backupPath: string;
  readonly #beforeExists: boolean;

  private constructor(
    npmPath: string,
    temporaryRoot: string,
    backupPath: string,
    beforeExists: boolean,
  ) {
    this.#npmPath = npmPath;
    this.#temporaryRoot = temporaryRoot;
    this.#backupPath = backupPath;
    this.#beforeExists = beforeExists;
  }

  static async create(project: string): Promise<NpmCacheTransaction> {
    const npmPath = join(project, ".pi", "npm");
    await assertSafeProjectTarget(project, join(npmPath, ".claude-pi-convert-probe"));
    let beforeExists = false;
    try {
      const info = await lstat(npmPath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Project Pi npm cache is not a regular directory: ${npmPath}.`);
      }
      beforeExists = true;
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "claude-pi-npm-rollback-"));
    const backupPath = join(temporaryRoot, "npm");
    try {
      if (beforeExists) {
        await cp(npmPath, backupPath, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      }
      return new NpmCacheTransaction(npmPath, temporaryRoot, backupPath, beforeExists);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async commit(): Promise<void> {
    await rm(this.#temporaryRoot, { recursive: true, force: true });
  }

  async rollback(): Promise<void> {
    await rm(this.#npmPath, { recursive: true, force: true });
    if (this.#beforeExists) {
      await mkdir(dirname(this.#npmPath), { recursive: true });
      try {
        await cp(this.#backupPath, this.#npmPath, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      } catch (error) {
        throw new Error(
          `Could not restore Pi npm cache; backup retained at ${this.#backupPath}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    await rm(this.#temporaryRoot, { recursive: true, force: true });
  }
}

/** Activate a converted package inside a Pi project. */
export async function activatePackage(options: ActivateOptions): Promise<OperationResult> {
  assertMinimumNodeVersion();
  const convertedDir = await resolveExistingDirectory(options.convertedDir, "converted package");
  const project = await resolveExistingDirectory(options.project, "project");
  const manifest = await readActivationManifest(convertedDir);
  const receiptPath = receiptPathFor(project, manifest.pluginId);
  await assertSafeProjectTarget(project, receiptPath);
  const existingReceipt = await readOptionalReceipt(receiptPath, project, manifest.pluginId);

  if (existingReceipt && !options.force) {
    throw new Error(
      `Plugin ${manifest.pluginId} is already activated. Re-run with --force to replace converter-owned files.`,
    );
  }

  const packageRoot = resolveManifestPath(convertedDir, manifest.packageRoot, "packageRoot");
  await assertPackageRoot(packageRoot, convertedDir);
  const dependencyChecks = await inspectPackageDependencies(packageRoot);
  const dependencyFailures = dependencyChecks.filter((check) => check.status !== "ok");
  if (dependencyFailures.length > 0) {
    const detail = dependencyFailures.map((check) => `- ${check.name}: ${check.message}`).join("\n");
    throw new Error(
      `Converted package dependencies are not ready:\n${detail}\nRun ${dependencyInstallCommand(packageRoot)} and retry. Dependency installation is never performed by --install-runtimes.`,
    );
  }
  const preparedFiles = await prepareActivationFiles(manifest, convertedDir, project);
  assertUniqueTargets(preparedFiles);
  const executableWarnings = await assertActivationExecutables(
    preparedFiles,
    manifest,
    packageRoot,
    project,
  );

  if (existingReceipt) validateReceiptOwnership(existingReceipt, manifest, project);
  await assertTargetsCanBeWritten(preparedFiles, project, existingReceipt, Boolean(options.force));

  const piVersion = await getPiVersion();
  if (piVersion !== TARGET_PI_VERSION) {
    throw new Error(`Pi ${TARGET_PI_VERSION} is required; found ${piVersion}.`);
  }

  const settingsPath = join(project, SETTINGS_RELATIVE_PATH);
  await assertSafeProjectTarget(project, settingsPath);
  const currentSettingsSnapshot = await snapshotFile(settingsPath);
  const settingsReplacementPlan = existingReceipt?.settings
    ? planSettingsRestore(existingReceipt.settings, currentSettingsSnapshot, true, project)
    : undefined;
  if (settingsReplacementPlan?.warnings.length) {
    throw new Error(
      `Cannot safely replace the existing settings activation: ${settingsReplacementPlan.warnings.join(" ")}`,
    );
  }
  const baselineSettingsSnapshot = settingsReplacementPlan?.result ?? currentSettingsSnapshot;
  const baselineSettings = parseJsonObjectSnapshot(
    baselineSettingsSnapshot,
    SETTINGS_RELATIVE_PATH,
  );
  const globalSettings = await readGlobalPiSettings();

  const requiredRuntimes = validateRuntimeRequirements(manifest.runtimeRequirements).filter(
    (requirement) => requirement.required,
  );
  assertNoProjectRuntimeIdentityConflicts(baselineSettings, requiredRuntimes, project);
  const missingRuntimes: RuntimeRequirement[] = [];
  for (const requirement of requiredRuntimes) {
    const state = await inspectRuntime(project, baselineSettings, globalSettings, requirement);
    if (!state.configured || !state.installed || !state.filterMatches) {
      missingRuntimes.push(requirement);
    }
  }
  if (missingRuntimes.length > 0 && !options.installRuntimes) {
    const commands = missingRuntimes
      .map(runtimeInstallCommand)
      .join("\n  ");
    throw new Error(
      `Required project-local Pi runtimes are missing or have the wrong version. Install them with:\n  ${commands}\nOr re-run activate with --install-runtimes.`,
    );
  }

  const mcpPath = join(project, MCP_RELATIVE_PATH);
  await assertSafeProjectTarget(project, mcpPath);
  const currentMcpSnapshot = await snapshotFile(mcpPath);
  const mcpReplacementPlan = existingReceipt?.mcp
    ? planMcpReceiptRestore(existingReceipt.mcp, currentMcpSnapshot, true)
    : undefined;
  if (mcpReplacementPlan?.warnings.length) {
    throw new Error(
      `Cannot safely replace the existing MCP activation: ${mcpReplacementPlan.warnings.join(" ")}`,
    );
  }
  const baselineMcpSnapshot = mcpReplacementPlan?.result ?? currentMcpSnapshot;
  const mcpPlan = planMcpMerge(baselineMcpSnapshot, manifest.mcpConfig);

  const changed = [
    ...plannedChangedPaths(
    preparedFiles,
    existingReceipt,
    Boolean(manifest.mcpConfig && mcpPlan.changed),
    true,
    receiptPath,
    project,
    ),
    ".pi/extensions/" + manifest.pluginSlug + "/index.ts",
    ".pi/extensions/" + manifest.pluginSlug + "/package",
  ];
  if (options.dryRun) {
    return {
      ok: true,
      changed,
      warnings: [
        ...executableWarnings,
        ...missingRuntimes.map(
          (requirement) =>
            `Would install npm:${requirement.packageName}@${requirement.version} project-locally.`,
        ),
      ],
      message: `Would activate ${manifest.pluginId}.`,
    };
  }

  const npmCacheTransaction =
    missingRuntimes.length > 0 ? await NpmCacheTransaction.create(project) : undefined;
  const transaction = new FileTransaction();
  const installedRuntimes: string[] = [];
  try {
    if (existingReceipt) {
      await restoreExistingActivationForReplacement(
        existingReceipt,
        project,
        transaction,
        baselineMcpSnapshot,
        baselineSettingsSnapshot,
      );
    }

    const fileReceipts: ReceiptFileChange[] = [];
    for (const prepared of preparedFiles) {
      const inherited = existingReceipt?.files.find(
        (change) => normalizeRelative(change.path) === prepared.targetRelative,
      );
      const before = inherited ? snapshotFromReceipt(inherited) : await snapshotFile(prepared.targetPath);
      await transaction.write(prepared.targetPath, prepared.content, prepared.mode);
      fileReceipts.push(receiptChange(prepared.targetRelative, before, prepared.content));
    }

    let mcpReceipt: McpReceipt | undefined;
    if (mcpPlan.changed) {
      const mcpContent = jsonBuffer(mcpPlan.merged);
      await transaction.write(mcpPath, mcpContent, baselineMcpSnapshot.mode ?? 0o600);
      mcpReceipt = {
        path: MCP_RELATIVE_PATH,
        addedServers: mcpPlan.addedServers,
        previousServers: mcpPlan.previousServers,
        ...(baselineMcpSnapshot.exists && baselineMcpSnapshot.content
          ? { beforeContentBase64: baselineMcpSnapshot.content.toString("base64") }
          : {}),
        ...(baselineMcpSnapshot.exists && baselineMcpSnapshot.mode !== undefined
          ? { beforeMode: baselineMcpSnapshot.mode }
          : {}),
        afterSha256: sha256(mcpContent),
        appliedServers: mcpPlan.appliedServers,
        appliedSettings: mcpPlan.appliedSettings,
      };
    }

    await transaction.capture(settingsPath);
    for (const requirement of missingRuntimes) {
      const source = runtimeSource(requirement);
      await runPi(["install", source, "-l", "--approve"], project, 5 * 60_000);
      await preserveSensitiveFileMode(settingsPath, baselineSettingsSnapshot.mode ?? 0o600);
      installedRuntimes.push(source);
    }
    if (requiredRuntimes.length > 0) {
      const runtimeSettingsSnapshot = await snapshotFile(settingsPath);
      const runtimeSettings = parseJsonObjectSnapshot(runtimeSettingsSnapshot, SETTINGS_RELATIVE_PATH);
      if (!Array.isArray(runtimeSettings.packages)) {
        runtimeSettings.packages = [];
        await transaction.write(
          settingsPath,
          jsonBuffer(runtimeSettings),
          runtimeSettingsSnapshot.mode ?? 0o600,
        );
      }
      await preserveSensitiveFileMode(settingsPath, baselineSettingsSnapshot.mode ?? 0o600);
      await applyRuntimeFilters(settingsPath, requiredRuntimes);
    }
    await copyExtensionPackage(packageRoot, join(project, ".pi", "extensions", manifest.pluginSlug), Boolean(options.force));

    const afterSettingsSnapshot = await snapshotFile(settingsPath);
    if (requiredRuntimes.length > 0 && (!afterSettingsSnapshot.exists || !afterSettingsSnapshot.content)) {
      throw new Error("Pi did not create a project-local .pi/settings.json file.");
    }
    const afterSettings = afterSettingsSnapshot.exists && afterSettingsSnapshot.content
      ? parseJsonObjectSnapshot(afterSettingsSnapshot, SETTINGS_RELATIVE_PATH)
      : baselineSettings;
    const afterGlobalSettings = await readGlobalPiSettings();
    for (const requirement of requiredRuntimes) {
      const state = await inspectRuntime(project, afterSettings, afterGlobalSettings, requirement);
      if (!state.configured || !state.installed || !state.filterMatches) {
        throw new Error(`Runtime verification failed after installation: ${state.source}.`);
      }
    }
    if (!snapshotsEqual(baselineSettingsSnapshot, afterSettingsSnapshot) && !afterSettingsSnapshot.content) {
      throw new Error("Project settings changed but could not be read for the activation receipt.");
    }
    const settingsReceipt: SettingsReceipt | undefined = snapshotsEqual(
      baselineSettingsSnapshot,
      afterSettingsSnapshot,
    )
      ? undefined
      : {
          ...receiptChange(
            SETTINGS_RELATIVE_PATH,
            baselineSettingsSnapshot,
            afterSettingsSnapshot.content as Buffer,
          ),
          appliedPackages: collectAppliedPackageChanges(
            baselineSettings,
            afterSettings,
            project,
            packageRoot,
            requiredRuntimes,
            false,
          ),
        };

    const receipt: ActivationReceipt = {
      schemaVersion: 1,
      pluginId: manifest.pluginId,
      pluginSlug: manifest.pluginSlug,
      convertedDir,
      project,
      activatedAt: new Date().toISOString(),
      files: fileReceipts,
      ...(mcpReceipt ? { mcp: mcpReceipt } : {}),
      ...(settingsReceipt ? { settings: settingsReceipt } : {}),
      installedRuntimes,
    };
    await transaction.write(receiptPath, jsonBuffer(receipt), 0o600);

    const warnings: string[] = [...executableWarnings];
    if (npmCacheTransaction) {
      try {
        await npmCacheTransaction.commit();
      } catch (error) {
        warnings.push(`Activation succeeded, but its temporary npm backup could not be removed: ${errorMessage(error)}`);
      }
    }

    return {
      ok: true,
      changed,
      warnings,
      message: `Activated ${manifest.pluginId}.`,
    };
  } catch (error) {
    const rollbackFailures = await transaction.rollback();
    if (npmCacheTransaction) {
      try {
        await npmCacheTransaction.rollback();
      } catch (rollbackError) {
        rollbackFailures.push(errorMessage(rollbackError));
      }
    }
    const suffix = rollbackFailures.length
      ? ` Rollback was incomplete: ${rollbackFailures.join("; ")}`
      : "";
    throw new Error(`Activation failed: ${errorMessage(error)}.${suffix}`, { cause: error });
  }
}

/** Activate a converted package in Pi's user/global scope (~/.pi/agent). */
export async function activateUserPackage(options: {
  convertedDir: string;
  installRuntimes?: boolean;
  force?: boolean;
  dryRun?: boolean;
}): Promise<OperationResult> {
  assertMinimumNodeVersion();
  const convertedDir = await resolveExistingDirectory(options.convertedDir, "converted package");
  const manifest = await readActivationManifest(convertedDir);
  if (manifest.mcpConfig && Object.keys(manifest.mcpConfig).length > 0) {
    throw new Error("User-level activation does not support converted MCP servers yet; activate this package with --project instead.");
  }
  const packageRoot = resolveManifestPath(convertedDir, manifest.packageRoot, "packageRoot");
  await assertPackageRoot(packageRoot, convertedDir);
  const dependencyChecks = await inspectPackageDependencies(packageRoot);
  const dependencyFailures = dependencyChecks.filter((check) => check.status !== "ok");
  if (dependencyFailures.length > 0) {
    throw new Error(`Converted package dependencies are not ready. Run ${dependencyInstallCommand(packageRoot)} and retry.`);
  }
  const agentDir = globalPiAgentDir();
  const required = validateRuntimeRequirements(manifest.runtimeRequirements).filter((item) => item.required);
  if (required.length > 0 && !options.installRuntimes) {
    throw new Error(`Required user-level Pi runtimes must be installed. Re-run with --install-runtimes or run:\n  ${required.map((item) => `pi install ${runtimeSource(item)}`).join("\n  ")}`);
  }
  const changed = [
    join(agentDir, "extensions", manifest.pluginSlug, "index.ts"),
    join(agentDir, "extensions", manifest.pluginSlug, "package"),
    ...manifest.agents.map((entry) => join(agentDir, "agents", basename(entry.target))),
    ...(manifest.skillFiles ?? []).map((entry) => join(agentDir, "skills", basename(entry.target))),
  ];
  if (options.dryRun) return { ok: true, changed, warnings: [], message: `Would activate ${manifest.pluginId} for the Pi user scope.` };
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const requirement of required) await runPi(["install", runtimeSource(requirement), "--approve"], agentDir, 5 * 60_000);
  await copyExtensionPackage(packageRoot, join(agentDir, "extensions", manifest.pluginSlug), Boolean(options.force));
  for (const entry of manifest.agents) {
    const source = resolveManifestPath(convertedDir, entry.source, "global agent source");
    const target = join(agentDir, "agents", basename(entry.target));
    if (await pathExists(target) && !options.force) throw new Error(`Refusing to overwrite global agent: ${target}. Use --force if it is converter-owned.`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { force: options.force === true, preserveTimestamps: true });
  }
  for (const entry of manifest.skillFiles ?? []) {
    const source = resolveManifestPath(convertedDir, entry.source, "global skill source");
    const target = join(agentDir, "skills", basename(entry.target));
    if (await pathExists(target) && !options.force) throw new Error(`Refusing to overwrite global skill: ${target}. Use --force if it is converter-owned.`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, force: options.force === true, preserveTimestamps: true });
  }
  return { ok: true, changed, warnings: [], message: `Activated ${manifest.pluginId} for all Pi projects in ${agentDir}.` };
}

/** Copy a portable converted package below Pi's auto-discovered extension directory. */
async function copyExtensionPackage(packageRoot: string, extensionRoot: string, force: boolean): Promise<void> {
  if (await pathExists(extensionRoot) && !force) {
    throw new Error(`Refusing to overwrite extension: ${extensionRoot}. Use --force to replace it.`);
  }
  if (await pathExists(extensionRoot)) await rm(extensionRoot, { recursive: true, force: true });
  const copiedPackageRoot = join(extensionRoot, "package");
  await mkdir(extensionRoot, { recursive: true, mode: 0o700 });
  await cp(packageRoot, copiedPackageRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const hasAgentGuard = await pathExists(join(copiedPackageRoot, "extensions", "agent-guard.ts"));
  const wrapper = hasAgentGuard
    ? [
      'import main from "./package/extensions/main.ts";',
      'import agentGuard from "./package/extensions/agent-guard.ts";',
      "",
      "export default function convertedClaudePlugin(pi: any) {",
      "  main(pi);",
      "  agentGuard(pi);",
      "}",
      "",
    ].join("\n")
    : 'export { default } from "./package/extensions/main.ts";\n';
  await atomicWrite(join(extensionRoot, "index.ts"), wrapper, 0o644);
}

/** Remove a previously activated package without overwriting user modifications. */
export async function deactivatePackage(options: DeactivateOptions): Promise<OperationResult> {
  const project = await resolveExistingDirectory(options.project, "project");
  const pluginId = await resolvePluginId(options.convertedDirOrPluginId, project);
  const receiptPath = receiptPathFor(project, pluginId);
  await assertSafeProjectTarget(project, receiptPath);
  const receipt = await readRequiredReceipt(receiptPath, project, pluginId);
  const changed: string[] = [];
  const warnings: string[] = [];

  for (const change of receipt.files) {
    await restoreReceiptChange(change, project, Boolean(options.force), options.dryRun, changed, warnings);
  }
  if (receipt.mcp) {
    await restoreMcpReceipt(receipt.mcp, project, Boolean(options.force), options.dryRun, changed, warnings);
  }
  if (receipt.settings) {
    await restoreSettingsReceipt(
      receipt.settings,
      project,
      Boolean(options.force),
      options.dryRun,
      changed,
      warnings,
    );
  }

  if (warnings.length === 0) {
    changed.push(projectRelative(project, receiptPath));
    if (!options.dryRun) {
      await unlink(receiptPath);
      await pruneEmptyDirectories(dirname(receiptPath), join(project, ".pi"));
      for (const change of receipt.files) {
        await pruneEmptyDirectories(dirname(resolveReceiptTarget(project, change.path)), join(project, ".pi"));
      }
    }
  } else {
    warnings.push(
      `Receipt retained at ${projectRelative(project, receiptPath)} so deactivation can be retried.`,
    );
  }

  return {
    ok: warnings.length === 0,
    changed: uniqueStrings(changed),
    warnings,
    message: options.dryRun
      ? `Would deactivate ${pluginId}${warnings.length ? " partially" : ""}.`
      : warnings.length
        ? `Partially deactivated ${pluginId}; modified files were preserved.`
        : `Deactivated ${pluginId}.`,
  };
}

/** Diagnose a converted package and its activation in a project. */
export async function doctorPackage(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const convertedInput = resolve(options.convertedDir);
  const projectInput = resolve(options.project);
  let convertedDir = convertedInput;
  let project = projectInput;

  try {
    convertedDir = await resolveExistingDirectory(convertedInput, "converted package");
    checks.push(okCheck("converted-dir", `Converted package exists at ${convertedDir}.`));
  } catch (error) {
    checks.push(errorCheck("converted-dir", errorMessage(error)));
  }
  try {
    project = await resolveExistingDirectory(projectInput, "project");
    checks.push(okCheck("project-dir", `Project exists at ${project}.`));
  } catch (error) {
    checks.push(errorCheck("project-dir", errorMessage(error)));
  }

  const nodeVersion = process.versions.node;
  checks.push(
    compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0
      ? okCheck("node-version", `Node ${nodeVersion} satisfies >=${MIN_NODE_VERSION}.`)
      : errorCheck("node-version", `Node >=${MIN_NODE_VERSION} is required; found ${nodeVersion}.`),
  );
  try {
    await assertExecutablePath(process.execPath, "Node executable");
    checks.push(okCheck("node-executable", `Node executable is available at ${process.execPath}.`));
  } catch (error) {
    checks.push(errorCheck("node-executable", errorMessage(error)));
  }
  const piExecutable = await findExecutable("pi");
  checks.push(
    piExecutable
      ? okCheck("pi-executable", `Pi executable is available at ${piExecutable}.`)
      : errorCheck("pi-executable", "Pi executable was not found on PATH or is not executable."),
  );
  try {
    const piVersion = await getPiVersion();
    checks.push(
      piVersion === TARGET_PI_VERSION
        ? okCheck("pi-version", `Pi ${piVersion} matches the target version.`)
        : warningCheck(
            "pi-version",
            `This converter targets Pi ${TARGET_PI_VERSION}; found ${piVersion}. Activation will require the exact target version.`,
          ),
    );
  } catch (error) {
    checks.push(errorCheck("pi-version", errorMessage(error)));
  }

  let manifest: ActivationManifest | undefined;
  if (!checks.some((check) => check.id === "converted-dir" && check.status === "error")) {
    try {
      manifest = await readActivationManifest(convertedDir);
      checks.push(okCheck("manifest", `Activation manifest for ${manifest.pluginId} is valid.`));
      const packageRoot = resolveManifestPath(convertedDir, manifest.packageRoot, "packageRoot");
      await assertPackageRoot(packageRoot, convertedDir);
      checks.push(okCheck("package-root", `Pi package root exists at ${packageRoot}.`));
      await diagnosePackageDependencies(packageRoot, checks);
    } catch (error) {
      checks.push(errorCheck("manifest", errorMessage(error)));
    }
  }

  if (manifest && !checks.some((check) => check.id === "project-dir" && check.status === "error")) {
    const settingsPath = join(project, SETTINGS_RELATIVE_PATH);
    let settings: Record<string, unknown> = {};
    let globalSettings: Record<string, unknown> = {};
    try {
      settings = parseJsonObjectSnapshot(await snapshotFile(settingsPath), SETTINGS_RELATIVE_PATH);
      globalSettings = await readGlobalPiSettings();
      checks.push(okCheck("settings", "Project Pi settings are readable."));
    } catch (error) {
      checks.push(errorCheck("settings", errorMessage(error)));
    }

    try {
      for (const requirement of validateRuntimeRequirements(manifest.runtimeRequirements).filter(
        (candidate) => candidate.required,
      )) {
        const conflict = projectRuntimeIdentityConflict(settings, requirement, project);
        if (conflict) {
          checks.push(
            errorCheck(`runtime-${requirement.id}-identity`, conflict, {
              expectedSource: runtimeSource(requirement),
              installCommand: runtimeInstallCommand(requirement),
            }),
          );
          if (manifest.webAccessRequired && requirement.id === "pi-web-access") {
            checks.push(
              errorCheck(
                "web-tools",
                "Cannot verify web_search/fetch_content while the pi-web-access package identity conflicts.",
              ),
            );
          }
          continue;
        }
        const state = await inspectRuntime(project, settings, globalSettings, requirement);
        const id = `runtime-${requirement.id}`;
        if (!state.configured) {
          checks.push(errorCheck(`${id}-config`, `${state.source} is not configured.`));
        } else {
          checks.push(
            okCheck(
              `${id}-config`,
              `${state.source} is configured in ${state.scope ?? "an unknown"} scope.`,
              { scope: state.scope, source: state.source },
            ),
          );
        }
        if (!state.installed) {
          checks.push(
            errorCheck(
              `${id}-package`,
              `${state.source} is not installed at the exact package path/version.`,
              {
                packagePath: state.packagePath,
                expectedName: requirement.packageName,
                installedName: state.installedName,
                expectedVersion: requirement.version,
                installedVersion: state.installedVersion,
              },
            ),
          );
        } else {
          checks.push(
            okCheck(`${id}-package`, `${state.source} is installed at ${state.packagePath}.`, {
              packagePath: state.packagePath,
              name: state.installedName,
              version: state.installedVersion,
            }),
          );
        }
        if (!state.filterMatches) {
          checks.push(
            warningCheck(`${id}-filter`, `${state.source} resource filters differ.`, {
              expected: requirement.resourceFilter ?? null,
            }),
          );
        } else {
          checks.push(
            okCheck(
              `${id}-filter`,
              requirement.resourceFilter
                ? `${state.source} has the expected resource filters.`
                : `${state.source} does not require an activation resource filter.`,
              { expected: requirement.resourceFilter ?? null },
            ),
          );
        }
        if (manifest.webAccessRequired && requirement.id === "pi-web-access") {
          await diagnoseWebAccessTools(state, settings, globalSettings, checks);
        }
      }
    } catch (error) {
      checks.push(errorCheck("runtime-requirements", errorMessage(error)));
    }

    const receiptPath = receiptPathFor(project, manifest.pluginId);
    try {
      const receipt = await readRequiredReceipt(receiptPath, project, manifest.pluginId);
      checks.push(okCheck("receipt", `Activation receipt exists at ${projectRelative(project, receiptPath)}.`));
      if (process.platform !== "win32") {
        const receiptMode = (await stat(receiptPath)).mode & 0o777;
        checks.push(
          (receiptMode & 0o077) === 0
            ? okCheck("receipt-permissions", `Activation receipt permissions are ${receiptMode.toString(8)}.`)
            : warningCheck(
                "receipt-permissions",
                `Activation receipt should not be group/world-readable; found ${receiptMode.toString(8)}.`,
              ),
        );
      }
      if (resolve(receipt.convertedDir) !== convertedDir || !(await pathExists(receipt.convertedDir))) {
        checks.push(
          warningCheck(
            "converted-path",
            `Receipt points to a moved or missing package: ${receipt.convertedDir}.`,
          ),
        );
      } else {
        checks.push(okCheck("converted-path", "Receipt points to the current converted package."));
      }
      await diagnoseReceiptFiles(receipt, project, checks);
    } catch (error) {
      checks.push(errorCheck("receipt", errorMessage(error)));
    }

    await diagnoseLocalPackage(settings, convertedDir, manifest, project, checks);
    await diagnoseActivationTargets(manifest, convertedDir, project, checks);

    try {
      await diagnoseMcp(manifest, project, checks);
    } catch (error) {
      checks.push(errorCheck("mcp-config", errorMessage(error)));
    }
  }

  return {
    ok: !checks.some((check) => check.status === "error"),
    convertedDir,
    project,
    checks,
  };
}

async function readActivationManifest(convertedDir: string): Promise<ActivationManifest> {
  const path = join(convertedDir, MANIFEST_FILE);
  await assertRegularFile(path, "activation manifest", true, convertedDir);
  const raw = parseJsonObject(await readFile(path, "utf8"), path);
  if (raw.schemaVersion !== 1) throw new Error(`${path}: unsupported schemaVersion.`);
  const pluginId = requireSafeComponent(raw.pluginId, "pluginId");
  const pluginSlug = requireSafeComponent(raw.pluginSlug, "pluginSlug");
  if (typeof raw.packageRoot !== "string") throw new Error(`${path}: packageRoot must be a string.`);
  if (!Array.isArray(raw.agents) || !Array.isArray(raw.runtimeFiles)) {
    throw new Error(`${path}: agents and runtimeFiles must be arrays.`);
  }
  if (raw.skillFiles !== undefined && !Array.isArray(raw.skillFiles)) {
    throw new Error(`${path}: skillFiles must be an array when provided.`);
  }
  const agents = raw.agents.map((entry, index) => validateActivationFile(entry, `agents[${index}]`));
  const skillFiles = (raw.skillFiles ?? []).map((entry, index) =>
    validateActivationFile(entry, `skillFiles[${index}]`),
  );
  const runtimeFiles = raw.runtimeFiles.map((entry, index) =>
    validateActivationFile(entry, `runtimeFiles[${index}]`),
  );
  if (!Array.isArray(raw.runtimeRequirements)) {
    throw new Error(`${path}: runtimeRequirements must be an array.`);
  }
  const runtimeRequirements = validateRuntimeRequirements(raw.runtimeRequirements);
  if (typeof raw.webAccessRequired !== "boolean") {
    throw new Error(`${path}: webAccessRequired must be a boolean.`);
  }
  if (raw.mcpConfig !== undefined && !isRecord(raw.mcpConfig)) {
    throw new Error(`${path}: mcpConfig must be an object.`);
  }
  assertManifestRuntimeCoverage(
    agents,
    raw.mcpConfig as Record<string, unknown> | undefined,
    raw.webAccessRequired,
    runtimeRequirements,
  );
  return {
    schemaVersion: 1,
    pluginId,
    pluginSlug,
    packageRoot: raw.packageRoot,
    agents,
    ...(skillFiles.length > 0 ? { skillFiles } : {}),
    runtimeFiles,
    ...(raw.mcpConfig !== undefined ? { mcpConfig: raw.mcpConfig } : {}),
    runtimeRequirements,
    webAccessRequired: raw.webAccessRequired,
  };
}

function validateActivationFile(value: unknown, label: string): ActivationFile {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (typeof value.source !== "string" || typeof value.target !== "string") {
    throw new Error(`${label}.source and ${label}.target must be strings.`);
  }
  if (!(["agent", "runtime", "extension", "other"] as unknown[]).includes(value.kind)) {
    throw new Error(`${label}.kind is invalid.`);
  }
  if (
    value.mode !== undefined &&
    (!Number.isInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o777)
  ) {
    throw new Error(`${label}.mode must be an integer between 0 and 0777.`);
  }
  return {
    source: value.source,
    target: value.target,
    kind: value.kind as ActivationFile["kind"],
    ...(value.mode !== undefined ? { mode: value.mode as number } : {}),
  };
}

function validateRuntimeRequirements(values: unknown[]): RuntimeRequirement[] {
  const known: Map<string, (typeof RUNTIMES)[keyof typeof RUNTIMES]> = new Map(
    Object.values(RUNTIMES).map((runtime) => [runtime.id, runtime] as const),
  );
  const seen = new Set<string>();
  return values.map((value, index) => {
    if (!isRecord(value)) throw new Error(`runtimeRequirements[${index}] must be an object.`);
    if (typeof value.id !== "string" || seen.has(value.id)) {
      throw new Error(`runtimeRequirements[${index}].id is invalid or duplicated.`);
    }
    seen.add(value.id);
    const expected = known.get(value.id);
    if (!expected) throw new Error(`Untrusted runtime requirement: ${value.id}.`);
    if (
      value.packageName !== expected.packageName ||
      value.version !== expected.version ||
      value.source !== expected.source
    ) {
      throw new Error(
        `Runtime ${value.id} must exactly match ${expected.packageName}@${expected.version} from ${expected.source}.`,
      );
    }
    if (typeof value.reason !== "string" || typeof value.required !== "boolean") {
      throw new Error(`runtimeRequirements[${index}] has invalid reason or required fields.`);
    }
    const resourceFilter = validateResourceFilter(value.resourceFilter, index);
    if (
      value.id === "pi-web-access" &&
      (!resourceFilter || !Array.isArray(resourceFilter.skills) || resourceFilter.skills.length !== 0)
    ) {
      throw new Error(
        "pi-web-access must declare resourceFilter.skills=[] so its librarian skill is not auto-loaded.",
      );
    }
    return {
      id: value.id as RuntimeRequirement["id"],
      source: expected.source,
      packageName: expected.packageName,
      version: expected.version,
      reason: value.reason,
      required: value.required,
      ...(resourceFilter ? { resourceFilter } : {}),
    };
  });
}

function validateResourceFilter(
  value: unknown,
  index: number,
): RuntimeRequirement["resourceFilter"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`runtimeRequirements[${index}].resourceFilter is invalid.`);
  const result: NonNullable<RuntimeRequirement["resourceFilter"]> = {};
  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const entries = value[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) {
      throw new Error(`runtimeRequirements[${index}].resourceFilter.${key} must be strings.`);
    }
    result[key] = [...entries];
  }
  return result;
}

function assertManifestRuntimeCoverage(
  agents: ActivationFile[],
  mcpConfig: Record<string, unknown> | undefined,
  webAccessRequired: boolean,
  requirements: RuntimeRequirement[],
): void {
  const requiredIds = new Set(
    requirements.filter((requirement) => requirement.required).map((requirement) => requirement.id),
  );
  if (agents.length > 0 && !requiredIds.has("pi-subagents")) {
    throw new Error("Agent activation requires the exact pi-subagents runtime requirement.");
  }
  if (mcpConfig && Object.keys(mcpConfig).length > 0 && !requiredIds.has("pi-mcp-adapter")) {
    throw new Error("MCP activation requires the exact pi-mcp-adapter runtime requirement.");
  }
  if (webAccessRequired && !requiredIds.has("pi-web-access")) {
    throw new Error("Web tool conversion requires the exact pi-web-access runtime requirement.");
  }
}

async function prepareActivationFiles(
  manifest: ActivationManifest,
  convertedDir: string,
  project: string,
): Promise<PreparedFile[]> {
  const result: PreparedFile[] = [];
  for (const [group, entries] of [
    ["agent", manifest.agents],
    ["skill", manifest.skillFiles ?? []],
    ["runtime", manifest.runtimeFiles],
  ] as const) {
    for (const entry of entries) {
      const sourcePath = resolveManifestPath(convertedDir, entry.source, `${group} source`);
      const targetRelative = normalizeRelative(entry.target);
      assertActivationTargetPrefix(
        targetRelative,
        group,
        manifest.pluginId,
        manifest.pluginSlug,
      );
      const sourceInfo = await lstat(sourcePath);
      if (sourceInfo.isSymbolicLink()) {
        throw new Error(`${group} source may not be a symlink: ${entry.source}.`);
      }
      if (group === "skill" && sourceInfo.isDirectory()) {
        await assertRegularFile(
          join(sourcePath, "SKILL.md"),
          "skill directory SKILL.md",
          true,
          convertedDir,
        );
        for (const child of await collectDirectoryFiles(sourcePath, convertedDir)) {
          const childSource = `${normalizeRelative(entry.source)}/${child.relativePath}`;
          const childTarget = `${targetRelative}/${child.relativePath}`;
          const targetPath = resolveProjectRelative(project, childTarget, "skill target");
          await assertSafeProjectTarget(project, targetPath);
          const childEntry: ActivationFile = {
            source: childSource,
            target: childTarget,
            kind: "other",
            mode: child.mode,
          };
          result.push({
            entry: childEntry,
            sourcePath: child.path,
            targetPath,
            targetRelative: childTarget,
            content: await readFile(child.path),
            mode: child.mode,
            sourceMode: child.mode,
          });
        }
        continue;
      }
      if (!sourceInfo.isFile()) throw new Error(`${group} source is not a regular file: ${entry.source}.`);
      const actualSource = await realpath(sourcePath);
      assertContained(convertedDir, actualSource, `${group} source symlink`);
      const targetPath = resolveProjectRelative(project, targetRelative, `${group} target`);
      await assertSafeProjectTarget(project, targetPath);
      result.push({
        entry,
        sourcePath,
        targetPath,
        targetRelative,
        content: await readFile(sourcePath),
        mode: entry.mode ?? (sourceInfo.mode & 0o777),
        sourceMode: sourceInfo.mode & 0o777,
      });
    }
  }
  return result;
}

async function collectDirectoryFiles(
  root: string,
  allowedRoot: string,
  relativeDirectory = "",
): Promise<Array<{ path: string; relativePath: string; mode: number }>> {
  const directory = relativeDirectory
    ? resolve(root, ...relativeDirectory.split("/"))
    : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const names = new Set<string>();
  const result: Array<{ path: string; relativePath: string; mode: number }> = [];
  for (const entry of entries) {
    const caseKey = entry.name.toLocaleLowerCase("en-US");
    if (names.has(caseKey)) {
      throw new Error(`Case-insensitive skill asset collision in ${directory}: ${entry.name}.`);
    }
    names.add(caseKey);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const path = resolve(root, ...relativePath.split("/"));
    assertContained(root, path, "skill asset");
    if (entry.isSymbolicLink()) throw new Error(`Skill assets may not be symlinks: ${path}.`);
    if (entry.isDirectory()) {
      result.push(...(await collectDirectoryFiles(root, allowedRoot, relativePath)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Skill asset is not a regular file: ${path}.`);
    const actual = await realpath(path);
    assertContained(allowedRoot, actual, "skill asset symlink");
    const info = await stat(path);
    result.push({ path, relativePath, mode: info.mode & 0o777 });
  }
  return result;
}

async function assertActivationExecutables(
  files: PreparedFile[],
  manifest: ActivationManifest,
  packageRoot: string,
  project: string,
): Promise<string[]> {
  await assertExecutablePath(process.execPath, "Node executable");
  const piPath = await findExecutable("pi");
  if (!piPath) throw new Error("Pi executable was not found on PATH or is not executable.");
  for (const file of files) {
    const sourceExecutable = (file.sourceMode & 0o111) !== 0;
    const targetExecutable = (file.mode & 0o111) !== 0;
    const isLauncher = basename(file.targetPath) === "mcp-launcher.mjs";
    if (sourceExecutable && !targetExecutable) {
      throw new Error(`Executable bit would be lost for runtime file ${file.entry.source}.`);
    }
    if ((targetExecutable || isLauncher) && !sourceExecutable) {
      throw new Error(`Runtime executable is not executable in the converted package: ${file.entry.source}.`);
    }
    if (isLauncher && !targetExecutable) {
      throw new Error(`MCP launcher must be activated with executable permissions: ${file.entry.target}.`);
    }
  }
  if (jsonContainsString(manifest.mcpConfig, "mcp-launcher.mjs")) {
    const launcher = files.find((file) => basename(file.targetPath) === "mcp-launcher.mjs");
    if (!launcher) throw new Error("MCP configuration references mcp-launcher.mjs, but it is missing.");
  }

  const context: ExecutablePreflightContext = {
    packageRoot,
    originalRoot: join(packageRoot, "original"),
    activationRuntimeRoot: join(packageRoot, "activation", "runtime"),
    project,
    manifest,
    files,
  };
  const packageManifest = await readPackageManifestForExecutablePreflight(packageRoot);
  await assertPackageBinExecutables(packageManifest, context);
  const commands = await collectStaticCommandSpecs(packageManifest, context);
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const key = canonicalJson(command);
    if (seen.has(key)) continue;
    seen.add(key);
    await assertStaticCommandExecutable(command, context, warnings);
  }
  return uniqueStrings(warnings);
}

async function readPackageManifestForExecutablePreflight(
  packageRoot: string,
): Promise<Record<string, unknown>> {
  const packageJsonPath = join(packageRoot, "package.json");
  return parseJsonObject(await readFile(packageJsonPath, "utf8"), packageJsonPath);
}

async function assertPackageBinExecutables(
  packageManifest: Record<string, unknown>,
  context: ExecutablePreflightContext,
): Promise<void> {
  if (packageManifest.bin === undefined) return;
  const entries: Array<[string, unknown]> =
    typeof packageManifest.bin === "string"
      ? [[typeof packageManifest.name === "string" ? packageManifest.name : "package", packageManifest.bin]]
      : isRecord(packageManifest.bin)
        ? Object.entries(packageManifest.bin)
        : [];
  if (!isRecord(packageManifest.bin) && typeof packageManifest.bin !== "string") {
    throw new Error("Converted package bin must be a path string or an object of path strings.");
  }
  for (const [name, rawTarget] of entries) {
    if (typeof rawTarget !== "string") {
      throw new Error(`Converted package bin ${name} must reference a string path.`);
    }
    const target = resolvePackageResource(context.packageRoot, rawTarget, `package bin ${name}`);
    await assertRegularFile(target, `package bin ${name}`, true, context.packageRoot);
    await assertExecutablePath(target, `Converted package bin ${name}`);
  }
}

async function collectStaticCommandSpecs(
  packageManifest: Record<string, unknown>,
  context: ExecutablePreflightContext,
): Promise<StaticCommandSpec[]> {
  const commands: StaticCommandSpec[] = [];
  collectMcpCommandSpecs(context.manifest.mcpConfig, commands);

  const pi = isRecord(packageManifest.pi) ? packageManifest.pi : undefined;
  const extensions = pi?.extensions;
  if (extensions !== undefined && !Array.isArray(extensions)) {
    throw new Error("Converted package pi.extensions must be an array.");
  }
  for (const [index, rawExtension] of (extensions ?? []).entries()) {
    if (typeof rawExtension !== "string") {
      throw new Error(`Converted package pi.extensions[${index}] must be a string.`);
    }
    if (!isRelativePackageResource(rawExtension)) continue;
    const extensionPath = resolvePackageResource(
      context.packageRoot,
      rawExtension,
      `package extension ${rawExtension}`,
    );
    await assertRegularFile(
      extensionPath,
      `package extension ${rawExtension}`,
      true,
      context.packageRoot,
    );
    const source = await readFile(extensionPath, "utf8");
    collectExtensionCommandSpecs(source, rawExtension, commands);
  }

  for (const launcher of context.files.filter(
    (file) => basename(file.sourcePath) === "mcp-launcher.mjs",
  )) {
    const source = launcher.content.toString("utf8");
    const servers = extractGeneratedJsonConstant(source, "SERVERS", launcher.entry.source);
    if (servers === undefined) {
      throw new Error(`Generated MCP launcher has no static SERVERS inventory: ${launcher.entry.source}.`);
    }
    if (!Array.isArray(servers)) {
      throw new Error(`Generated MCP launcher SERVERS inventory is invalid: ${launcher.entry.source}.`);
    }
    for (const [index, server] of servers.entries()) {
      const record = requireStaticCommandRecord(
        server,
        `MCP launcher ${launcher.entry.source} server[${index}]`,
      );
      commands.push(commandSpecFromRecord(record, `MCP launcher original server ${readStaticName(record, index)}`, false));
    }
  }
  return commands;
}

function collectMcpCommandSpecs(
  mcpConfig: Record<string, unknown> | undefined,
  commands: StaticCommandSpec[],
): void {
  if (!mcpConfig || !isRecord(mcpConfig.mcpServers)) return;
  for (const [name, value] of Object.entries(mcpConfig.mcpServers)) {
    if (!isRecord(value) || value.command === undefined) continue;
    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      throw new Error(`MCP server ${name} has an invalid executable command.`);
    }
    commands.push(commandSpecFromRecord(value, `MCP server ${name}`, false));
  }
}

function collectExtensionCommandSpecs(
  source: string,
  extension: string,
  commands: StaticCommandSpec[],
): void {
  const hooks = extractGeneratedJsonConstant(source, "HOOKS", extension);
  if (hooks !== undefined) {
    if (!Array.isArray(hooks)) throw new Error(`${extension}: generated HOOKS inventory is invalid.`);
    for (const [hookIndex, hook] of hooks.entries()) {
      if (!isRecord(hook) || !Array.isArray(hook.handlers)) {
        throw new Error(`${extension}: generated HOOKS[${hookIndex}] is invalid.`);
      }
      const event = typeof hook.event === "string" ? hook.event : String(hookIndex);
      for (const [handlerIndex, handler] of hook.handlers.entries()) {
        if (!isRecord(handler) || handler.type !== "command") continue;
        commands.push(
          commandSpecFromRecord(
            requireStaticCommandRecord(
              handler,
              `${extension} hook ${event} handler[${handlerIndex}]`,
            ),
            `hook ${event} handler[${handlerIndex}]`,
            handler.shell !== false,
          ),
        );
      }
    }
  }

  for (const [constantName, label] of [
    ["MONITORS", "monitor"],
    ["LSP_SERVERS", "LSP server"],
  ] as const) {
    const inventory = extractGeneratedJsonConstant(source, constantName, extension);
    if (inventory === undefined) continue;
    if (!Array.isArray(inventory)) {
      throw new Error(`${extension}: generated ${constantName} inventory is invalid.`);
    }
    for (const [index, value] of inventory.entries()) {
      const record = requireStaticCommandRecord(
        value,
        `${extension} ${constantName}[${index}]`,
      );
      commands.push(
        commandSpecFromRecord(
          record,
          `${label} ${readStaticName(record, index)}`,
          constantName === "MONITORS" && !Array.isArray(record.args),
        ),
      );
    }
  }
}

function requireStaticCommandRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error(`${label} has no valid executable command.`);
  }
  return value;
}

function commandSpecFromRecord(
  record: Record<string, unknown>,
  label: string,
  shell: boolean,
): StaticCommandSpec {
  const args = Array.isArray(record.args)
    ? record.args.filter((value): value is string => typeof value === "string")
    : undefined;
  if (Array.isArray(record.args) && args?.length !== record.args.length) {
    throw new Error(`${label} has a non-string executable argument.`);
  }
  const env = isRecord(record.env)
    ? Object.fromEntries(
        Object.entries(record.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined;
  if (isRecord(record.env) && Object.keys(env ?? {}).length !== Object.keys(record.env).length) {
    throw new Error(`${label} has a non-string environment value.`);
  }
  return {
    label,
    command: record.command as string,
    ...(args ? { args } : {}),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(env ? { env } : {}),
    shell,
  };
}

function readStaticName(record: Record<string, unknown>, fallback: number): string {
  for (const key of ["name", "id", "label"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key] as string;
  }
  return String(fallback);
}

function extractGeneratedJsonConstant(
  source: string,
  name: string,
  sourceLabel: string,
): unknown | undefined {
  const match = new RegExp(`^[ \\t]*const\\s+${name}\\s*=\\s*`, "m").exec(source);
  if (!match) return undefined;
  let start = match.index + match[0].length;
  while (/\s/.test(source[start] ?? "")) start += 1;
  const end = findStaticJsonEnd(source, start);
  if (end === undefined) throw new Error(`${sourceLabel}: cannot parse generated ${name} inventory.`);
  try {
    return JSON.parse(source.slice(start, end)) as unknown;
  } catch (error) {
    throw new Error(`${sourceLabel}: generated ${name} inventory is not valid JSON.`, { cause: error });
  }
}

function findStaticJsonEnd(source: string, start: number): number | undefined {
  const first = source[start];
  if (first !== "[" && first !== "{") {
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === ";") return index;
    }
    return undefined;
  }
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") stack.push(character);
    else if (character === "]" || character === "}") {
      const expected = character === "]" ? "[" : "{";
      if (stack.pop() !== expected) return undefined;
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

async function assertStaticCommandExecutable(
  spec: StaticCommandSpec,
  context: ExecutablePreflightContext,
  warnings: string[],
): Promise<void> {
  if (spec.shell) {
    warnings.push(
      `Skipped static executable validation for ${spec.label}; its raw shell command must be reviewed manually.`,
    );
    return;
  }
  const command = expandStaticRuntimeValue(spec.command, spec.env, context);
  if (hasUnresolvedRuntimeVariable(command)) {
    warnings.push(
      `Skipped static executable validation for ${spec.label}; command ${JSON.stringify(spec.command)} contains a runtime-only variable.`,
    );
    return;
  }
  const resolvedCommand = await resolveStaticExecutable(command, spec, context);
  if (!resolvedCommand) {
    throw new Error(
      `Executable preflight failed for ${spec.label}: ${JSON.stringify(spec.command)} was not found or is not executable in the converted plugin runtime or effective PATH.`,
    );
  }
  await assertInterpreterEntrypoint(spec, resolvedCommand, context, warnings);
}

async function resolveStaticExecutable(
  command: string,
  spec: StaticCommandSpec,
  context: ExecutablePreflightContext,
): Promise<string | undefined> {
  if (!isPathLikeCommand(command)) {
    return findExecutableInDirectories(command, staticCommandSearchDirectories(spec, context));
  }
  for (const candidate of staticPathCandidates(command, spec.cwd, spec.env, context)) {
    if (await isExecutableFile(candidate)) {
      assertActivatedRuntimeSource(candidate, context, spec.label);
      return candidate;
    }
  }
  return undefined;
}

function staticCommandSearchDirectories(
  spec: StaticCommandSpec,
  context: ExecutablePreflightContext,
): string[] {
  const configuredPath = Object.entries(spec.env ?? {}).find(([key]) => key.toLowerCase() === "path")?.[1];
  const pathValue = expandStaticRuntimeValue(configuredPath ?? process.env.PATH ?? "", spec.env, context);
  return uniqueStrings([
    join(context.originalRoot, "bin"),
    ...pathValue
      .split(delimiter)
      .filter((entry) => entry.length > 0 && !hasUnresolvedRuntimeVariable(entry))
      .map((entry) => (isAbsolute(entry) ? entry : resolve(context.project, entry))),
  ]);
}

function staticPathCandidates(
  input: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  context: ExecutablePreflightContext,
): string[] {
  const mapped = mapActivatedRuntimePath(input, context);
  if (mapped) return [mapped];
  if (isAbsolute(input)) return [resolve(input)];
  const candidates: string[] = [];
  if (cwd) {
    const expandedCwd = expandStaticRuntimeValue(cwd, env, context);
    const mappedCwd = mapActivatedRuntimePath(expandedCwd, context);
    if (mappedCwd) {
      const candidate = resolve(mappedCwd, input);
      if (
        isContained(context.originalRoot, candidate) ||
        isContained(context.activationRuntimeRoot, candidate)
      ) {
        candidates.push(candidate);
      }
    }
    else if (isAbsolute(expandedCwd) && !hasUnresolvedRuntimeVariable(expandedCwd)) {
      candidates.push(resolve(expandedCwd, input));
    }
  }
  const originalCandidate = resolve(context.originalRoot, input);
  const activationCandidate = resolve(context.activationRuntimeRoot, input);
  if (isContained(context.originalRoot, originalCandidate)) candidates.push(originalCandidate);
  if (isContained(context.activationRuntimeRoot, activationCandidate)) {
    candidates.push(activationCandidate);
  }
  return uniqueStrings(candidates);
}

function mapActivatedRuntimePath(
  input: string,
  context: ExecutablePreflightContext,
): string | undefined {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
  for (const file of context.files) {
    if (normalizeRelative(file.entry.target) === normalized) return file.sourcePath;
  }
  const activePrefix = `.pi/claude-pi-convert/${context.manifest.pluginId}/runtime/`;
  if (!normalized.startsWith(activePrefix)) return undefined;
  const suffix = normalizeRelative(normalized.slice(activePrefix.length));
  if (suffix.startsWith("original/")) {
    const target = resolve(context.originalRoot, ...suffix.slice("original/".length).split("/"));
    assertContained(context.originalRoot, target, "activated original runtime path");
    return target;
  }
  const target = resolve(context.activationRuntimeRoot, ...suffix.split("/"));
  assertContained(context.activationRuntimeRoot, target, "activation runtime path");
  return target;
}

function expandStaticRuntimeValue(
  input: string,
  _configuredEnv: Record<string, string> | undefined,
  context: ExecutablePreflightContext,
): string {
  const values: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: context.originalRoot,
    CLAUDE_PLUGIN_DATA: join(context.activationRuntimeRoot, "data"),
    CLAUDE_PROJECT_DIR: context.project,
  };
  return input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/gi,
    (match, braced: string | undefined, windowsEnv: string | undefined, plain: string | undefined) => {
      const key = braced ?? windowsEnv ?? plain;
      return key !== undefined && values[key] !== undefined ? String(values[key]) : match;
    },
  );
}

function hasUnresolvedRuntimeVariable(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*/i.test(value);
}

function isPathLikeCommand(command: string): boolean {
  return isAbsolute(command) || command.startsWith(".") || command.includes("/") || command.includes("\\");
}

async function findExecutableInDirectories(
  command: string,
  directories: string[],
): Promise<string | undefined> {
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")]
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertActivatedRuntimeSource(
  path: string,
  context: ExecutablePreflightContext,
  label: string,
): void {
  const inOriginal = isContained(context.originalRoot, path);
  const inActivationRuntime = isContained(context.activationRuntimeRoot, path);
  if (!inOriginal && !inActivationRuntime) return;
  if (context.files.some((file) => resolve(file.sourcePath) === resolve(path))) return;
  throw new Error(
    `Executable preflight failed for ${label}: ${path} exists in the converted package but is not included in activation runtimeFiles.`,
  );
}

async function assertInterpreterEntrypoint(
  spec: StaticCommandSpec,
  resolvedCommand: string,
  context: ExecutablePreflightContext,
  warnings: string[],
): Promise<void> {
  const argument = interpreterEntrypointArgument(basename(resolvedCommand), spec.args ?? []);
  if (!argument) return;
  const expanded = expandStaticRuntimeValue(argument, spec.env, context);
  if (hasUnresolvedRuntimeVariable(expanded)) {
    warnings.push(
      `Skipped static entrypoint validation for ${spec.label}; ${JSON.stringify(argument)} contains a runtime-only variable.`,
    );
    return;
  }
  const candidates = staticPathCandidates(expanded, spec.cwd, spec.env, context);
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      assertActivatedRuntimeSource(candidate, context, `${spec.label} entrypoint`);
      return;
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
  }
  throw new Error(
    `Executable preflight failed for ${spec.label}: interpreter entrypoint ${JSON.stringify(argument)} was not found in the converted plugin runtime.`,
  );
}

function interpreterEntrypointArgument(commandName: string, args: string[]): string | undefined {
  const command = commandName.toLocaleLowerCase("en-US").replace(/\.exe$/, "");
  const interpreters = new Set(["node", "nodejs", "python", "python3", "ruby", "perl", "bash", "sh"]);
  if (!interpreters.has(command) || args.length === 0) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (["-e", "--eval", "-p", "--print", "-c", "-m"].includes(argument)) return undefined;
    if (["-r", "--require", "--loader", "--import", "--experimental-loader"].includes(argument)) {
      index += 1;
      continue;
    }
    if (argument === "--") return args[index + 1];
    if (!argument.startsWith("-")) return argument;
  }
  return undefined;
}

function resolvePackageResource(packageRoot: string, input: string, label: string): string {
  if (isAbsolute(input) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) {
    throw new Error(`${label} must be package-relative: ${input}.`);
  }
  const normalized = normalizeRelative(input, true);
  const target = resolve(packageRoot, ...normalized.split("/"));
  assertContained(packageRoot, target, label);
  return target;
}

function isRelativePackageResource(input: string): boolean {
  return input === "." || input.startsWith("./") || (!isAbsolute(input) && (input.includes("/") || input.includes("\\")));
}

function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertExecutablePath(path: string, label: string): Promise<void> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    throw new Error(`${label} is missing or not executable: ${path}.`, { cause: error });
  }
}

async function findExecutable(command: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        await access(
          candidate,
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

function jsonContainsString(value: unknown, fragment: string): boolean {
  if (typeof value === "string") return value.includes(fragment);
  if (Array.isArray(value)) return value.some((entry) => jsonContainsString(entry, fragment));
  return isRecord(value) && Object.values(value).some((entry) => jsonContainsString(entry, fragment));
}

function assertActivationTargetPrefix(
  target: string,
  group: "agent" | "skill" | "runtime",
  pluginId: string,
  pluginSlug: string,
): void {
  const required =
    group === "agent"
      ? ".pi/agents/"
      : group === "skill"
        ? `.pi/skills/${pluginSlug}-`
      : `.pi/claude-pi-convert/${pluginId}/runtime/`;
  if (!target.startsWith(required) || (group !== "skill" && target === required.slice(0, -1))) {
    throw new Error(`${group} target must be below ${required}.`);
  }
}

function assertUniqueTargets(files: PreparedFile[]): void {
  const targets = new Set<string>();
  const sources = new Set<string>();
  for (const file of files) {
    const targetKey = file.targetRelative.toLocaleLowerCase("en-US");
    const sourceKey = file.entry.source.toLocaleLowerCase("en-US");
    if (targets.has(targetKey)) throw new Error(`Duplicate activation target: ${file.targetRelative}.`);
    if (sources.has(sourceKey)) throw new Error(`Case-insensitive source collision: ${file.entry.source}.`);
    targets.add(targetKey);
    sources.add(sourceKey);
  }
}

async function assertTargetsCanBeWritten(
  files: PreparedFile[],
  project: string,
  receipt: ActivationReceipt | undefined,
  force: boolean,
): Promise<void> {
  const owned = new Set(receipt?.files.map((change) => normalizeRelative(change.path)) ?? []);
  for (const file of files) {
    await assertNoCaseCollision(project, file.targetRelative);
    const target = await snapshotFile(file.targetPath);
    if (!target.exists) continue;
    if (!force || !owned.has(file.targetRelative)) {
      throw new Error(`Refusing to overwrite unowned activation target: ${file.targetRelative}.`);
    }
  }
}

async function restoreExistingActivationForReplacement(
  receipt: ActivationReceipt,
  project: string,
  transaction: FileTransaction,
  baselineMcpSnapshot: FileSnapshot,
  baselineSettingsSnapshot: FileSnapshot,
): Promise<void> {
  for (const change of receipt.files) {
    const path = resolveReceiptTarget(project, change.path);
    await assertSafeProjectTarget(project, path);
    await transaction.capture(path);
    await restoreSnapshot(path, snapshotFromReceipt(change));
  }
  if (receipt.mcp) {
    const path = resolveReceiptTarget(project, receipt.mcp.path);
    await assertSafeProjectTarget(project, path);
    await transaction.capture(path);
    await restoreSnapshot(path, baselineMcpSnapshot);
  }
  if (receipt.settings) {
    const path = resolveReceiptTarget(project, receipt.settings.path);
    await assertSafeProjectTarget(project, path);
    await transaction.capture(path);
    await restoreSnapshot(path, baselineSettingsSnapshot);
  }
}

async function restoreReceiptChange(
  change: ReceiptFileChange,
  project: string,
  force: boolean,
  dryRun: boolean | undefined,
  changed: string[],
  warnings: string[],
): Promise<void> {
  const path = resolveReceiptTarget(project, change.path);
  await assertSafeProjectTarget(project, path);
  const current = await snapshotFile(path);
  const currentMatches =
    current.exists && current.content !== undefined && sha256(current.content) === change.afterSha256;
  const alreadyRestored = snapshotsEqual(current, snapshotFromReceipt(change));
  if (alreadyRestored) return;
  if (!currentMatches && !force) {
    warnings.push(`Preserved modified file ${normalizeRelative(change.path)}.`);
    return;
  }
  changed.push(normalizeRelative(change.path));
  if (!dryRun) await restoreSnapshot(path, snapshotFromReceipt(change));
}

async function restoreMcpReceipt(
  receipt: McpReceipt,
  project: string,
  force: boolean,
  dryRun: boolean | undefined,
  changed: string[],
  warnings: string[],
): Promise<void> {
  const path = resolveReceiptTarget(project, receipt.path);
  await assertSafeProjectTarget(project, path);
  const plan = planMcpReceiptRestore(receipt, await snapshotFile(path), force);
  warnings.push(...plan.warnings);
  if (!plan.changed) return;
  changed.push(normalizeRelative(receipt.path));
  if (!dryRun) await restoreSnapshot(path, plan.result);
}

async function restoreSettingsReceipt(
  receipt: SettingsReceipt,
  project: string,
  force: boolean,
  dryRun: boolean | undefined,
  changed: string[],
  warnings: string[],
): Promise<void> {
  const path = resolveReceiptTarget(project, receipt.path);
  await assertSafeProjectTarget(project, path);
  const plan = planSettingsRestore(receipt, await snapshotFile(path), force, project);
  warnings.push(...plan.warnings);
  if (!plan.changed) return;
  changed.push(normalizeRelative(receipt.path));
  if (!dryRun) await restoreSnapshot(path, plan.result);
}

function planMcpReceiptRestore(
  receipt: McpReceipt,
  current: FileSnapshot,
  force: boolean,
): RestorePlan {
  const before = snapshotFromMcpReceipt(receipt);
  if (snapshotsEqual(current, before)) return { result: current, changed: false, warnings: [] };
  if (snapshotMatchesHash(current, receipt.afterSha256)) {
    return { result: before, changed: !snapshotsEqual(current, before), warnings: [] };
  }
  if (receipt.appliedServers === undefined && receipt.appliedSettings === undefined) {
    return {
      result: current,
      changed: false,
      warnings: [
        `Preserved modified legacy ${receipt.path}; its receipt has no entry-level merge metadata.`,
      ],
    };
  }
  if (!current.exists) {
    if (!before.exists) return { result: current, changed: false, warnings: [] };
    return force
      ? { result: before, changed: true, warnings: [] }
      : {
          result: current,
          changed: false,
          warnings: [`Preserved missing ${receipt.path}; use --force to restore its previous content.`],
        };
  }

  let currentObject: Record<string, unknown>;
  let beforeObject: Record<string, unknown>;
  try {
    currentObject = parseJsonObjectSnapshot(current, receipt.path);
    beforeObject = parseJsonObjectSnapshot(before, receipt.path);
  } catch (error) {
    return {
      result: current,
      changed: false,
      warnings: [`Preserved ${receipt.path} because it cannot be merged safely: ${errorMessage(error)}`],
    };
  }

  const result = cloneJsonRecord(currentObject);
  const warnings: string[] = [];
  let changed = applyValueChanges(
    result,
    receipt.appliedSettings ?? {},
    force,
    "MCP setting",
    warnings,
  );
  const serverChanges = receipt.appliedServers ?? {};
  if (Object.keys(serverChanges).length > 0) {
    const rawServers = result.mcpServers;
    if (rawServers !== undefined && !isRecord(rawServers)) {
      warnings.push(`Preserved ${receipt.path}.mcpServers because it is no longer an object.`);
    } else {
      const servers = cloneJsonRecord(rawServers ?? {});
      changed =
        applyValueChanges(servers, serverChanges, force, "MCP server", warnings) || changed;
      const beforeHadServers = hasOwn(beforeObject, "mcpServers");
      if (!beforeHadServers && Object.keys(servers).length === 0) {
        if (hasOwn(result, "mcpServers")) {
          delete result.mcpServers;
          changed = true;
        }
      } else {
        result.mcpServers = servers;
      }
    }
  }
  if (!changed) return { result: current, changed: false, warnings };
  const resultSnapshot =
    !before.exists && Object.keys(result).length === 0
      ? { exists: false }
      : { exists: true, content: jsonBuffer(result), mode: current.mode ?? 0o644 };
  return { result: resultSnapshot, changed: !snapshotsEqual(current, resultSnapshot), warnings };
}

function planSettingsRestore(
  receipt: SettingsReceipt,
  current: FileSnapshot,
  force: boolean,
  project: string,
): RestorePlan {
  const before = snapshotFromReceipt(receipt);
  if (snapshotsEqual(current, before)) return { result: current, changed: false, warnings: [] };
  if (snapshotMatchesHash(current, receipt.afterSha256)) {
    return { result: before, changed: !snapshotsEqual(current, before), warnings: [] };
  }
  if (receipt.appliedPackages === undefined) {
    return {
      result: current,
      changed: false,
      warnings: [
        `Preserved modified legacy ${receipt.path}; its receipt has no package-level merge metadata.`,
      ],
    };
  }
  if (!current.exists) {
    if (!before.exists) return { result: current, changed: false, warnings: [] };
    return force
      ? { result: before, changed: true, warnings: [] }
      : {
          result: current,
          changed: false,
          warnings: [`Preserved missing ${receipt.path}; use --force to restore its previous content.`],
        };
  }

  let currentObject: Record<string, unknown>;
  let beforeObject: Record<string, unknown>;
  try {
    currentObject = parseJsonObjectSnapshot(current, receipt.path);
    beforeObject = parseJsonObjectSnapshot(before, receipt.path);
  } catch (error) {
    return {
      result: current,
      changed: false,
      warnings: [`Preserved ${receipt.path} because it cannot be merged safely: ${errorMessage(error)}`],
    };
  }
  const result = cloneJsonRecord(currentObject);
  const packagesValue = result.packages;
  if (packagesValue !== undefined && !Array.isArray(packagesValue)) {
    return {
      result: current,
      changed: false,
      warnings: [`Preserved ${receipt.path}.packages because it is no longer an array.`],
    };
  }
  const packages = packagesValue ? [...packagesValue] : [];
  const warnings: string[] = [];
  let changed = false;
  for (const applied of receipt.appliedPackages) {
    const indexes = packageIndexesByIdentity(packages, applied.identity, project);
    if (indexes.length > 1) {
      warnings.push(`Preserved duplicate package identity ${applied.identity}; it cannot be merged safely.`);
      continue;
    }
    const index = indexes[0];
    if (!applied.beforeExists) {
      if (index === undefined) continue;
      if (jsonEqual(packages[index], applied.appliedEntry) || force) {
        packages.splice(index, 1);
        changed = true;
      } else {
        warnings.push(`Preserved modified package entry ${applied.identity}.`);
      }
      continue;
    }
    if (applied.beforeEntry === undefined) {
      warnings.push(`Preserved package entry ${applied.identity}; its previous value is unavailable.`);
      continue;
    }
    if (index === undefined) {
      if (force) {
        packages.push(cloneJsonValue(applied.beforeEntry));
        changed = true;
      } else {
        warnings.push(`Preserved removed package entry ${applied.identity}.`);
      }
      continue;
    }
    if (jsonEqual(packages[index], applied.beforeEntry)) continue;
    if (jsonEqual(packages[index], applied.appliedEntry) || force) {
      packages[index] = cloneJsonValue(applied.beforeEntry);
      changed = true;
    } else {
      warnings.push(`Preserved modified package entry ${applied.identity}.`);
    }
  }
  if (!changed) return { result: current, changed: false, warnings };
  if (!hasOwn(beforeObject, "packages") && packages.length === 0) delete result.packages;
  else result.packages = packages;
  const resultSnapshot =
    !before.exists && Object.keys(result).length === 0
      ? { exists: false }
      : { exists: true, content: jsonBuffer(result), mode: current.mode ?? 0o644 };
  return { result: resultSnapshot, changed: !snapshotsEqual(current, resultSnapshot), warnings };
}

function applyValueChanges(
  container: Record<string, unknown>,
  changes: Record<string, AppliedValueChange>,
  force: boolean,
  label: string,
  warnings: string[],
): boolean {
  let changed = false;
  for (const [name, applied] of Object.entries(changes)) {
    const currentExists = hasOwn(container, name);
    const currentValue = container[name];
    if (!applied.beforeExists) {
      if (!currentExists) continue;
      if (jsonEqual(currentValue, applied.appliedValue) || force) {
        delete container[name];
        changed = true;
      } else {
        warnings.push(`Preserved modified ${label} ${name}.`);
      }
      continue;
    }
    if (!hasOwn(applied, "beforeValue")) {
      warnings.push(`Preserved ${label} ${name}; its previous value is unavailable.`);
      continue;
    }
    if (!currentExists) {
      if (force) {
        defineJsonProperty(container, name, cloneJsonValue(applied.beforeValue));
        changed = true;
      } else {
        warnings.push(`Preserved removed ${label} ${name}.`);
      }
      continue;
    }
    if (jsonEqual(currentValue, applied.beforeValue)) continue;
    if (jsonEqual(currentValue, applied.appliedValue) || force) {
      defineJsonProperty(container, name, cloneJsonValue(applied.beforeValue));
      changed = true;
    } else {
      warnings.push(`Preserved modified ${label} ${name}.`);
    }
  }
  return changed;
}

function planMcpMerge(
  before: FileSnapshot,
  proposed: Record<string, unknown> | undefined,
): {
  changed: boolean;
  merged: Record<string, unknown>;
  addedServers: string[];
  previousServers: Record<string, unknown>;
  appliedServers: Record<string, AppliedValueChange>;
  appliedSettings: Record<string, AppliedValueChange>;
} {
  const existing = parseJsonObjectSnapshot(before, MCP_RELATIVE_PATH);
  if (!proposed || Object.keys(proposed).length === 0) {
    return {
      changed: false,
      merged: existing,
      addedServers: [],
      previousServers: {},
      appliedServers: {},
      appliedSettings: {},
    };
  }
  const merged = cloneJsonRecord(existing);
  const addedServers: string[] = [];
  const previousServers: Record<string, unknown> = {};
  const appliedServers: Record<string, AppliedValueChange> = {};
  const appliedSettings: Record<string, AppliedValueChange> = {};
  for (const [key, value] of Object.entries(proposed)) {
    if (key === "mcpServers") continue;
    if (hasOwn(existing, key) && !jsonEqual(existing[key], value)) {
      throw new Error(`MCP top-level setting conflict at ${key}.`);
    }
    if (!hasOwn(existing, key)) {
      const appliedValue = cloneJsonValue(value);
      defineJsonProperty(merged, key, appliedValue);
      defineJsonProperty(appliedSettings, key, { beforeExists: false, appliedValue });
    }
  }
  const proposedServers = proposed.mcpServers;
  if (proposedServers !== undefined && !isRecord(proposedServers)) {
    throw new Error("mcpConfig.mcpServers must be an object.");
  }
  const existingServersValue = existing.mcpServers;
  if (existingServersValue !== undefined && !isRecord(existingServersValue)) {
    throw new Error(`${MCP_RELATIVE_PATH}: mcpServers must be an object.`);
  }
  const existingServers = existingServersValue ?? {};
  const mergedServers = cloneJsonRecord(existingServers);
  for (const [name, config] of Object.entries(proposedServers ?? {})) {
    if (hasOwn(existingServers, name)) {
      if (!jsonEqual(existingServers[name], config)) {
        throw new Error(`MCP server ${name} already exists with a different configuration.`);
      }
      defineJsonProperty(previousServers, name, cloneJsonValue(existingServers[name]));
    } else {
      defineJsonProperty(mergedServers, name, cloneJsonValue(config));
      addedServers.push(name);
      defineJsonProperty(appliedServers, name, {
        beforeExists: false,
        appliedValue: cloneJsonValue(config),
      });
    }
  }
  if (
    proposedServers !== undefined &&
    (hasOwn(existing, "mcpServers") || Object.keys(proposedServers).length > 0)
  ) {
    merged.mcpServers = mergedServers;
  }
  return {
    changed: !jsonEqual(existing, merged),
    merged,
    addedServers,
    previousServers,
    appliedServers,
    appliedSettings,
  };
}

async function applyRuntimeFilters(
  settingsPath: string,
  requirements: RuntimeRequirement[],
): Promise<void> {
  const snapshot = await snapshotFile(settingsPath);
  const settings = parseJsonObjectSnapshot(snapshot, SETTINGS_RELATIVE_PATH);
  const packages = settings.packages;
  if (!Array.isArray(packages)) throw new Error(`${SETTINGS_RELATIVE_PATH}: packages must be an array.`);
  let changed = false;
  const next = packages.map((entry) => {
    const source = packageEntrySource(entry);
    const requirement = requirements.find((candidate) => runtimeSource(candidate) === source);
    if (!requirement?.resourceFilter) return entry;
    const current = isRecord(entry) ? entry : { source };
    const desired = { ...current, source, ...requirement.resourceFilter };
    if (!jsonEqual(current, desired)) changed = true;
    return desired;
  });
  for (const requirement of requirements) {
    if (
      requirement.resourceFilter &&
      !next.some((entry) => packageEntrySource(entry) === runtimeSource(requirement))
    ) {
      throw new Error(`Pi did not persist ${runtimeSource(requirement)} to project settings.`);
    }
  }
  if (changed) {
    settings.packages = next;
    await atomicWrite(settingsPath, jsonBuffer(settings), snapshot.mode ?? 0o600);
  }
}

async function applyConvertedPackageFilters(
  settingsPath: string,
  packageRoot: string,
  project: string,
  projectSkillsActivated: boolean,
): Promise<void> {
  if (!projectSkillsActivated) return;
  const snapshot = await snapshotFile(settingsPath);
  const settings = parseJsonObjectSnapshot(snapshot, SETTINGS_RELATIVE_PATH);
  if (!Array.isArray(settings.packages)) {
    throw new Error(`${SETTINGS_RELATIVE_PATH}: packages must be an array.`);
  }
  let found = false;
  let changed = false;
  settings.packages = settings.packages.map((entry) => {
    const source = packageEntrySource(entry);
    if (
      !source ||
      source.startsWith("npm:") ||
      source.startsWith("git:") ||
      source.includes("://") ||
      resolve(project, ".pi", source) !== packageRoot
    ) {
      return entry;
    }
    found = true;
    const current = isRecord(entry) ? entry : { source };
    const desired = { ...current, source, skills: [] };
    if (!jsonEqual(current, desired)) changed = true;
    return desired;
  });
  if (!found) throw new Error("Pi did not persist the converted local package before filtering skills.");
  if (changed) await atomicWrite(settingsPath, jsonBuffer(settings), snapshot.mode ?? 0o600);
}

function collectAppliedPackageChanges(
  beforeSettings: Record<string, unknown>,
  afterSettings: Record<string, unknown>,
  project: string,
  packageRoot: string,
  requirements: RuntimeRequirement[],
  includeConvertedPackage = true,
): AppliedPackageChange[] {
  const beforePackages = Array.isArray(beforeSettings.packages) ? beforeSettings.packages : [];
  const afterPackages = Array.isArray(afterSettings.packages) ? afterSettings.packages : [];
  const identities = new Set<string>(includeConvertedPackage ? [`local:${packageRoot}`] : []);
  for (const requirement of requirements) {
    const identity = `npm:${requirement.packageName}`;
    if (afterPackages.some((entry) => packageIdentity(entry, project) === identity)) {
      identities.add(identity);
    }
  }
  const changes: AppliedPackageChange[] = [];
  for (const identity of identities) {
    const beforeEntries = beforePackages.filter(
      (entry) => packageIdentity(entry, project) === identity,
    );
    const afterEntries = afterPackages.filter((entry) => packageIdentity(entry, project) === identity);
    if (beforeEntries.length > 1 || afterEntries.length > 1) {
      throw new Error(`Duplicate package identity cannot be recorded safely: ${identity}.`);
    }
    const beforeEntry = beforeEntries[0];
    const appliedEntry = afterEntries[0];
    if (appliedEntry === undefined) {
      throw new Error(`Activated package identity is missing from project settings: ${identity}.`);
    }
    if (beforeEntry !== undefined && jsonEqual(beforeEntry, appliedEntry)) continue;
    changes.push({
      identity,
      beforeExists: beforeEntry !== undefined,
      ...(beforeEntry !== undefined ? { beforeEntry: cloneJsonValue(beforeEntry) } : {}),
      appliedEntry: cloneJsonValue(appliedEntry),
    });
  }
  return changes;
}

function packageIndexesByIdentity(
  packages: unknown[],
  identity: string,
  project: string,
): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < packages.length; index += 1) {
    if (packageIdentity(packages[index], project) === identity) indexes.push(index);
  }
  return indexes;
}

function packageIdentity(entry: unknown, project: string): string | undefined {
  const source = packageEntrySource(entry);
  if (!source) return undefined;
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length);
    const versionAt = spec.lastIndexOf("@");
    const hasVersion = spec.startsWith("@")
      ? versionAt > spec.indexOf("/")
      : versionAt > 0;
    return `npm:${hasVersion ? spec.slice(0, versionAt) : spec}`;
  }
  if (source.startsWith("git:") || source.includes("://")) return `external:${source}`;
  return `local:${resolve(project, ".pi", source)}`;
}

function assertNoProjectRuntimeIdentityConflicts(
  settings: Record<string, unknown>,
  requirements: RuntimeRequirement[],
  project: string,
): void {
  for (const requirement of requirements) {
    const conflict = projectRuntimeIdentityConflict(settings, requirement, project);
    if (conflict) throw new Error(conflict);
  }
}

function projectRuntimeIdentityConflict(
  settings: Record<string, unknown>,
  requirement: RuntimeRequirement,
  project: string,
): string | undefined {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const identity = `npm:${requirement.packageName}`;
  const matchingEntries = packages.filter(
    (entry) => packageIdentity(entry, project) === identity,
  );
  if (matchingEntries.length === 0) return undefined;
  const sources = matchingEntries
    .map(packageEntrySource)
    .filter((source): source is string => Boolean(source));
  const exactSource = runtimeSource(requirement);
  if (matchingEntries.length === 1 && sources[0] === exactSource) return undefined;
  const configured = sources.length > 0 ? sources.join(", ") : "an unreadable package entry";
  return (
    `Project runtime identity ${identity} is already configured as ${configured}; expected ${exactSource}. ` +
    `Refusing to replace an existing project runtime automatically because its npm cache cannot be restored safely during deactivation. ` +
    `Explicitly reconcile .pi/settings.json and install the exact version with ${runtimeInstallCommand(requirement)}, then retry.`
  );
}

async function inspectRuntime(
  project: string,
  settings: Record<string, unknown>,
  globalSettings: Record<string, unknown>,
  requirement: RuntimeRequirement,
): Promise<RuntimeState> {
  const source = runtimeSource(requirement);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const globalPackages = Array.isArray(globalSettings.packages) ? globalSettings.packages : [];
  const projectEntry = packages.find((candidate) => packageEntrySource(candidate) === source);
  const globalEntry = globalPackages.find((candidate) => packageEntrySource(candidate) === source);
  const entry = projectEntry ?? globalEntry;
  const packagePath = projectEntry
    ? join(project, ".pi", "npm", "node_modules", requirement.packageName)
    : join(globalPiAgentDir(), "npm", "node_modules", requirement.packageName);
  let installedVersion: string | undefined;
  let installedName: string | undefined;
  try {
    const packageJson = parseJsonObject(await readFile(join(packagePath, "package.json"), "utf8"), `${packagePath}/package.json`);
    if (typeof packageJson.name === "string") installedName = packageJson.name;
    if (typeof packageJson.version === "string") installedVersion = packageJson.version;
  } catch {
    installedName = undefined;
    installedVersion = undefined;
  }
  return {
    source,
    configured: entry !== undefined,
    installed: installedName === requirement.packageName && installedVersion === requirement.version,
    ...(installedName ? { installedName } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    ...(projectEntry ? { scope: "project" as const } : globalEntry ? { scope: "global" as const } : {}),
    packagePath,
    filterMatches: requirement.resourceFilter
      ? isRecord(entry) &&
        Object.entries(requirement.resourceFilter).every(([key, value]) => jsonEqual(entry[key], value))
      : true,
  };
}

async function diagnoseWebAccessTools(
  state: RuntimeState,
  settings: Record<string, unknown>,
  globalSettings: Record<string, unknown>,
  checks: DoctorCheck[],
): Promise<void> {
  const id = "web-tools";
  try {
    if (!state.configured || !state.installed || !state.scope) {
      throw new Error(
        "The exact pi-web-access package must be configured and installed before its web tools can be verified.",
      );
    }

    const packageInfo = await lstat(state.packagePath);
    if (packageInfo.isSymbolicLink() || !packageInfo.isDirectory()) {
      throw new Error(`pi-web-access package root is not a regular directory: ${state.packagePath}.`);
    }
    const packageRoot = await realpath(state.packagePath);
    const packageJsonPath = join(state.packagePath, "package.json");
    await assertRegularFile(packageJsonPath, "pi-web-access package.json", true, packageRoot);
    const packageJson = parseJsonObject(
      await readFile(packageJsonPath, "utf8"),
      packageJsonPath,
    );
    if (packageJson.name !== "pi-web-access" || packageJson.version !== RUNTIMES.web.version) {
      throw new Error(
        `Expected pi-web-access@${RUNTIMES.web.version} at ${state.packagePath}.`,
      );
    }
    if (!isRecord(packageJson.pi) || !Array.isArray(packageJson.pi.extensions)) {
      throw new Error("pi-web-access package.json has no public pi.extensions manifest.");
    }
    if (!packageJson.pi.extensions.every((entry) => typeof entry === "string")) {
      throw new Error("pi-web-access package.json pi.extensions entries must be strings.");
    }

    const declaredEntrypoint = packageJson.pi.extensions.find((entry) => {
      try {
        return normalizeRelative(entry, true) === PI_WEB_ACCESS_PUBLIC_ENTRYPOINT;
      } catch {
        return false;
      }
    });
    if (!declaredEntrypoint) {
      throw new Error(
        `pi-web-access@${RUNTIMES.web.version} does not declare its public ./index.ts extension entrypoint.`,
      );
    }

    const configuredEntry = selectedRuntimeSettingsEntry(
      state,
      settings,
      globalSettings,
    );
    if (
      isRecord(configuredEntry) &&
      configuredEntry.extensions !== undefined &&
      !piExtensionFilterMayLoad(configuredEntry.extensions, PI_WEB_ACCESS_PUBLIC_ENTRYPOINT)
    ) {
      throw new Error(
        "The active pi-web-access package filter excludes its public index.ts extension entrypoint.",
      );
    }

    const entrypointPath = resolveManifestPath(
      state.packagePath,
      declaredEntrypoint,
      "pi-web-access public extension entrypoint",
    );
    await assertRegularFile(
      entrypointPath,
      "pi-web-access public extension entrypoint",
      true,
      packageRoot,
    );
    const entrypointBytes = await readFile(entrypointPath);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(entrypointBytes);
    } catch {
      throw new Error("pi-web-access public extension entrypoint is not valid UTF-8 source.");
    }
    if (source.includes("\0")) {
      throw new Error("pi-web-access public extension entrypoint contains a NUL byte.");
    }
    const declaredTools = REQUIRED_WEB_TOOLS.filter((tool) =>
      hasDirectPiToolRegistration(source, tool),
    );
    const missingTools = REQUIRED_WEB_TOOLS.filter((tool) => !declaredTools.includes(tool));
    if (missingTools.length > 0) {
      throw new Error(
        `pi-web-access public extension entrypoint does not statically declare ${missingTools.join(
          ", ",
        )} with pi.registerTool().`,
      );
    }

    checks.push(
      okCheck(
        id,
        "The exact pi-web-access public extension entrypoint can be loaded and statically declares web_search/fetch_content.",
        {
          packagePath: state.packagePath,
          entrypoint: declaredEntrypoint,
          tools: [...REQUIRED_WEB_TOOLS],
          scope: state.scope,
          verification: "static-package-manifest-and-public-entrypoint",
        },
      ),
    );
  } catch (error) {
    checks.push(
      errorCheck(id, `pi-web-access web tool registration cannot be verified: ${errorMessage(error)}`, {
        packagePath: state.packagePath,
        tools: [...REQUIRED_WEB_TOOLS],
        verification: "static-package-manifest-and-public-entrypoint",
      }),
    );
  }
}

function selectedRuntimeSettingsEntry(
  state: RuntimeState,
  settings: Record<string, unknown>,
  globalSettings: Record<string, unknown>,
): unknown | undefined {
  const configured = state.scope === "project" ? settings : globalSettings;
  const packages = Array.isArray(configured.packages) ? configured.packages : [];
  return packages.find((entry) => packageEntrySource(entry) === state.source);
}

function piExtensionFilterMayLoad(value: unknown, entrypoint: string): boolean {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return false;
  if (value.length === 0) return false;
  const hasPositivePattern = value.some(
    (entry) => !entry.startsWith("!") && !entry.startsWith("-"),
  );
  let included = !hasPositivePattern;
  for (const raw of value) {
    const marker = raw[0];
    const pattern = marker === "+" || marker === "-" || marker === "!" ? raw.slice(1) : raw;
    if (!piPathPatternMatches(pattern, entrypoint)) continue;
    included = marker !== "-" && marker !== "!";
  }
  return included;
}

function piPathPatternMatches(rawPattern: string, path: string): boolean {
  let pattern = rawPattern.startsWith("./") ? rawPattern.slice(2) : rawPattern;
  if (!pattern || pattern.includes("\0") || pattern.includes("\\")) return false;
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  expression += "$";
  return new RegExp(expression).test(path);
}

function hasDirectPiToolRegistration(source: string, tool: (typeof REQUIRED_WEB_TOOLS)[number]): boolean {
  const escapedTool = tool.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
  return new RegExp(
    `\\bpi\\s*\\.\\s*registerTool\\s*\\(\\s*\\{\\s*name\\s*:\\s*(["'])${escapedTool}\\1`,
  ).test(source);
}

async function readGlobalPiSettings(): Promise<Record<string, unknown>> {
  const path = join(globalPiAgentDir(), "settings.json");
  return parseJsonObjectSnapshot(await snapshotFile(path), path);
}

function globalPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured ? resolve(configured) : join(homedir(), ".pi", "agent");
}

async function diagnoseReceiptFiles(
  receipt: ActivationReceipt,
  project: string,
  checks: DoctorCheck[],
): Promise<void> {
  for (const change of receipt.files) {
    const path = resolveReceiptTarget(project, change.path);
    const current = await snapshotFile(path);
    const id = `file-${normalizeRelative(change.path)}`;
    if (!current.exists || !current.content) {
      checks.push(errorCheck(id, `Activated file is missing: ${change.path}.`));
    } else if (sha256(current.content) !== change.afterSha256) {
      checks.push(warningCheck(id, `Activated file was modified: ${change.path}.`));
    } else {
      checks.push(okCheck(id, `Activated file is unchanged: ${change.path}.`));
    }
  }
  if (receipt.mcp) await diagnoseReceiptHash(receipt.mcp.path, receipt.mcp.afterSha256, project, checks);
  if (receipt.settings) {
    await diagnoseReceiptHash(receipt.settings.path, receipt.settings.afterSha256, project, checks);
  }
}

async function diagnoseReceiptHash(
  relativePath: string,
  expectedHash: string,
  project: string,
  checks: DoctorCheck[],
): Promise<void> {
  const snapshot = await snapshotFile(resolveReceiptTarget(project, relativePath));
  const id = `receipt-hash-${normalizeRelative(relativePath)}`;
  if (!snapshot.exists || !snapshot.content) {
    checks.push(errorCheck(id, `Receipt-owned file is missing: ${relativePath}.`));
  } else if (sha256(snapshot.content) !== expectedHash) {
    checks.push(warningCheck(id, `Receipt-owned file was modified: ${relativePath}.`));
  } else {
    checks.push(okCheck(id, `Receipt-owned file is unchanged: ${relativePath}.`));
  }
}

async function diagnoseLocalPackage(
  settings: Record<string, unknown>,
  convertedDir: string,
  manifest: ActivationManifest,
  project: string,
  checks: DoctorCheck[],
): Promise<void> {
  const extensionRoot = join(project, ".pi", "extensions", manifest.pluginSlug);
  const extensionEntrypoint = join(extensionRoot, "index.ts");
  const copiedPackage = join(extensionRoot, "package", "package.json");
  const configured = await pathExists(extensionEntrypoint) && await pathExists(copiedPackage);
  checks.push(
    configured
      ? okCheck("converted-package", "Converted Pi extension is copied into the project extension directory.")
      : errorCheck("converted-package", "Converted Pi extension is missing from the project extension directory."),
  );
}

async function diagnoseActivationTargets(
  manifest: ActivationManifest,
  convertedDir: string,
  project: string,
  checks: DoctorCheck[],
): Promise<void> {
  for (const entry of manifest.agents) {
    const id = `agent-target-${entry.target}`;
    try {
      const sourcePath = resolveManifestPath(convertedDir, entry.source, "agent source");
      const targetPath = resolveProjectRelative(project, entry.target, "agent target");
      const source = await snapshotFile(sourcePath);
      const target = await snapshotFile(targetPath);
      if (!target.exists || !target.content) {
        checks.push(errorCheck(id, `Pi subagent target is missing: ${entry.target}.`));
      } else if (!source.content || !target.content.equals(source.content)) {
        checks.push(warningCheck(id, `Pi subagent target differs from its converted source: ${entry.target}.`));
      } else {
        checks.push(okCheck(id, `Pi subagent target is discoverable at ${entry.target}.`));
      }
    } catch (error) {
      checks.push(errorCheck(id, errorMessage(error)));
    }
  }
  for (const entry of manifest.skillFiles ?? []) {
    const id = `skill-target-${entry.target}`;
    try {
      const sourcePath = resolveManifestPath(convertedDir, entry.source, "skill source");
      const sourceInfo = await lstat(sourcePath);
      if (sourceInfo.isSymbolicLink()) throw new Error("skill source is a symlink");
      const files = sourceInfo.isDirectory()
        ? await collectDirectoryFiles(sourcePath, convertedDir)
        : [{ path: sourcePath, relativePath: "", mode: sourceInfo.mode & 0o777 }];
      if (sourceInfo.isDirectory() && !files.some((file) => file.relativePath === "SKILL.md")) {
        throw new Error("skill directory has no root SKILL.md");
      }
      for (const file of files) {
        const targetRelative = file.relativePath
          ? `${normalizeRelative(entry.target)}/${file.relativePath}`
          : normalizeRelative(entry.target);
        const target = await snapshotFile(
          resolveProjectRelative(project, targetRelative, "skill target"),
        );
        const source = await snapshotFile(file.path);
        if (!target.content || !source.content || !target.content.equals(source.content)) {
          throw new Error(`skill asset is missing or modified: ${targetRelative}`);
        }
      }
      checks.push(
        okCheck(id, `Pi skill and supporting assets are discoverable at ${entry.target}.`, {
          files: files.length,
        }),
      );
    } catch (error) {
      checks.push(errorCheck(id, `Pi skill target is invalid: ${errorMessage(error)}`));
    }
  }
  for (const entry of manifest.runtimeFiles) {
    const id = `runtime-target-${entry.target}`;
    try {
      const sourcePath = resolveManifestPath(convertedDir, entry.source, "runtime source");
      const targetPath = resolveProjectRelative(project, entry.target, "runtime target");
      const sourceInfo = await stat(sourcePath);
      const targetInfo = await stat(targetPath);
      if (!sourceInfo.isFile() || !targetInfo.isFile()) {
        checks.push(errorCheck(id, `Runtime source/target is not a regular file: ${entry.target}.`));
        continue;
      }
      const needsExecutable =
        (sourceInfo.mode & 0o111) !== 0 || basename(targetPath) === "mcp-launcher.mjs";
      if (needsExecutable && process.platform !== "win32" && (targetInfo.mode & 0o111) === 0) {
        checks.push(errorCheck(id, `Runtime executable lost its executable bit: ${entry.target}.`));
      } else {
        checks.push(
          okCheck(id, `Runtime target is present at ${entry.target}.`, {
            executable: needsExecutable,
            mode: (targetInfo.mode & 0o777).toString(8),
          }),
        );
      }
    } catch (error) {
      checks.push(errorCheck(id, `Runtime target is missing or invalid: ${entry.target}: ${errorMessage(error)}`));
    }
  }
}

function isLocalPackageConfigured(
  settings: Record<string, unknown>,
  packageRoot: string,
  project: string,
): boolean {
  return localPackageEntry(settings, packageRoot, project) !== undefined;
}

function localPackageEntry(
  settings: Record<string, unknown>,
  packageRoot: string,
  project: string,
): unknown | undefined {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  return packages.find((entry) => {
    const source = packageEntrySource(entry);
    if (!source || source.startsWith("npm:") || source.includes("://") || source.startsWith("git:")) {
      return false;
    }
    return resolve(project, ".pi", source) === packageRoot;
  });
}

async function diagnoseMcp(
  manifest: ActivationManifest,
  project: string,
  checks: DoctorCheck[],
): Promise<void> {
  if (!manifest.mcpConfig || Object.keys(manifest.mcpConfig).length === 0) {
    checks.push(okCheck("mcp-config", "This package does not require MCP configuration."));
    return;
  }
  const current = parseJsonObjectSnapshot(await snapshotFile(join(project, MCP_RELATIVE_PATH)), MCP_RELATIVE_PATH);
  try {
    const plan = planMcpMerge({ exists: true, content: jsonBuffer(current) }, manifest.mcpConfig);
    checks.push(
      plan.changed
        ? errorCheck("mcp-config", "Converted MCP configuration is incomplete in the project.")
        : okCheck("mcp-config", "Converted MCP configuration is present."),
    );
  } catch (error) {
    checks.push(errorCheck("mcp-config", errorMessage(error)));
  }
}

async function readOptionalReceipt(
  path: string,
  project: string,
  pluginId: string,
): Promise<ActivationReceipt | undefined> {
  if (!(await pathExists(path))) return undefined;
  return readRequiredReceipt(path, project, pluginId);
}

async function readRequiredReceipt(
  path: string,
  project: string,
  pluginId: string,
): Promise<ActivationReceipt> {
  await assertRegularFile(path, "activation receipt", true, project);
  const raw = parseJsonObject(await readFile(path, "utf8"), path);
  if (raw.schemaVersion !== 1 || raw.pluginId !== pluginId) {
    throw new Error(`${path}: receipt identity or schema version does not match.`);
  }
  const validatedPluginId = requireSafeComponent(raw.pluginId, "receipt.pluginId");
  const pluginSlug = requireSafeComponent(raw.pluginSlug, "receipt.pluginSlug");
  if (typeof raw.convertedDir !== "string" || typeof raw.project !== "string") {
    throw new Error(`${path}: receipt paths are invalid.`);
  }
  if (resolve(raw.project) !== project) throw new Error(`${path}: receipt belongs to a different project.`);
  if (typeof raw.activatedAt !== "string" || Number.isNaN(Date.parse(raw.activatedAt))) {
    throw new Error(`${path}: activatedAt is invalid.`);
  }
  if (!Array.isArray(raw.files)) throw new Error(`${path}: files must be an array.`);
  const files = raw.files.map((entry, index) =>
    validateReceiptChange(entry, `files[${index}]`, project, undefined, validatedPluginId, pluginSlug),
  );
  const normalized = files.map((entry) => normalizeRelative(entry.path));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${path}: duplicate receipt paths.`);
  const mcp = raw.mcp === undefined ? undefined : validateMcpReceipt(raw.mcp, project);
  const settings =
    raw.settings === undefined
      ? undefined
      : validateSettingsReceipt(raw.settings, project);
  if (!Array.isArray(raw.installedRuntimes) || !raw.installedRuntimes.every((entry) => typeof entry === "string")) {
    throw new Error(`${path}: installedRuntimes is invalid.`);
  }
  return {
    schemaVersion: 1,
    pluginId: validatedPluginId,
    pluginSlug,
    convertedDir: raw.convertedDir,
    project,
    activatedAt: raw.activatedAt,
    files,
    ...(mcp ? { mcp } : {}),
    ...(settings ? { settings } : {}),
    installedRuntimes: [...raw.installedRuntimes],
  };
}

function validateReceiptChange(
  value: unknown,
  label: string,
  project: string,
  exactPath?: string,
  pluginId?: string,
  pluginSlug?: string,
): ReceiptFileChange {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.beforeExists !== "boolean") {
    throw new Error(`Receipt ${label} is invalid.`);
  }
  const normalizedPath = normalizeRelative(value.path);
  if (exactPath && normalizedPath !== exactPath) throw new Error(`Receipt ${label} has an unsafe path.`);
  if (!exactPath && !isAllowedOwnedPath(normalizedPath, pluginId, pluginSlug)) {
    throw new Error(`Receipt ${label} is outside converter-owned paths.`);
  }
  resolveProjectRelative(project, normalizedPath, `receipt ${label}`);
  if (value.beforeExists && typeof value.beforeContentBase64 !== "string") {
    throw new Error(`Receipt ${label} is missing its previous content.`);
  }
  if (!value.beforeExists && value.beforeContentBase64 !== undefined) {
    throw new Error(`Receipt ${label} has unexpected previous content.`);
  }
  const beforeContentBase64 =
    typeof value.beforeContentBase64 === "string" ? value.beforeContentBase64 : undefined;
  if (beforeContentBase64 !== undefined) validateBase64(beforeContentBase64, label);
  if (
    value.beforeMode !== undefined &&
    (!Number.isInteger(value.beforeMode) ||
      (value.beforeMode as number) < 0 ||
      (value.beforeMode as number) > 0o777)
  ) {
    throw new Error(`Receipt ${label}.beforeMode is invalid.`);
  }
  if (typeof value.afterSha256 !== "string" || !HASH_PATTERN.test(value.afterSha256)) {
    throw new Error(`Receipt ${label}.afterSha256 is invalid.`);
  }
  return {
    path: normalizedPath,
    beforeExists: value.beforeExists,
    ...(beforeContentBase64 !== undefined
      ? { beforeContentBase64 }
      : {}),
    ...(value.beforeMode !== undefined ? { beforeMode: (value.beforeMode as number) & 0o777 } : {}),
    afterSha256: value.afterSha256,
  };
}

function validateMcpReceipt(value: unknown, project: string): McpReceipt {
  if (!isRecord(value) || value.path !== MCP_RELATIVE_PATH) throw new Error("Receipt MCP entry is invalid.");
  if (!Array.isArray(value.addedServers) || !value.addedServers.every((entry) => typeof entry === "string")) {
    throw new Error("Receipt MCP addedServers is invalid.");
  }
  if (!isRecord(value.previousServers)) throw new Error("Receipt MCP previousServers is invalid.");
  resolveProjectRelative(project, value.path, "receipt MCP path");
  if (value.beforeContentBase64 !== undefined) {
    if (typeof value.beforeContentBase64 !== "string") throw new Error("Receipt MCP content is invalid.");
    validateBase64(value.beforeContentBase64, "mcp");
  }
  if (
    value.beforeMode !== undefined &&
    (typeof value.beforeMode !== "number" ||
      !Number.isInteger(value.beforeMode) ||
      value.beforeMode < 0 ||
      value.beforeMode > 0o777)
  ) {
    throw new Error("Receipt MCP beforeMode is invalid.");
  }
  if (typeof value.afterSha256 !== "string" || !HASH_PATTERN.test(value.afterSha256)) {
    throw new Error("Receipt MCP hash is invalid.");
  }
  const appliedServers = validateAppliedValueMap(value.appliedServers, "MCP appliedServers");
  const appliedSettings = validateAppliedValueMap(value.appliedSettings, "MCP appliedSettings");
  return {
    path: value.path,
    addedServers: [...value.addedServers],
    previousServers: value.previousServers,
    ...(value.beforeContentBase64 !== undefined
      ? { beforeContentBase64: value.beforeContentBase64 }
      : {}),
    ...(typeof value.beforeMode === "number" ? { beforeMode: value.beforeMode & 0o777 } : {}),
    afterSha256: value.afterSha256,
    ...(appliedServers ? { appliedServers } : {}),
    ...(appliedSettings ? { appliedSettings } : {}),
  };
}

function validateSettingsReceipt(value: unknown, project: string): SettingsReceipt {
  const base = validateReceiptChange(value, "settings", project, SETTINGS_RELATIVE_PATH);
  if (!isRecord(value)) throw new Error("Receipt settings entry is invalid.");
  if (value.appliedPackages === undefined) return base;
  if (!Array.isArray(value.appliedPackages)) {
    throw new Error("Receipt settings appliedPackages must be an array.");
  }
  const identities = new Set<string>();
  const appliedPackages = value.appliedPackages.map((entry, index): AppliedPackageChange => {
    if (
      !isRecord(entry) ||
      typeof entry.identity !== "string" ||
      entry.identity.length === 0 ||
      entry.identity.length > 4096 ||
      entry.identity.includes("\0") ||
      typeof entry.beforeExists !== "boolean" ||
      !hasOwn(entry, "appliedEntry")
    ) {
      throw new Error(`Receipt settings appliedPackages[${index}] is invalid.`);
    }
    if (identities.has(entry.identity)) {
      throw new Error(`Receipt settings has duplicate package identity ${entry.identity}.`);
    }
    identities.add(entry.identity);
    if (entry.beforeExists !== hasOwn(entry, "beforeEntry")) {
      throw new Error(`Receipt settings appliedPackages[${index}] has invalid previous state.`);
    }
    return {
      identity: entry.identity,
      beforeExists: entry.beforeExists,
      ...(entry.beforeExists ? { beforeEntry: cloneJsonValue(entry.beforeEntry) } : {}),
      appliedEntry: cloneJsonValue(entry.appliedEntry),
    };
  });
  return { ...base, appliedPackages };
}

function validateAppliedValueMap(
  value: unknown,
  label: string,
): Record<string, AppliedValueChange> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Receipt ${label} must be an object.`);
  const result: Record<string, AppliedValueChange> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      !isRecord(entry) ||
      typeof entry.beforeExists !== "boolean" ||
      !hasOwn(entry, "appliedValue") ||
      entry.beforeExists !== hasOwn(entry, "beforeValue")
    ) {
      throw new Error(`Receipt ${label}.${name} is invalid.`);
    }
    defineJsonProperty(result, name, {
      beforeExists: entry.beforeExists,
      ...(entry.beforeExists ? { beforeValue: cloneJsonValue(entry.beforeValue) } : {}),
      appliedValue: cloneJsonValue(entry.appliedValue),
    });
  }
  return result;
}

function validateReceiptOwnership(
  receipt: ActivationReceipt,
  manifest: ActivationManifest,
  project: string,
): void {
  if (receipt.pluginSlug !== manifest.pluginSlug || receipt.project !== project) {
    throw new Error("Existing activation receipt does not belong to this converted package/project.");
  }
}

async function resolvePluginId(input: string, project: string): Promise<string> {
  const candidate = resolve(input);
  try {
    if ((await stat(candidate)).isDirectory()) {
      return (await readActivationManifest(await realpath(candidate))).pluginId;
    }
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  if (isAbsolute(input) || input.includes("/") || input.includes("\\")) {
    throw new Error(`Converted package directory does not exist: ${input}.`);
  }
  const pluginId = requireSafeComponent(input, "plugin id");
  await assertSafeProjectTarget(project, receiptPathFor(project, pluginId));
  return pluginId;
}

function receiptPathFor(project: string, pluginId: string): string {
  requireSafeComponent(pluginId, "pluginId");
  return join(project, ".pi", "claude-pi-convert", pluginId, RECEIPT_FILE);
}

function resolveManifestPath(root: string, input: string, label: string): string {
  const normalized = normalizeRelative(input, true);
  const path = resolve(root, ...normalized.split("/"));
  assertContained(root, path, label);
  return path;
}

function resolveProjectRelative(project: string, input: string, label: string): string {
  const normalized = normalizeRelative(input);
  const path = resolve(project, ...normalized.split("/"));
  assertContained(project, path, label);
  return path;
}

function resolveReceiptTarget(project: string, input: string): string {
  return resolveProjectRelative(project, input, "receipt path");
}

function normalizeRelative(input: string, allowDot = false): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || input.includes("\\")) {
    throw new Error(`Unsafe relative path: ${String(input)}.`);
  }
  if (isAbsolute(input)) throw new Error(`Absolute paths are not allowed: ${input}.`);
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error(`Path traversal is not allowed: ${input}.`);
    parts.push(part);
  }
  if (parts.length === 0) {
    if (allowDot) return ".";
    throw new Error(`Empty relative path is not allowed: ${input}.`);
  }
  return parts.join("/");
}

function assertContained(root: string, path: string, label: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes its allowed root.`);
}

async function assertPackageRoot(packageRoot: string, convertedDir: string): Promise<void> {
  assertContained(convertedDir, packageRoot, "packageRoot");
  const rootInfo = await lstat(packageRoot);
  if (rootInfo.isSymbolicLink()) throw new Error(`packageRoot may not be a symlink: ${packageRoot}.`);
  const actual = await resolveExistingDirectory(packageRoot, "packageRoot");
  assertContained(convertedDir, actual, "packageRoot symlink");
  await assertRegularFile(join(actual, "package.json"), "converted package.json", true, convertedDir);
}

async function inspectPackageDependencies(packageRoot: string): Promise<DependencyCheck[]> {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = parseJsonObject(await readFile(packageJsonPath, "utf8"), packageJsonPath);
  if (packageJson.dependencies === undefined) return [];
  if (!isRecord(packageJson.dependencies)) {
    throw new Error(`${packageJsonPath}: dependencies must be an object.`);
  }
  const nodeModulesRoot = join(packageRoot, "node_modules");
  const checks: DependencyCheck[] = [];
  for (const [name, rawSpec] of Object.entries(packageJson.dependencies).sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    if (!isSafeNpmPackageName(name) || typeof rawSpec !== "string" || rawSpec.trim().length === 0) {
      checks.push({
        name,
        spec: typeof rawSpec === "string" ? rawSpec : String(rawSpec),
        packagePath: nodeModulesRoot,
        status: "unsupported",
        message: "dependency name/spec is invalid; pin it to a valid npm SemVer range",
      });
      continue;
    }
    const packagePath = resolve(nodeModulesRoot, ...name.split("/"));
    try {
      assertContained(nodeModulesRoot, packagePath, `dependency ${name}`);
    } catch (error) {
      checks.push({
        name,
        spec: rawSpec,
        packagePath,
        status: "unsupported",
        message: errorMessage(error),
      });
      continue;
    }
    let installedPackage: Record<string, unknown>;
    try {
      const actualPackagePath = await realpath(packagePath);
      assertContained(nodeModulesRoot, actualPackagePath, `installed dependency ${name}`);
      const installedPackageJson = join(actualPackagePath, "package.json");
      await assertRegularFile(
        installedPackageJson,
        `installed dependency ${name}`,
        false,
        nodeModulesRoot,
      );
      installedPackage = parseJsonObject(
        await readFile(installedPackageJson, "utf8"),
        installedPackageJson,
      );
    } catch (error) {
      checks.push({
        name,
        spec: rawSpec,
        packagePath,
        status: "missing",
        message: `missing from ${packagePath} (${errorMessage(error)})`,
      });
      continue;
    }
    const installedVersion =
      typeof installedPackage.version === "string" ? installedPackage.version : undefined;
    if (!installedVersion) {
      checks.push({
        name,
        spec: rawSpec,
        packagePath,
        status: "mismatch",
        message: `installed package has no valid version; expected ${rawSpec}`,
      });
      continue;
    }
    const satisfies = dependencyVersionSatisfies(installedVersion, rawSpec);
    if (satisfies === undefined) {
      checks.push({
        name,
        spec: rawSpec,
        packagePath,
        status: "unsupported",
        installedVersion,
        message: `dependency spec ${rawSpec} is not a verifiable SemVer range; pin an exact/ranged version`,
      });
    } else if (!satisfies) {
      checks.push({
        name,
        spec: rawSpec,
        packagePath,
        status: "mismatch",
        installedVersion,
        message: `installed ${installedVersion}, expected ${rawSpec}`,
      });
    } else {
      checks.push({
        name,
        spec: rawSpec,
        packagePath,
        status: "ok",
        installedVersion,
        message: `installed ${installedVersion} satisfies ${rawSpec}`,
      });
    }
  }
  return checks;
}

async function diagnosePackageDependencies(
  packageRoot: string,
  checks: DoctorCheck[],
): Promise<void> {
  const dependencies = await inspectPackageDependencies(packageRoot);
  if (dependencies.length === 0) {
    checks.push(okCheck("package-dependencies", "Converted package has no production dependencies."));
    return;
  }
  for (const dependency of dependencies) {
    const id = `dependency-${dependency.name}`;
    const detail = {
      spec: dependency.spec,
      installedVersion: dependency.installedVersion ?? null,
      packagePath: dependency.packagePath,
      installCommand: dependencyInstallCommand(packageRoot),
    };
    checks.push(
      dependency.status === "ok"
        ? okCheck(id, `${dependency.name}: ${dependency.message}.`, detail)
        : errorCheck(id, `${dependency.name}: ${dependency.message}.`, detail),
    );
  }
}

function dependencyInstallCommand(packageRoot: string): string {
  return `npm install --ignore-scripts --omit=dev --prefix ${JSON.stringify(packageRoot)}`;
}

function isSafeNpmPackageName(name: string): boolean {
  if (name.length === 0 || name.length > 214 || name.includes("\\")) return false;
  return /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function dependencyVersionSatisfies(versionText: string, rawRange: string): boolean | undefined {
  const version = parseSemVer(versionText);
  if (!version) return false;
  let range = rawRange.trim();
  if (range.startsWith("npm:")) {
    const alias = range.slice("npm:".length);
    const versionAt = alias.lastIndexOf("@");
    const scopedSeparator = alias.startsWith("@") ? alias.indexOf("/") : -1;
    if (versionAt <= Math.max(0, scopedSeparator)) return undefined;
    range = alias.slice(versionAt + 1);
  }
  if (!range || range === "*" || /^[xX]$/.test(range)) return true;
  if (/^(?:file|git|https?|workspace|link):/.test(range) || /^[A-Za-z][A-Za-z0-9._-]*$/.test(range)) {
    return undefined;
  }
  const alternatives = range.split("||").map((entry) => entry.trim()).filter(Boolean);
  if (alternatives.length === 0) return undefined;
  let recognized = false;
  for (const alternative of alternatives) {
    const result = satisfiesSemVerAlternative(version, alternative);
    if (result === undefined) continue;
    recognized = true;
    if (result) return true;
  }
  return recognized ? false : undefined;
}

function satisfiesSemVerAlternative(
  version: ParsedSemVer,
  alternative: string,
): boolean | undefined {
  const hyphen = alternative.match(/^\s*(\d+(?:\.\d+){0,2})\s+-\s+(\d+(?:\.\d+){0,2})\s*$/);
  if (hyphen?.[1] && hyphen[2]) {
    const lower = parsePartialSemVer(hyphen[1]);
    const upper = parsePartialSemVer(hyphen[2]);
    if (!lower || !upper) return undefined;
    return compareSemVer(version, lower.floor) >= 0 && compareSemVer(version, upper.ceilingExclusive) < 0;
  }
  const tokens = alternative.replaceAll(",", " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  for (const token of tokens) {
    const result = satisfiesSemVerToken(version, token);
    if (result === undefined) return undefined;
    if (!result) return false;
  }
  return true;
}

function satisfiesSemVerToken(version: ParsedSemVer, token: string): boolean | undefined {
  const operatorMatch = token.match(/^(\^|~|>=|<=|>|<|=)?(.+)$/);
  if (!operatorMatch?.[2]) return undefined;
  const operator = operatorMatch[1] ?? "";
  const value = operatorMatch[2];
  if (operator === "^" || operator === "~") {
    const partial = parsePartialSemVer(value);
    if (!partial) return undefined;
    const lower = partial.floor;
    let upper: ParsedSemVer;
    if (operator === "~") {
      upper = partial.components <= 1
        ? semVer(lower.major + 1, 0, 0)
        : semVer(lower.major, lower.minor + 1, 0);
    } else if (lower.major > 0) {
      upper = semVer(lower.major + 1, 0, 0);
    } else if (lower.minor > 0 || partial.components < 3) {
      upper = semVer(0, lower.minor + 1, 0);
    } else {
      upper = semVer(0, 0, lower.patch + 1);
    }
    return compareSemVer(version, lower) >= 0 && compareSemVer(version, upper) < 0;
  }
  const partial = parsePartialSemVer(value);
  if (!partial) return undefined;
  if (operator === ">=") return compareSemVer(version, partial.floor) >= 0;
  if (operator === ">") return compareSemVer(version, partial.floor) > 0;
  if (operator === "<=") {
    return partial.components === 3
      ? compareSemVer(version, partial.floor) <= 0
      : compareSemVer(version, partial.ceilingExclusive) < 0;
  }
  if (operator === "<") return compareSemVer(version, partial.floor) < 0;
  if (operator === "=" || operator === "") {
    if (partial.components === 3) return compareSemVer(version, partial.floor) === 0;
    return (
      compareSemVer(version, partial.floor) >= 0 &&
      compareSemVer(version, partial.ceilingExclusive) < 0
    );
  }
  return undefined;
}

function parseSemVer(value: string): ParsedSemVer | undefined {
  const match = value.trim().match(
    /^[v=]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function parsePartialSemVer(value: string): {
  floor: ParsedSemVer;
  ceilingExclusive: ParsedSemVer;
  components: number;
} | undefined {
  const cleaned = value.replace(/^[v=]/, "");
  const match = cleaned.match(/^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!match?.[1]) return undefined;
  const raw = [match[1], match[2], match[3]];
  const wildcardIndex = raw.findIndex((part) => part === undefined || /^[xX*]$/.test(part));
  const components = wildcardIndex === -1 ? 3 : wildcardIndex;
  if (components === 0) {
    return {
      floor: semVer(0, 0, 0),
      ceilingExclusive: semVer(Number.MAX_SAFE_INTEGER, 0, 0),
      components: 0,
    };
  }
  const major = Number(raw[0]);
  const minor = components >= 2 ? Number(raw[1]) : 0;
  const patch = components >= 3 ? Number(raw[2]) : 0;
  const floor = semVer(major, minor, patch, match[4]);
  const ceilingExclusive =
    components === 1
      ? semVer(major + 1, 0, 0)
      : components === 2
        ? semVer(major, minor + 1, 0)
        : semVer(major, minor, patch + 1);
  return {
    floor,
    ceilingExclusive,
    components,
  };
}

function semVer(major: number, minor: number, patch: number, prerelease?: string): ParsedSemVer {
  return { major, minor, patch, prerelease: prerelease ? prerelease.split(".") : [] };
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a.localeCompare(b, "en");
  }
  return 0;
}

async function assertRegularFile(
  path: string,
  label: string,
  rejectSymlink: boolean,
  allowedRealRoot?: string,
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissingError(error)) throw new Error(`${label} does not exist: ${path}.`);
    throw error;
  }
  if (rejectSymlink && info.isSymbolicLink()) throw new Error(`${label} may not be a symlink: ${path}.`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}.`);
  if (allowedRealRoot) {
    const actual = await realpath(path);
    assertContained(allowedRealRoot, actual, `${label} symlink`);
  }
}

async function assertSafeProjectTarget(project: string, target: string): Promise<void> {
  assertContained(project, target, "project target");
  const rel = relative(project, target);
  let current = project;
  const segments = rel.split(sep).slice(0, -1);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Target ancestor is a symlink: ${current}.`);
      if (!info.isDirectory()) throw new Error(`Target ancestor is not a directory: ${current}.`);
    } catch (error) {
      if (isMissingError(error)) break;
      throw error;
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Target is a symlink: ${target}.`);
    if (!info.isFile()) throw new Error(`Target is not a regular file: ${target}.`);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
}

async function assertNoCaseCollision(project: string, targetRelative: string): Promise<void> {
  let current = project;
  for (const segment of targetRelative.split("/")) {
    try {
      const entries = await readdir(current);
      const match = entries.find(
        (entry) => entry.toLocaleLowerCase("en-US") === segment.toLocaleLowerCase("en-US"),
      );
      if (match && match !== segment) {
        throw new Error(`Case-insensitive path collision: ${join(current, match)} vs ${segment}.`);
      }
      current = join(current, segment);
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
  }
}

function isAllowedOwnedPath(path: string, pluginId?: string, pluginSlug?: string): boolean {
  if (!pluginId || !pluginSlug) return false;
  const runtimePrefix = `.pi/claude-pi-convert/${pluginId}/runtime/`;
  const agentPrefix = `.pi/agents/${pluginSlug}.`;
  const skillPrefix = `.pi/skills/${pluginSlug}-`;
  return (
    path.startsWith(runtimePrefix) ||
    path.startsWith(agentPrefix) ||
    path.startsWith(skillPrefix)
  );
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to follow symlink: ${path}.`);
    if (!info.isFile()) throw new Error(`Expected a regular file: ${path}.`);
    return { exists: true, content: await readFile(path), mode: info.mode & 0o777 };
  } catch (error) {
    if (isMissingError(error)) return { exists: false };
    throw error;
  }
}

function snapshotFromReceipt(receipt: ReceiptFileChange): FileSnapshot {
  if (!receipt.beforeExists) return { exists: false };
  if (receipt.beforeContentBase64 === undefined) throw new Error(`Receipt has no previous content: ${receipt.path}.`);
  return {
    exists: true,
    content: Buffer.from(receipt.beforeContentBase64, "base64"),
    ...(receipt.beforeMode !== undefined ? { mode: receipt.beforeMode } : {}),
  };
}

function snapshotFromMcpReceipt(receipt: McpReceipt): FileSnapshot {
  return receipt.beforeContentBase64 === undefined
    ? { exists: false }
    : {
        exists: true,
        content: Buffer.from(receipt.beforeContentBase64, "base64"),
        mode: receipt.beforeMode ?? 0o644,
      };
}

async function preserveSensitiveFileMode(path: string, mode: number): Promise<void> {
  if (await pathExists(path)) await chmod(path, mode & 0o777);
}

function receiptChange(
  relativePath: string,
  before: FileSnapshot,
  afterContent: Buffer,
): ReceiptFileChange {
  return {
    path: normalizeRelative(relativePath),
    beforeExists: before.exists,
    ...(before.exists && before.content
      ? { beforeContentBase64: before.content.toString("base64") }
      : {}),
    ...(before.exists && before.mode !== undefined ? { beforeMode: before.mode } : {}),
    afterSha256: sha256(afterContent),
  };
}

async function restoreSnapshot(path: string, snapshot: FileSnapshot): Promise<void> {
  if (snapshot.exists) {
    if (!snapshot.content) throw new Error(`Cannot restore ${path}: previous content is missing.`);
    await atomicWrite(path, snapshot.content, snapshot.mode ?? 0o644);
  } else if (await pathExists(path)) {
    await unlink(path);
  }
}

async function atomicWrite(path: string, content: Buffer | string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { flag: "wx", mode: mode & 0o777 });
    await chmod(temp, mode & 0o777);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function resolveExistingDirectory(input: string, label: string): Promise<string> {
  const path = resolve(input);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isMissingError(error)) throw new Error(`${label} directory does not exist: ${path}.`);
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}.`);
  return realpath(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

async function pruneEmptyDirectories(start: string, stop: string): Promise<void> {
  let current = start;
  while (current !== stop && relative(stop, current) && !relative(stop, current).startsWith("..")) {
    try {
      await rmdir(current);
    } catch (error) {
      if (isMissingError(error)) {
        current = dirname(current);
        continue;
      }
      const code = errorCode(error);
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      throw error;
    }
    current = dirname(current);
  }
}

function parseJsonObject(text: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `${path}: invalid JSONC at offset ${first.offset} (${printParseErrorCode(first.error)}).`,
    );
  }
  if (!isRecord(value)) throw new Error(`${path}: expected a JSON object.`);
  return value;
}

function parseJsonObjectSnapshot(snapshot: FileSnapshot, path: string): Record<string, unknown> {
  if (!snapshot.exists) return {};
  if (!snapshot.content) throw new Error(`${path}: content is unavailable.`);
  return parseJsonObject(snapshot.content.toString("utf8"), path);
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonValue(value) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return Boolean(left.content && right.content && left.content.equals(right.content));
}

function snapshotMatchesHash(snapshot: FileSnapshot, expectedHash: string): boolean {
  return Boolean(snapshot.exists && snapshot.content && sha256(snapshot.content) === expectedHash);
}

function packageEntrySource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isRecord(value) && typeof value.source === "string" ? value.source : undefined;
}

function runtimeSource(requirement: RuntimeRequirement): string {
  return `npm:${requirement.packageName}@${requirement.version}`;
}

function runtimeInstallCommand(requirement: RuntimeRequirement): string {
  return `pi install -l ${runtimeSource(requirement)} --approve`;
}

async function runPi(args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return runCommand("pi", args, cwd, timeoutMs);
}

async function getPiVersion(): Promise<string> {
  const result = await runPi(["--version"], process.cwd(), 10_000);
  const match = `${result.stdout}\n${result.stderr}`.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  if (!match?.[1]) throw new Error("Unable to determine the installed Pi version.");
  return match[1];
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) + chunk.length > MAX_COMMAND_OUTPUT) {
        overflow = true;
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may have exited between the timeout and signal delivery.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), 2_000);
      hardTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectPromise(new Error(`${command} ${args.join(" ")} did not exit after timing out.`));
      }, 5_000);
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      rejectPromise(new Error(`Failed to run ${command}: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        rejectPromise(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms.`));
      } else if (overflow) {
        rejectPromise(new Error(`${command} produced more than ${MAX_COMMAND_OUTPUT} bytes of output.`));
      } else if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${String(code)}`;
        rejectPromise(
          new Error(`${command} ${args.join(" ")} failed${signal ? ` (${signal})` : ""}: ${detail}`),
        );
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

function assertMinimumNodeVersion(): void {
  if (compareVersions(process.versions.node, MIN_NODE_VERSION) < 0) {
    throw new Error(`Node >=${MIN_NODE_VERSION} is required; found ${process.versions.node}.`);
  }
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(value: string): number[] {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function requireSafeComponent(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_COMPONENT_PATTERN.test(value)) {
    throw new Error(`${label} must be a safe path component of at most 128 characters.`);
  }
  return value;
}

function validateBase64(value: string, label: string): void {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Receipt ${label} contains invalid base64.`);
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function defineJsonProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectRelative(project: string, path: string): string {
  return relative(project, path).split(sep).join("/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function plannedChangedPaths(
  files: PreparedFile[],
  existingReceipt: ActivationReceipt | undefined,
  mcpChanges: boolean,
  settingsChanges: boolean,
  receiptPath: string,
  project: string,
): string[] {
  const nextTargets = new Set(files.map((file) => file.targetRelative));
  const stale = existingReceipt?.files
    .map((change) => normalizeRelative(change.path))
    .filter((path) => !nextTargets.has(path)) ?? [];
  return uniqueStrings([
    ...files.map((file) => file.targetRelative),
    ...stale,
    ...(mcpChanges || existingReceipt?.mcp ? [MCP_RELATIVE_PATH] : []),
    ...(settingsChanges ? [SETTINGS_RELATIVE_PATH] : []),
    projectRelative(project, receiptPath),
  ]);
}

function okCheck(id: string, message: string, detail?: unknown): DoctorCheck {
  return { id, status: "ok", message, ...(detail !== undefined ? { detail } : {}) };
}

function warningCheck(id: string, message: string, detail?: unknown): DoctorCheck {
  return { id, status: "warning", message, ...(detail !== undefined ? { detail } : {}) };
}

function errorCheck(id: string, message: string, detail?: unknown): DoctorCheck {
  return { id, status: "error", message, ...(detail !== undefined ? { detail } : {}) };
}
