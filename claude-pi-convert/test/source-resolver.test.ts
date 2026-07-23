import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { convertPlugin } from "../src/converter.js";
import {
  parseGitHubRepositorySource,
  resolveConversionSource,
} from "../src/source-resolver.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/full-plugin/", import.meta.url));

describe("GitHub conversion source resolution", () => {
  test("accepts canonical GitHub URLs and owner/repository shorthand only", () => {
    expect(parseGitHubRepositorySource("addyosmani/agent-skills")).toEqual({
      owner: "addyosmani",
      repository: "agent-skills",
      url: "https://github.com/addyosmani/agent-skills.git",
    });
    expect(parseGitHubRepositorySource("https://github.com/addyosmani/agent-skills")).toMatchObject({
      owner: "addyosmani",
      repository: "agent-skills",
    });
    expect(parseGitHubRepositorySource("https://example.test/addyosmani/agent-skills")).toBeUndefined();
    expect(parseGitHubRepositorySource("https://github.com/addyosmani/agent-skills/tree/main")).toBeUndefined();
  });

  test("uses extensions/<repository> as the remote default output and removes its temporary clone", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-github-source-"));
    const clonedDestinations: string[] = [];
    try {
      const resolved = await resolveConversionSource("addyosmani/agent-skills", {
        cwd: parent,
        clone: async (_repository, destination) => {
          clonedDestinations.push(destination);
          await cp(FIXTURE, destination, { recursive: true });
        },
      });
      expect(resolved.defaultOutput).toBe(path.join(parent, "extensions", "agent-skills"));
      expect(resolved.sourceDisplay).toBe("https://github.com/addyosmani/agent-skills");
      expect(resolved.sourceDisplay).toBeDefined();
      expect(resolved.defaultOutput).toBeDefined();

      const report = await convertPlugin({
        source: resolved.source,
        sourceDisplay: resolved.sourceDisplay!,
        output: resolved.defaultOutput!,
      });
      expect(report.source).toBe("https://github.com/addyosmani/agent-skills");
      expect(report.output).toBe(path.join(parent, "extensions", "agent-skills"));

      await resolved.cleanup();
      await expect(stat(clonedDestinations[0]!)).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("preserves local directory behavior over a matching shorthand", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-local-source-"));
    const source = path.join(parent, "addyosmani", "agent-skills");
    try {
      await mkdir(source, { recursive: true });
      const resolved = await resolveConversionSource("addyosmani/agent-skills", { cwd: parent });
      expect(resolved.source).toBe(source);
      expect(resolved.sourceDisplay).toBeUndefined();
      expect(resolved.defaultOutput).toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
