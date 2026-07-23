import type { RuntimeRequirement } from "./types.js";

export const CONVERTER_VERSION = "0.1.0";
export const TARGET_PI_VERSION = "0.81.1";
export const MIN_NODE_VERSION = "22.19.0";

export const RUNTIMES = {
  subagents: {
    id: "pi-subagents",
    source: "https://github.com/tintinweb/pi-subagents",
    packageName: "@tintinweb/pi-subagents",
    version: "0.14.2",
  },
  mcp: {
    id: "pi-mcp-adapter",
    source: "https://github.com/nicobailon/pi-mcp-adapter",
    packageName: "pi-mcp-adapter",
    version: "2.11.0",
  },
  web: {
    id: "pi-web-access",
    source: "https://github.com/nicobailon/pi-web-access",
    packageName: "pi-web-access",
    version: "0.13.0",
  },
} as const;

export function runtimeRequirement(
  key: keyof typeof RUNTIMES,
  reason: string,
): RuntimeRequirement {
  const runtime = RUNTIMES[key];
  return {
    ...runtime,
    required: true,
    reason,
    ...(key === "web" ? { resourceFilter: { skills: [] } } : {}),
  } as RuntimeRequirement;
}
