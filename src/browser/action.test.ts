import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/client";
import { runBrowserAction } from "./action.ts";

test("browser management actions use the selected runtime Worker and preserve exact results", async () => {
  let input: RunAgentInput | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      input = JSON.parse(body) as RunAgentInput;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId })}\n\n`);
      response.write(`data: ${JSON.stringify({
        type: "CUSTOM",
        name: "plurnk.action.result",
        value: { kind: "worker.mcp.list", ok: true, result: { definitions: [{ alias: "gitea" }] } },
      })}\n\n`);
      response.end(`data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    const result = await runBrowserAction<{ definitions: Array<{ alias: string }> }>({
      origin: `http://127.0.0.1:${address.port}`,
      runtimeUrl: "/api/copilotkit",
      agentId: "default",
      runtimeThreadId: JSON.stringify(["world", "worker"]),
    }, "worker.mcp.list");
    assert.deepEqual(result, { definitions: [{ alias: "gitea" }] });
    assert.equal(input?.threadId, JSON.stringify(["world", "worker"]));
    assert.deepEqual(input?.forwardedProps, {
      plurnk: { action: { kind: "worker.mcp.list" } },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause)));
  }
});
