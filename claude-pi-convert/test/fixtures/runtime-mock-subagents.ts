export default function runtimeMockSubagents(pi: any): void {
  const spawns: unknown[] = [];

  pi.events.on("subagents:rpc:ping", (request: { requestId: string }) => {
    pi.events.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
      success: true,
      data: { version: 1 },
    });
  });

  pi.events.on("subagents:rpc:spawn", (request: Record<string, unknown>) => {
    spawns.push(request);
    const id = `mock-hook-agent-${spawns.length}`;
    pi.events.emit(`subagents:rpc:spawn:reply:${request.requestId}`, {
      success: true,
      data: { id },
    });
    queueMicrotask(() => {
      pi.events.emit("subagents:completed", {
        id,
        type: "general-purpose",
        description: "[claude-pi-hook:runtime-agent-hooks] mock",
        result: JSON.stringify({ hookSpecificOutput: { additionalContext: "mock complete" } }),
      });
    });
  });

  pi.events.on("subagents:rpc:stop", (request: { requestId: string }) => {
    pi.events.emit(`subagents:rpc:stop:reply:${request.requestId}`, { success: true });
  });

  pi.registerCommand("runtime-mock-subagent", {
    description: "Trigger a public subagent lifecycle event",
    handler: async () => {
      spawns.length = 0;
      pi.events.emit("subagents:completed", {
        id: "source-agent",
        type: "review",
        description: "source agent",
        result: "source result",
      });
      const deadline = Date.now() + 2_000;
      while (spawns.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      pi.sendMessage({
        customType: "runtime-mock-subagent",
        content: JSON.stringify({ spawns }),
        display: false,
      });
    },
  });
}
