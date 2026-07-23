function subagentPing(pi: any): Promise<unknown> {
  const requestId = `runtime-probe-${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const replyEvent = `subagents:rpc:ping:reply:${requestId}`;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("pi-subagents ping timed out"));
    }, 2_000);
    const unsubscribe = pi.events.on(replyEvent, (reply: unknown) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(reply);
    });
    pi.events.emit("subagents:rpc:ping", { requestId });
  });
}

export default function runtimeProbe(pi: any): void {
  pi.registerCommand("runtime-probe", {
    description: "Report public runtime registrations",
    handler: async () => {
      const subagents = await subagentPing(pi);
      const tools = pi.getAllTools().map((tool: { name: string; sourceInfo?: unknown }) => ({
        name: tool.name,
        sourceInfo: tool.sourceInfo,
      }));
      pi.sendMessage({
        customType: "runtime-probe",
        content: JSON.stringify({ subagents, tools }),
        display: false,
      });
    },
  });
}
