import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { startPortal } from "./portal.ts";

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

const collect = async (agent: HttpAgent, input: RunAgentInput): Promise<BaseEvent[]> =>
  await new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });

test("the production portal serves assets and bridges CopilotKit to AG-UI", async () => {
  const upstreamInputs: RunAgentInput[] = [];
  let upstreamAuthorization: string | undefined;
  let upstreamBrowserAuthorization: string | undefined;
  const upstream = await listen((request, response) => {
    upstreamAuthorization = request.headers.authorization;
    upstreamBrowserAuthorization = request.headers["x-browser-secret"] as string | undefined;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const upstreamInput = JSON.parse(body) as RunAgentInput;
      upstreamInputs.push(upstreamInput);
      response.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no" });
      response.write(`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: upstreamInput.threadId, runId: upstreamInput.runId })}\n\n`);
      if ((upstreamInput.forwardedProps as { plurnk?: { mode?: unknown } } | undefined)?.plurnk?.mode === "sync") {
        response.write(`data: ${JSON.stringify({ type: "STATE_SNAPSHOT", snapshot: { plurnk: { workspace: { name: "web-test" } } } })}\n\n`);
        response.write(`data: ${JSON.stringify({
          type: "MESSAGES_SNAPSHOT",
          messages: [{ id: "durable-answer", role: "assistant", content: "durable hello" }],
        })}\n\n`);
        response.end(`data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: upstreamInput.threadId, runId: upstreamInput.runId, outcome: { type: "success" } })}\n\n`);
        return;
      }
      response.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "hello" })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_END", messageId: "answer" })}\n\n`);
      response.end(`data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: upstreamInput.threadId, runId: upstreamInput.runId, outcome: { type: "success" } })}\n\n`);
    });
  });
  const assets = await mkdtemp(join(tmpdir(), "plurnk-web-assets-"));
  await writeFile(join(assets, "index.html"), "<!doctype html><title>PLURNK test</title>");
  const portal = await startPortal({
    host: "127.0.0.1",
    port: 0,
    upstream: upstream.url,
    token: "daemon-secret",
    session: { workspace: "web-test", threadId: "web-test" },
    runProperties: {
      policy: { capabilities: {}, proposals: "review" },
      maxTurns: 7,
    },
    autoAcceptProposals: true,
    assetRoot: assets,
  });
  try {
    const page = await fetch(portal.origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /PLURNK test/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);

    const bootstrapResponse = await fetch(`${portal.origin}/bootstrap.json`);
    assert.equal(bootstrapResponse.status, 200);
    assert.deepEqual(await bootstrapResponse.json(), {
      runtimeUrl: "/api/copilotkit",
      agentId: "default",
      workspace: "web-test",
      threadId: "web-test",
      autoAcceptProposals: true,
    });

    const info = await fetch(`${portal.origin}/api/copilotkit/info`);
    assert.equal(info.status, 200);
    assert(Object.hasOwn(await info.json() as object, "agents"));
    assert.match(info.headers.get("content-security-policy") ?? "", /default-src 'self'/);

    const agent = new HttpAgent({
      url: `${portal.origin}/api/copilotkit/agent/default/run`,
      headers: {
        authorization: "Bearer browser-secret",
        "x-browser-secret": "must-not-forward",
      },
    });
    const input: RunAgentInput = {
      threadId: "web-test",
      runId: "web-run",
      state: {},
      messages: [{ id: "prompt", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: { plurnk: { workspace: "web-test" } },
    };
    const events = await collect(agent, input);
    assert(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "hello"));
    assert.equal(upstreamAuthorization, "Bearer daemon-secret");
    assert.equal(upstreamBrowserAuthorization, undefined);
    assert.equal(upstreamInputs[0]?.threadId, "web-test");
    assert.deepEqual(upstreamInputs[0]?.forwardedProps, {
      plurnk: {
        workspace: "web-test",
        policy: { capabilities: {}, proposals: "review" },
        maxTurns: 7,
      },
    });

    const connect = await fetch(`${portal.origin}/api/copilotkit/agent/default/connect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer browser-secret",
        "x-browser-secret": "must-not-forward",
      },
      body: JSON.stringify({ ...input, runId: "connect-run", messages: [] }),
    });
    assert.equal(connect.status, 200);
    const connectEvents = (await connect.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)) as BaseEvent);
    assert.ok(connectEvents.some((event) =>
      event.type === "MESSAGES_SNAPSHOT"
      && (event.messages as Array<{ id?: unknown }>).some(({ id }) => id === "durable-answer")), "connect asks the daemon for durable history");
    assert.deepEqual(upstreamInputs[1]?.forwardedProps, {
      plurnk: {
        workspace: "web-test",
        mode: "sync",
      },
    });
    assert.equal(upstreamInputs[1]?.messages.length, 0);
    assert.equal(upstreamAuthorization, "Bearer daemon-secret");
    assert.equal(upstreamBrowserAuthorization, undefined);

    const wrongOrigin = await fetch(`${portal.origin}/bootstrap.json`, {
      headers: { origin: "http://127.0.0.1:1" },
    });
    assert.equal(wrongOrigin.status, 403);
  } finally {
    await portal.close();
    await close(upstream.server);
    await rm(assets, { recursive: true });
  }
});
