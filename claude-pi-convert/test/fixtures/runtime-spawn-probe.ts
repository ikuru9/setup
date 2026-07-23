function eventData(event: any): any {
  return event?.data && typeof event.data === "object" ? event.data : event;
}

export default function runtimeSpawnProbe(pi: any): void {
  pi.registerCommand("runtime-spawn-probe", {
    description: "Spawn a deterministic subagent through public event RPC",
    handler: async () => {
      const requestId = `runtime-spawn-${Date.now()}-${Math.random()}`;
      const description = `runtime spawn probe ${requestId}`;
      let spawnedId: string | undefined;
      let earlyOutcome: unknown;
      let completeOutcome: (value: unknown) => void = () => {};
      const outcomePromise = new Promise((resolve) => { completeOutcome = resolve; });
      const unsubscribeComplete = pi.events.on("subagents:completed", (event: unknown) => {
        const data = eventData(event);
        if (data?.id === spawnedId || data?.description === description) {
          if (spawnedId) completeOutcome(event);
          else earlyOutcome = event;
        }
      });
      const unsubscribeFailed = pi.events.on("subagents:failed", (event: unknown) => {
        const data = eventData(event);
        if (data?.id === spawnedId || data?.description === description) {
          if (spawnedId) completeOutcome(event);
          else earlyOutcome = event;
        }
      });
      const reply = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("pi-subagents spawn RPC timed out")), 5_000);
        const replyEvent = `subagents:rpc:spawn:reply:${requestId}`;
        const unsubscribeReply = pi.events.on(replyEvent, (value: unknown) => {
          clearTimeout(timer);
          unsubscribeReply();
          resolve(value);
        });
        pi.events.emit("subagents:rpc:spawn", {
          requestId,
          type: "general-purpose",
          prompt: "Return the deterministic mock response.",
          options: {
            description,
            run_in_background: true,
            model: "runtime-smoke/runtime-smoke-model",
          },
        });
      });
      if (!reply?.success || !reply?.data?.id) throw new Error(reply?.error || "subagent spawn failed");
      spawnedId = reply.data.id;
      if (earlyOutcome) completeOutcome(earlyOutcome);
      const outcome = await Promise.race([
        outcomePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("subagent completion timed out")), 10_000)),
      ]);
      unsubscribeComplete();
      unsubscribeFailed();
      pi.sendMessage({
        customType: "runtime-spawn-probe",
        content: JSON.stringify({ reply, outcome }),
        display: false,
      });
    },
  });
}
