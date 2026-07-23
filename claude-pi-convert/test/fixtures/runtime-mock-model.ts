import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function baseMessage(model: any): any {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export default function runtimeMockModel(pi: any): void {
  pi.registerProvider("runtime-smoke", {
    name: "Runtime smoke model",
    baseUrl: "http://127.0.0.1/runtime-smoke",
    apiKey: "runtime-smoke-test-key",
    api: "openai-completions",
    models: [{
      id: "runtime-smoke-model",
      name: "Runtime smoke model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    }],
    streamSimple(model: any, context: any): any {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const output = baseMessage(model);
        stream.push({ type: "start", partial: output });
        const hasToolResult = context.messages.some((message: { role?: string }) => message.role === "toolResult");
        if (process.env.RUNTIME_SMOKE_MODEL_MODE !== "subagent" && !hasToolResult) {
          const mcpTool = process.env.RUNTIME_SMOKE_MCP_TOOL;
          if (!mcpTool) throw new Error("RUNTIME_SMOKE_MCP_TOOL is required");
          const toolCall = {
            type: "toolCall" as const,
            id: `runtime-mcp-${Date.now()}`,
            name: "mcp",
            arguments: {
              tool: mcpTool,
              args: JSON.stringify({ value: "hook-smoke" }),
            },
          };
          output.content.push(toolCall);
          output.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
          stream.push({ type: "done", reason: "toolUse", message: output });
        } else {
          const content = process.env.RUNTIME_SMOKE_MODEL_MODE === "subagent"
            ? "mock subagent complete"
            : "runtime MCP call complete";
          output.content.push({ type: "text", text: content });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content, partial: output });
          stream.push({ type: "done", reason: "stop", message: output });
        }
        stream.end();
      });
      return stream;
    },
  });
}
