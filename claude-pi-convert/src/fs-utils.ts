import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export interface TreeEntry {
  path: string;
  content: Uint8Array;
  mode: number;
}

export interface CollectTreeOptions {
  /** Paths relative to root that should not be copied. */
  exclude?: ReadonlySet<string>;
}

export interface WriteTreeOptions {
  force?: boolean;
  dryRun?: boolean;
  /** A generated output must contain this file before --force may replace it. */
  ownershipMarker?: string;
  /** Expected identity recorded by a converter ownership receipt. */
  expectedOwnership?: {
    output: string;
    owner: string;
  };
}

interface TreeOwnershipReceipt {
  schemaVersion: 1;
  converterVersion: string;
  output: string;
  owner: string;
  files: Array<{ path: string; sha256: string; mode: number }>;
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function assertSafeRelativePath(value: string, label = "path"): string {
  if (!value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty path`);
  }

  const portable = value.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    WINDOWS_DRIVE.test(value) ||
    portable.split("/").some((part) => part === "..")
  ) {
    throw new Error(`${label} escapes the plugin root: ${value}`);
  }

  const normalized = path.posix.normalize(portable.replace(/^\.\//, ""));
  if (normalized === "." || normalized.startsWith("../")) {
    throw new Error(`${label} is not a usable relative path: ${value}`);
  }
  return normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function resolveSafePath(root: string, relativePath: string, label = "path"): string {
  const safe = assertSafeRelativePath(relativePath, label);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!isPathInside(root, resolved)) {
    throw new Error(`${label} escapes the plugin root: ${relativePath}`);
  }
  return resolved;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Resolve a plugin-controlled path and reject symlinks that resolve outside the
 * source tree. The returned path is canonical, which also makes subsequent
 * reads immune to `..` traversal hidden behind a link.
 */
export async function resolvePluginPath(
  sourceRoot: string,
  relativePath: string,
  label = "plugin path",
): Promise<string> {
  const root = await realpath(sourceRoot);
  const candidate = resolveSafePath(root, relativePath, label);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`${label} does not exist: ${relativePath}`);
    }
    throw error;
  }
  if (!isPathInside(root, canonical)) {
    throw new Error(`${label} resolves outside the plugin root: ${relativePath}`);
  }
  return canonical;
}

/**
 * Recursively reads a source tree without executing anything. Internal
 * symlinks are dereferenced into regular output files; external and cyclic
 * symlinks are rejected. Case-insensitive collisions are rejected so output is
 * portable between Linux, macOS, and Windows.
 */
export async function collectSafeTree(
  sourceRoot: string,
  options: CollectTreeOptions = {},
): Promise<TreeEntry[]> {
  const root = await realpath(sourceRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Source is not a directory: ${sourceRoot}`);

  const entries: TreeEntry[] = [];
  const caseFolded = new Map<string, string>();
  const activeDirectories = new Set<string>();
  const excluded = options.exclude ?? new Set<string>();

  async function walk(logicalRelative: string, physicalPath: string): Promise<void> {
    const canonical = await realpath(physicalPath);
    if (!isPathInside(root, canonical)) {
      throw new Error(`Symlink resolves outside the plugin root: ${logicalRelative}`);
    }

    const physicalStat = await stat(canonical);
    if (physicalStat.isDirectory()) {
      if (activeDirectories.has(canonical)) {
        throw new Error(`Cyclic directory symlink: ${logicalRelative || "."}`);
      }
      activeDirectories.add(canonical);
      try {
        const children = await readdir(canonical, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name, "en"));
        const siblingNames = new Map<string, string>();
        for (const child of children) {
          if (child.name.includes("\\")) {
            throw new Error(
              `Source filename contains a non-portable path separator: ${child.name}`,
            );
          }
          const siblingKey = child.name.normalize("NFC").toLocaleLowerCase("en-US");
          const previousSibling = siblingNames.get(siblingKey);
          if (previousSibling && previousSibling !== child.name) {
            throw new Error(
              `Case-insensitive source path collision: ${previousSibling} and ${child.name}`,
            );
          }
          siblingNames.set(siblingKey, child.name);
          const childRelative = logicalRelative
            ? `${logicalRelative}/${child.name}`
            : child.name;
          const normalized = assertSafeRelativePath(childRelative, "source entry");
          if (excluded.has(normalized)) continue;
          await walk(normalized, path.join(canonical, child.name));
        }
      } finally {
        activeDirectories.delete(canonical);
      }
      return;
    }

    if (!physicalStat.isFile()) {
      throw new Error(`Unsupported source entry type: ${logicalRelative}`);
    }

    const folded = logicalRelative.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = caseFolded.get(folded);
    if (previous && previous !== logicalRelative) {
      throw new Error(
        `Case-insensitive source path collision: ${previous} and ${logicalRelative}`,
      );
    }
    caseFolded.set(folded, logicalRelative);
    entries.push({
      path: logicalRelative,
      content: await readFile(canonical),
      mode: physicalStat.mode & 0o777,
    });
  }

