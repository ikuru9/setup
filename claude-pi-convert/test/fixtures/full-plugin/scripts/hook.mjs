let input = "";
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input || "{}");
process.stdout.write(JSON.stringify({ additionalContext: `fixture:${event.hook_event_name ?? "unknown"}` }));
