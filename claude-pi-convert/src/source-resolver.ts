import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "./fs-utils.js";

export interface GitHubRepositorySource {
  owner: string;
  repository: string;
  url: string;
}

export interface ResolvedConversionSource {
  source: string;
  /** Used in reports so temporary clone locations are never exposed. */
  sourceDisplay?: string;
  /** Default output only for a remote repository source. */
  defaultOutput?: string;
  cleanup(): Promise<void>;
}

export interface ResolveConversionSourceOptions {
  cwd?: string;
  clone?: (repository: GitHubRepositorySource, destination: string) => Promise<void>;
}

/**
 * Parse the supported GitHub repository forms without accepting arbitrary Git URLs.
 * A local directory always takes precedence over the owner/repository shorthand.
 */
export function parseGitHubRepositorySource(value: string): GitHubRepositorySource | undefined {
  const trimmed = value.trim();
  let owner: string | undefined;
  let repository: string | undefined;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return undefined;
    [owner, repository] = parts;
  } catch {
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(trimmed);
    if (!match) return undefined;
    [, owner, repository] = match;
  }

  if (!owner || !repository) return undefined;
  repository = repository.replace(/\.git$/i, "");
  const validOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
  const validRepository = /^[A-Za-z0-9._-]+$/.test(repository);
  if (!validOwner || !validRepository || repository === "." || repository === "..") return undefined;
  return {
    owner,
    repository,
    url: `https://github.com/${owner}/${repository}.git`,
  };
}

export async function resolveConversionSource(
  input: string,
  options: ResolveConversionSourceOptions = {},
): Promise<ResolvedConversionSource> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const localSource = path.resolve(cwd, input);
  if (await pathExists(localSource)) {
    return { source: localSource, cleanup: async () => {} };
  }

  const repository = parseGitHubRepositorySource(input);
  if (!repository) {
    return { source: localSource, cleanup: async () => {} };
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "claude-pi-convert-github-"));
  const destination = path.join(temporaryRoot, repository.repository);
  try {
    await (options.clone ?? cloneGitHubRepository)(repository, destination);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    source: destination,
    sourceDisplay: repository.url.slice(0, -4),
    defaultOutput: path.join(cwd, "extensions", repository.repository),
    cleanup: async () => {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

async function cloneGitHubRepository(
  repository: GitHubRepositorySource,
  destination: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "protocol.file.allow=never",
        "clone",
        "--depth",
        "1",
        "--no-tags",
        "--single-branch",
        "--",
        repository.url,
        destination,
      ],
      { shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`GitHub repository download failed (${repository.url}): ${stderr.trim() || `git exited ${code}`}`));
    });
  });
}
