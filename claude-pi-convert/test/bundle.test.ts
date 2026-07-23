import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUNDLE = path.join(ROOT, "dist/claude-pi-convert.mjs");
const FIXTURE = path.join(ROOT, "test/fixtures/full-plugin");

describe("standalone bundle", () => {
  it("runs without tsx or node_modules resolution at runtime", async () => {
    await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build.mjs")], { cwd: ROOT });

    const source = await readFile(BUNDLE, "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect((await stat(BUNDLE)).mode & 0o111).not.toBe(0);

    const { stdout: version } = await execFileAsync(BUNDLE, ["--version"], {
      cwd: await mkdtemp(path.join(tmpdir(), "claude-pi-empty-")),
    });
    expect(version.trim()).toBe("0.1.0");

    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-bundle-"));
    const output = path.join(parent, "converted");
    const { stdout } = await execFileAsync(
      BUNDLE,
      ["convert", FIXTURE, "--out", output, "--json"],
      { cwd: parent },
    );
    const report = JSON.parse(stdout) as { schemaVersion: number; output: string };
    expect(report).toMatchObject({ schemaVersion: 1, output });
    await expect(stat(path.join(output, "extensions/main.ts"))).resolves.toBeDefined();

    const strictOutput = path.join(parent, "strict-output");
    let strictCode: unknown;
    try {
      await execFileAsync(BUNDLE, ["convert", FIXTURE, "--out", strictOutput, "--strict"]);
    } catch (error) {
      strictCode = (error as { code?: unknown }).code;
    }
    expect(strictCode).toBe(2);

    if (process.platform !== "win32") {
      const remoteParent = await mkdtemp(path.join(tmpdir(), "claude-pi-github-bundle-"));
      const bin = join(remoteParent, "bin");
      await mkdir(bin);
      const fakeGit = join(bin, "git");
      await writeFile(fakeGit, [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "fs.cpSync(process.env.CLAUDE_PI_TEST_SOURCE, process.argv.at(-1), { recursive: true });",
      ].join("\n"));
      await chmod(fakeGit, 0o755);

      const { stdout: remoteStdout } = await execFileAsync(
        BUNDLE,
        ["addyosmani/agent-skills", "--json"],
        {
          cwd: remoteParent,
          env: {
            ...process.env,
            CLAUDE_PI_TEST_SOURCE: FIXTURE,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      const remoteReport = JSON.parse(remoteStdout) as { source: string; output: string };
      expect(remoteReport).toEqual(expect.objectContaining({
        source: "https://github.com/addyosmani/agent-skills",
        output: join(await realpath(remoteParent), "extensions", "agent-skills"),
      }));
      await expect(stat(join(remoteReport.output, "package.json"))).resolves.toBeDefined();
    }
  });
});