  await walk("", root);
  return entries;
}

export function addTreeEntry(
  entries: Map<string, TreeEntry>,
  relativePath: string,
  content: string | Uint8Array,
  mode = 0o644,
): void {
  const safePath = assertSafeRelativePath(relativePath, "output path");
  const folded = safePath.normalize("NFC").toLocaleLowerCase("en-US");
  for (const existing of entries.keys()) {
    if (existing.normalize("NFC").toLocaleLowerCase("en-US") === folded && existing !== safePath) {
      throw new Error(`Case-insensitive output path collision: ${existing} and ${safePath}`);
    }
  }
  entries.set(safePath, {
    path: safePath,
    content: typeof content === "string" ? Buffer.from(content, "utf8") : content,
    mode,
  });
}

export async function writeTreeAtomically(
  outputDir: string,
  tree: Iterable<TreeEntry>,
  options: WriteTreeOptions = {},
): Promise<void> {
  const output = path.resolve(outputDir);
  const parent = path.dirname(output);
  const marker = options.ownershipMarker ?? "conversion-report.json";
  const exists = await pathExists(output);

  if (exists) {
    const outputStat = await lstat(output);
    if (!outputStat.isDirectory() || !options.force) {
      throw new Error(
        options.force
          ? `Output exists and is not a directory: ${output}`
          : `Output already exists (use --force for converter-owned output): ${output}`,
      );
    }
    const markerPath = resolveSafePath(output, marker, "ownership marker");
    if (!(await pathExists(markerPath))) {
      throw new Error(`Refusing to replace output not owned by claude-pi-convert: ${output}`);
    }
    const markerText = await readFile(markerPath, "utf8");
    try {
      const parsed = JSON.parse(markerText) as Partial<TreeOwnershipReceipt>;
      if (parsed.schemaVersion !== 1 || typeof parsed.converterVersion !== "string") {
        throw new Error("invalid marker");
      }
      if (options.expectedOwnership) {
        if (
          parsed.output !== path.resolve(options.expectedOwnership.output) ||
          parsed.owner !== options.expectedOwnership.owner ||
          !Array.isArray(parsed.files)
        ) {
          throw new Error("ownership identity mismatch");
        }
        const expectedFiles = new Map<string, { sha256: string; mode: number }>();
        for (const entry of parsed.files) {
          if (
            !entry ||
            typeof entry.path !== "string" ||
            typeof entry.sha256 !== "string" ||
            typeof entry.mode !== "number"
          ) {
            throw new Error("invalid ownership file entry");
          }
          const safePath = assertSafeRelativePath(entry.path, "ownership file");
          if (safePath === marker || expectedFiles.has(safePath)) {
            throw new Error("duplicate ownership file entry");
          }
          expectedFiles.set(safePath, { sha256: entry.sha256, mode: entry.mode });
        }
        const currentFiles = await collectSafeTree(output);
        for (const current of currentFiles) {
          if (current.path === marker) continue;
          const expected = expectedFiles.get(current.path);
          if (!expected) throw new Error(`unexpected file in owned output: ${current.path}`);
          if (sha256(current.content) !== expected.sha256 || current.mode !== expected.mode) {
            throw new Error(`converter-owned output file was modified: ${current.path}`);
          }
          expectedFiles.delete(current.path);
        }
        if (expectedFiles.size > 0) {
          throw new Error(`converter-owned output file is missing: ${expectedFiles.keys().next().value}`);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? ` (${error.message})` : "";
      throw new Error(`Refusing to replace output with an invalid ownership marker: ${output}${reason}`);
    }
  }

  if (options.dryRun) return;

  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(output)}.tmp-${randomUUID()}`);
  const backup = path.join(parent, `.${path.basename(output)}.bak-${randomUUID()}`);
  let movedOldOutput = false;

  try {
    await mkdir(staging, { recursive: false });
    const sorted = [...tree].sort((a, b) => a.path.localeCompare(b.path, "en"));
    for (const entry of sorted) {
      const destination = resolveSafePath(staging, entry.path, "output entry");
      await mkdir(path.dirname(destination), { recursive: true });
      const handle = await open(destination, "wx", entry.mode);
      try {
        await handle.writeFile(entry.content);
      } finally {
        await handle.close();
      }
      await chmod(destination, entry.mode);
    }

    if (exists) {
      await rename(output, backup);
      movedOldOutput = true;
    }
    await rename(staging, output);
    if (movedOldOutput) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (movedOldOutput && !(await pathExists(output)) && (await pathExists(backup))) {
      await rename(backup, output);
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
