import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  addTreeEntry,
  assertSafeRelativePath,
  collectSafeTree,
  pathExists,
  writeTreeAtomically,
} from "../src/fs-utils.js";

describe("safe filesystem helpers", () => {
  it("rejects portable traversal and absolute paths", () => {
    expect(() => assertSafeRelativePath("../secret")).toThrow(/escapes/);
    expect(() => assertSafeRelativePath("C:\\secret")).toThrow(/escapes/);
    expect(() => assertSafeRelativePath("/secret")).toThrow(/escapes/);
  });

  it("rejects a symlink that leaves the source root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-fs-"));
    const source = path.join(parent, "source");
    await mkdir(source);
    await writeFile(path.join(parent, "outside.txt"), "secret");
    await symlink(path.join(parent, "outside.txt"), path.join(source, "escape.txt"));
    await expect(collectSafeTree(source)).rejects.toThrow(/outside the plugin root/);
  });

  it.skipIf(process.platform === "win32")("rejects POSIX filenames containing a portable separator", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-filename-"));
    const source = path.join(parent, "source");
    await mkdir(source);
    await writeFile(path.join(source, "a\\b"), "ambiguous");
    await expect(collectSafeTree(source)).rejects.toThrow(/non-portable path separator/);
  });

  it("rejects case-insensitive sibling directory collisions", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-dir-collision-"));
    const source = path.join(parent, "source");
    await mkdir(path.join(source, "Agents"), { recursive: true });
    await mkdir(path.join(source, "agents"), { recursive: true });
    if ((await readdir(source)).length < 2) return;
    await writeFile(path.join(source, "Agents", "one.md"), "one");
    await writeFile(path.join(source, "agents", "two.md"), "two");
    await expect(collectSafeTree(source)).rejects.toThrow(/Case-insensitive source path collision/);
  });

  it("replaces only output carrying a valid ownership marker", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-write-"));
    const output = path.join(parent, "out");
    const first = new Map();
    addTreeEntry(
      first,
      "conversion-report.json",
      JSON.stringify({ schemaVersion: 1, converterVersion: "0.1.0" }),
    );
    addTreeEntry(first, "value.txt", "one");
    await writeTreeAtomically(output, first.values());

    const second = new Map();
    addTreeEntry(
      second,
      "conversion-report.json",
      JSON.stringify({ schemaVersion: 1, converterVersion: "0.1.0" }),
    );
    addTreeEntry(second, "value.txt", "two");
    await writeTreeAtomically(output, second.values(), { force: true });
    expect(await readFile(path.join(output, "value.txt"), "utf8")).toBe("two");
    expect(await pathExists(path.join(output, "conversion-report.json"))).toBe(true);
  });
});
