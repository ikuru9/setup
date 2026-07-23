#!/usr/bin/env node
import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await build({
  entryPoints: [new URL("../src/cli.ts", import.meta.url).pathname],
  outfile: new URL("../dist/claude-pi-convert.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // jsonc-parser publishes an ESM entry in `module` and a UMD entry in
  // `main`. Prefer ESM so the single-file executable contains no dynamic
  // CommonJS requires.
  mainFields: ["module", "main"],
  // yaml's Node build is CommonJS and dynamically requests Node built-ins.
  // Supply an ESM-scoped require for esbuild's compatibility shim while still
  // emitting the requested .mjs executable.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  sourcemap: true,
  legalComments: "inline",
});
await chmod(new URL("../dist/claude-pi-convert.mjs", import.meta.url), 0o755);
