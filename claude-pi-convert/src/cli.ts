#!/usr/bin/env node
import { parseArgs } from "node:util";
import { activatePackage, activateUserPackage, deactivatePackage, doctorPackage } from "./activation.js";
import { convertPlugin } from "./converter.js";
import { resolveConversionSource } from "./source-resolver.js";
import type {
  ConversionIssue,
  ConversionReport,
  DoctorReport,
  OperationResult,
} from "./types.js";

const HELP = `claude-pi-convert - convert Claude Code plugins to Pi packages

Usage:
  claude-pi-convert <source> [-o <dir>]
  claude-pi-convert <github-owner>/<github-repository> [-o <dir>]
  claude-pi-convert https://github.com/<owner>/<repository> [-o <dir>]
  claude-pi-convert convert <source> --out <dir> [options]
  claude-pi-convert activate <converted-dir> (--project <dir> | --user) [options]
  claude-pi-convert deactivate <converted-dir|plugin-id> --project <dir> [options]
  claude-pi-convert doctor <converted-dir> --project <dir> [--json]

Options:
  -o, --out <dir>          Output directory (GitHub source default: extensions/<repository>)
  -p, --project <dir>      Pi project to activate/deactivate
      --user               Activate for every Pi project (~/.pi/agent)
      --strict             Exit 2 when compatibility is not exact
      --command-prefix     Add the plugin slug to generated slash commands
      --force              Replace only converter-owned conflicting files
      --dry-run            Show intended changes without writing
      --json               Print machine-readable JSON
      --include-secrets    Preserve literal MCP secrets (unsafe)
      --install-runtimes   Install exact Pi runtime packages in the selected scope
  -h, --help               Show this help
  -v, --version            Show converter version
`;

const VERSION = "0.1.0";

interface ParsedCli {
  command: "convert" | "activate" | "deactivate" | "doctor";
  target: string;
  values: Record<string, string | boolean | undefined>;
}

function parseCli(argv: string[]): ParsedCli | null {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string", short: "o" },
      project: { type: "string", short: "p" },
      user: { type: "boolean" },
      strict: { type: "boolean" },
      "command-prefix": { type: "boolean" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      "include-secrets": { type: "boolean" },
      "install-runtimes": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    return null;
  }
  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return null;
  }

  const first = parsed.positionals[0];
  if (!first) throw new Error("A source directory or command is required. Use --help for usage.");
  const known = new Set(["convert", "activate", "deactivate", "doctor"]);
  const command = (known.has(first) ? first : "convert") as ParsedCli["command"];
  const target = command === "convert" && !known.has(first) ? first : parsed.positionals[1];
  if (!target) throw new Error(`${command} requires a target path or plugin id.`);
  if (parsed.positionals.length > (known.has(first) ? 2 : 1)) {
    throw new Error(`Unexpected positional arguments: ${parsed.positionals.slice(known.has(first) ? 2 : 1).join(" ")}`);
  }
  return { command, target, values: parsed.values };
}

function summarizeIssues(issues: ConversionIssue[]): string[] {
  return issues.map((issue) => {
    const location = issue.source ? ` (${issue.source})` : "";
    return `[${issue.status}] ${issue.component}${location}: ${issue.message}`;
  });
}

function printConversion(report: ConversionReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Converted ${report.pluginId}\n`);
  process.stdout.write(`  source: ${report.source}\n`);
  process.stdout.write(`  output: ${report.output}\n`);
  if (report.runtimeRequirements.length > 0) {
    process.stdout.write("  runtimes:\n");
    for (const runtime of report.runtimeRequirements) {
      process.stdout.write(`    - ${runtime.packageName}@${runtime.version}: ${runtime.reason}\n`);
    }
  }
  const issues = summarizeIssues(report.issues);
  if (issues.length > 0) process.stdout.write(`\n${issues.join("\n")}\n`);
}

function printOperation(result: OperationResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.message}\n`);
  for (const path of result.changed) process.stdout.write(`  changed: ${path}\n`);
  for (const warning of result.warnings) process.stderr.write(`  warning: ${warning}\n`);
}

function printDoctor(report: DoctorReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const check of report.checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warning" ? "!" : "✗";
    process.stdout.write(`${icon} ${check.message}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  if (!args) return;
  const json = args.values.json === true;

  switch (args.command) {
    case "convert": {
      const source = await resolveConversionSource(args.target);
      let report: ConversionReport;
      try {
        report = await convertPlugin({
          source: source.source,
          ...(source.sourceDisplay ? { sourceDisplay: source.sourceDisplay } : {}),
          ...(typeof args.values.out === "string"
            ? { output: args.values.out }
            : source.defaultOutput
              ? { output: source.defaultOutput }
              : {}),
          strict: args.values.strict === true,
          commandPrefix: args.values["command-prefix"] === true,
          force: args.values.force === true,
          dryRun: args.values["dry-run"] === true,
          json,
          includeSecrets: args.values["include-secrets"] === true,
        });
      } finally {
        await source.cleanup();
      }
      printConversion(report, json);
      if (args.values.strict && report.issues.some((issue) => issue.status !== "converted")) {
        process.exitCode = 2;
      }
      return;
    }
    case "activate": {
      const project = args.values.project;
      if (args.values.user === true && typeof project === "string") {
        throw new Error("activate accepts either --project <dir> or --user, not both.");
      }
      const result = args.values.user === true
        ? await activateUserPackage({
          convertedDir: args.target,
          installRuntimes: args.values["install-runtimes"] === true,
          force: args.values.force === true,
          dryRun: args.values["dry-run"] === true,
        })
        : typeof project === "string"
          ? await activatePackage({
            convertedDir: args.target,
            project,
            installRuntimes: args.values["install-runtimes"] === true,
            force: args.values.force === true,
            dryRun: args.values["dry-run"] === true,
            json,
          })
          : (() => { throw new Error("activate requires --project <dir> or --user."); })();
      printOperation(result, json);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "deactivate": {
      const project = args.values.project;
      if (typeof project !== "string") throw new Error("deactivate requires --project <dir>.");
      const result = await deactivatePackage({
        convertedDirOrPluginId: args.target,
        project,
        force: args.values.force === true,
        dryRun: args.values["dry-run"] === true,
        json,
      });
      printOperation(result, json);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "doctor": {
      const project = args.values.project;
      if (typeof project !== "string") throw new Error("doctor requires --project <dir>.");
      const report = await doctorPackage({ convertedDir: args.target, project, json });
      printDoctor(report, json);
      if (!report.ok) process.exitCode = 1;
      return;
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`claude-pi-convert: ${message}\n`);
  }
  process.exitCode = 1;
});
