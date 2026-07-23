import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertPlugin } from "../src/converter.js";

const PI = process.platform === "win32" ? "pi.cmd" : "pi";
const PI_VERSION = spawnSync(PI, ["--version"], { encoding: "utf8" });
const HAS_TARGET_PI = PI_VERSION.status === 0 && /\b0\.81\.1\b/.test(
  `${PI_VERSION.stdout ?? ""}\n${PI_VERSION.stderr ?? ""}`,
);
const FIXTURE = fileURLToPath(new URL("./fixtures/full-plugin/", import.meta.url));

describe("Pi 0.81.1 smoke", () => {
  it.skipIf(!HAS_TARGET_PI)("loads generated extensions and resources through public package discovery", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claude-pi-runtime-"));
    const output = path.join(parent, "converted");
    const piHome = path.join(parent, "pi-agent");
    await mkdir(piHome);
    await convertPlugin({ source: FIXTURE, output });

    const child = spawn(
      PI,
      ["--mode", "rpc", "--offline", "--no-session", "-e", output, "--approve"],
      {
        cwd: parent,
        env: { ...process.env, PI_CODING_AGENT_DIR: piHome, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    try {
      child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Pi RPC timed out. stderr: ${stderr}`)), 10_000);
        const inspect = (): void => {
          for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const value = JSON.parse(line) as Record<string, unknown>;
              if (value.type === "response" && value.command === "get_commands") {
                clearTimeout(timer);
                resolve(value);
                return;
              }
            } catch {
              // Wait for a complete newline-delimited JSON value.
            }
          }
        };
        child.stdout.on("data", inspect);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timer);
            reject(new Error(`Pi exited ${code}. stderr: ${stderr}`));
          }
        });
      });

      const data = response.data as { commands?: Array<{ name?: string; source?: string }> };
      expect(data.commands).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "review", source: "extension" }),
        expect.objectContaining({ name: "acme-review-tools.output-style", source: "extension" }),
        expect.objectContaining({ name: "skill:acme-review-tools-audit", source: "skill" }),
      ]));
      expect(stderr).not.toMatch(/failed to load|syntaxerror|extension error/i);
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
    }
  }, 15_000);
});
