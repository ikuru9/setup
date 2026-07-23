import { appendFileSync } from "node:fs";
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "claude-pi-runtime-smoke", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "ping") {
    reply(request.id, {});
    return;
  }
  if (request.method === "tools/list") {
    reply(request.id, {
      tools: [{
        name: "echo",
        description: "Echo integration-test input",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }],
    });
    return;
  }
  if (request.method === "tools/call") {
    if (process.env.RUNTIME_SMOKE_MCP_CAPTURE) {
      appendFileSync(process.env.RUNTIME_SMOKE_MCP_CAPTURE, `${JSON.stringify(request.params)}\n`);
    }
    reply(request.id, {
      content: [{ type: "text", text: JSON.stringify(request.params?.arguments ?? {}) }],
    });
    return;
  }
  reply(request.id, {});
});
