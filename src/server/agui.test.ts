import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/client";
import { createBrowserWorkspace, resolveBrowserCatalog } from "./agui.ts";

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

const actionServer = async (): Promise<{
  server: Server;
  url: URL;
  inputs: RunAgentInput[];
  authorization(): string | undefined;
}> => {
  const inputs: RunAgentInput[] = [];
  let authorization: string | undefined;
  const { server, url } = await listen((request, response) => {
    authorization = request.headers.authorization;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body) as RunAgentInput;
      inputs.push(input);
      const action = (input.forwardedProps as {
        plurnk: { action: { kind: string; name?: string } };
      }).plurnk.action;
      const result = action.kind === "workspace.create"
        ? { id: 7, name: action.name ?? "minted", workerId: 9 }
        : action.kind === "workspace.list"
          ? { workspaces: [{ id: 7, name: "research", project_root: "/workspace", created_at: "now" }] }
          : action.kind === "workspace.workers"
            ? { workers: [{ id: 12, name: input.threadId, created_at: "now", origin: "client", parentWorkerId: null }] }
            : {};
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId })}\n\n`);
      response.write(`data: ${JSON.stringify({
        type: "CUSTOM",
        name: "plurnk.action.result",
        value: { kind: action.kind, ok: true, result },
      })}\n\n`);
      response.end(`data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } })}\n\n`);
    });
  });
  return { server, url, inputs, authorization: () => authorization };
};

test("an anonymous browser workspace is minted through the public AG-UI action", async () => {
  const target = await actionServer();
  try {
    const name = await createBrowserWorkspace({
      upstream: target.url,
      token: "server-secret",
      workspaceProperties: { projectRoot: "/workspace", settings: { filesItems: 4 } },
    });
    assert.equal(name, "minted");
    assert.equal(target.authorization(), "Bearer server-secret");
    assert.deepEqual(
      (target.inputs[0]?.forwardedProps as { plurnk: unknown }).plurnk,
      {
        action: {
          kind: "workspace.create",
          projectRoot: "/workspace",
          settings: { filesItems: 4 },
        },
      },
    );
  } finally {
    await close(target.server);
  }
});

test("browser catalog hydration creates the exact world, binds its Worker, and then prepares it", async () => {
  const target = await actionServer();
  const prepared: Array<{ workspace: string; threadId: string }> = [];
  try {
    const catalog = await resolveBrowserCatalog({
      upstream: target.url,
      token: "server-secret",
      workspaceProperties: { projectRoot: "/workspace", settings: { filesItems: 4 } },
      prepareSession: async (session) => { prepared.push(session); },
    }, { workspace: "research", threadId: "analyst" });

    assert.deepEqual(catalog, {
      workspaces: ["research"],
      workers: ["analyst"],
      workerRows: [{ id: 12, name: "analyst", origin: "client", parentWorkerId: null, createdAt: "now" }],
    });
    assert.deepEqual(prepared, [{ workspace: "research", threadId: "analyst" }]);
    assert.deepEqual(
      target.inputs.map((input) => ({
        threadId: input.threadId,
        plurnk: (input.forwardedProps as { plurnk: unknown }).plurnk,
      })),
      [
        {
          threadId: target.inputs[0]?.threadId,
          plurnk: {
            action: {
              kind: "workspace.create",
              name: "research",
              projectRoot: "/workspace",
              settings: { filesItems: 4 },
            },
          },
        },
        {
          threadId: "analyst",
          plurnk: {
            workspace: "research",
            projectRoot: "/workspace",
            settings: { filesItems: 4 },
            action: { kind: "workspace.workers" },
          },
        },
        {
          threadId: target.inputs[2]?.threadId,
          plurnk: { action: { kind: "workspace.list" } },
        },
      ],
    );
  } finally {
    await close(target.server);
  }
});
