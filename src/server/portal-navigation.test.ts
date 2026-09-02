import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { test } from "node:test";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { startPortal, type BrowserBootstrap } from "./portal.ts";

const listen = async (handler: RequestListener): Promise<{ server: Server; url: URL }> => {
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

const upstreamFixture = async (): Promise<{
  server: Server;
  url: URL;
  inputs: RunAgentInput[];
}> => {
  const inputs: RunAgentInput[] = [];
  const workspaces = new Set<string>();
  const workers = new Map<string, Set<string>>();
  let automaticWorkspace = 0;
  const { server, url } = await listen((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body) as RunAgentInput;
      inputs.push(input);
      const plurnk = (input.forwardedProps as {
        plurnk?: { workspace?: string; mode?: string; action?: { kind: string; name?: string } };
      } | undefined)?.plurnk;
      const action = plurnk?.action;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (event: BaseEvent | Record<string, unknown>): void => {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      if (action !== undefined) {
        let result: unknown = {};
        if (action.kind === "workspace.create") {
          const name = action.name ?? `world-${++automaticWorkspace}`;
          workspaces.add(name);
          workers.set(name, workers.get(name) ?? new Set());
          result = { id: workspaces.size, name, workerId: 1 };
        } else if (action.kind === "workspace.workers") {
          const workspace = plurnk?.workspace;
          if (typeof workspace !== "string") throw new Error("workspace.workers received no workspace");
          workspaces.add(workspace);
          const names = workers.get(workspace) ?? new Set<string>();
          names.add(input.threadId);
          workers.set(workspace, names);
          result = {
            workers: [...names].map((name, index) => ({
              id: index + 1,
              name,
              created_at: "now",
              origin: "client",
              parentWorkerId: null,
            })),
          };
        } else if (action.kind === "workspace.list") {
          result = {
            workspaces: [...workspaces].map((name, index) => ({
              id: index + 1,
              name,
              project_root: "/workspace",
              created_at: "now",
            })),
          };
        }
        emit({
          type: "CUSTOM",
          name: "plurnk.action.result",
          value: { kind: action.kind, ok: true, result },
        });
      } else if (plurnk?.mode === "sync") {
        emit({ type: "MESSAGES_SNAPSHOT", messages: [] });
      } else {
        emit({ type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" });
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "ok" });
        emit({ type: "TEXT_MESSAGE_END", messageId: "answer" });
      }
      emit({
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
        outcome: { type: "success" },
      });
      response.end();
    });
  });
  return { server, url, inputs };
};

test("a workspace-locked portal mints independent Worker URLs and forwards resolved configuration", async () => {
  const upstream = await upstreamFixture();
  const threadIds = ["thread-a", "thread-b"];
  const prepared: Array<{ workspace: string; threadId: string }> = [];
  const portal = await startPortal({
    host: "127.0.0.1",
    port: 0,
    upstream: upstream.url,
    constraints: { workspace: "fixed-world" },
    workspaceProperties: { projectRoot: "/workspace", settings: { filesItems: 4 } },
    runProperties: { policy: { capabilities: {}, proposals: "review" }, maxTurns: 7 },
    prepareSession: async (session) => { prepared.push(session); },
    autoAcceptProposals: true,
    createThreadId: () => threadIds.shift() ?? assert.fail("unexpected Worker allocation"),
  });
  try {
    const first = await fetch(portal.origin, { redirect: "manual" });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), "/fixed-world/thread-a");
    const second = await fetch(portal.origin, { redirect: "manual" });
    assert.equal(second.headers.get("location"), "/fixed-world/thread-b");

    const page = await fetch(`${portal.origin}/fixed-world/thread-a`);
    assert.equal(page.status, 200);
    const bootstrapResponse = await fetch(
      `${portal.origin}/bootstrap.json?path=${encodeURIComponent("/fixed-world/thread-a")}`,
    );
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json() as BrowserBootstrap;
    assert.deepEqual(bootstrap, {
      runtimeUrl: "/api/copilotkit",
      agentId: "default",
      workspace: "fixed-world",
      threadId: "thread-a",
      runtimeThreadId: JSON.stringify(["fixed-world", "thread-a"]),
      canonicalPath: "/fixed-world/thread-a",
      workspaceLocked: true,
      workerLocked: false,
      workspaces: ["fixed-world"],
      workers: ["thread-a"],
      autoAcceptProposals: true,
    });
    assert.deepEqual(prepared, [{ workspace: "fixed-world", threadId: "thread-a" }]);

    const agent = new HttpAgent({ url: `${portal.origin}/api/copilotkit/agent/default/run` });
    const events = await collect(agent, {
      threadId: bootstrap.runtimeThreadId,
      runId: "browser-run",
      state: {},
      messages: [{ id: "prompt", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    });
    assert(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "ok"));
    const run = upstream.inputs.at(-1);
    assert.equal(run?.threadId, "thread-a");
    assert.deepEqual(run?.forwardedProps, {
      plurnk: {
        workspace: "fixed-world",
        policy: { capabilities: {}, proposals: "review" },
        maxTurns: 7,
      },
    });

    const conflict = await fetch(`${portal.origin}/other/thread-a`, { redirect: "manual" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { type: string }).type, "https://problems.plurnk.xyz/web/session-constraint");
  } finally {
    await portal.close();
    await close(upstream.server);
  }
});

test("the CopilotKit runner distinguishes an identical Worker name in two workspaces", async () => {
  const upstream = await upstreamFixture();
  const portal = await startPortal({
    host: "127.0.0.1",
    port: 0,
    upstream: upstream.url,
    constraints: {},
    workspaceProperties: {},
    runProperties: {},
    autoAcceptProposals: false,
  });
  try {
    const bootstraps: BrowserBootstrap[] = [];
    for (const path of ["/world-a/shared", "/world-b/shared"]) {
      const response = await fetch(
        `${portal.origin}/bootstrap.json?path=${encodeURIComponent(path)}`,
      );
      assert.equal(response.status, 200);
      bootstraps.push(await response.json() as BrowserBootstrap);
    }
    assert.notEqual(bootstraps[0]?.runtimeThreadId, bootstraps[1]?.runtimeThreadId);

    const agent = new HttpAgent({ url: `${portal.origin}/api/copilotkit/agent/default/run` });
    for (const [index, bootstrap] of bootstraps.entries()) {
      await collect(agent, {
        threadId: bootstrap.runtimeThreadId,
        runId: `run-${index}`,
        state: {},
        messages: [{ id: `prompt-${index}`, role: "user", content: "hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      });
    }
    const ordinaryRuns = upstream.inputs.filter((input) =>
      (input.forwardedProps as { plurnk?: { action?: unknown } } | undefined)?.plurnk?.action === undefined);
    assert.deepEqual(
      ordinaryRuns.map((input) => ({
        threadId: input.threadId,
        workspace: (input.forwardedProps as { plurnk: { workspace: string } }).plurnk.workspace,
      })),
      [
        { threadId: "shared", workspace: "world-a" },
        { threadId: "shared", workspace: "world-b" },
      ],
    );
  } finally {
    await portal.close();
    await close(upstream.server);
  }
});
