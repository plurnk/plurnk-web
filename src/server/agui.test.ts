import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { test } from "node:test";
import { resolveBrowserSession } from "./agui.ts";

const listen = async (handler: RequestListener): Promise<{
  server: Server;
  url: URL;
}> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return { server, url: new URL(`http://127.0.0.1:${address.port}`) };
};

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => cause === undefined ? resolve() : reject(cause));
  });
};

test("an explicit workspace resolves without contacting the daemon", async () => {
  const session = await resolveBrowserSession({
    upstream: new URL("http://127.0.0.1:1"),
    workspace: "project",
    worker: "conversation",
    projectRoot: "/workspace",
  });
  assert.deepEqual(session, { workspace: "project", threadId: "conversation" });
});

test("an implicit workspace is minted through the public AG-UI action", async () => {
  let input: Record<string, unknown> | undefined;
  let authorization: string | undefined;
  const { server, url } = await listen((request, response) => {
    authorization = request.headers.authorization;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      input = JSON.parse(body) as Record<string, unknown>;
      const run = input as { threadId: string; runId: string };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: run.threadId, runId: run.runId })}\n\n`);
      response.write(`data: ${JSON.stringify({
        type: "CUSTOM",
        name: "plurnk.action.result",
        value: { kind: "workspace.create", ok: true, result: { id: 7, name: "minted", workerId: 9 } },
      })}\n\n`);
      response.end(`data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: run.threadId, runId: run.runId, outcome: { type: "success" } })}\n\n`);
    });
  });
  try {
    const session = await resolveBrowserSession({
      upstream: url,
      token: "server-secret",
      projectRoot: "/workspace",
    });
    assert.deepEqual(session, { workspace: "minted", threadId: "minted" });
    assert.equal(authorization, "Bearer server-secret");
    assert.deepEqual(
      (input?.forwardedProps as { plurnk: unknown }).plurnk,
      { action: { kind: "workspace.create", projectRoot: "/workspace" } },
    );
  } finally {
    await close(server);
  }
});
