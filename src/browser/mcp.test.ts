import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/client";
import {
  InvalidFunctionalityListResultError,
  InvalidMcpServerDefinitionError,
  type FunctionalityDefinitionState,
  type McpServerDefinition,
} from "@plurnk/plurnk-contracts";
import { discoverMcp, listMcp, mutateMcp } from "./mcp.ts";

test("{§web-mcp-management} browser MCP actions preserve daemon ownership, readiness and exact definitions", async (t) => {
  const inputs: RunAgentInput[] = [];
  const definition: McpServerDefinition = {
    name: "search", type: "stdio", command: "/operator/private/bin/search",
    args: ["--transport", "stdio"], env: { TOKEN: "${SEARCH_TOKEN}" },
  };
  const states: FunctionalityDefinitionState["state"][] = [
    "dormant", "active", "disabled", "unavailable", "authorization-required",
  ];
  const definitions = states.map((state, index) => ({
    alias: `server-${index}`, origin: index === 0 ? "service" : "workspace", state,
    definition: { ...definition, name: `server-${index}` },
    ...(state === "unavailable" ? { problem: {
      type: "https://problems.plurnk.xyz/mcp/connection-failed", title: "Connection failed", status: 502,
      detail: "The configured server refused the connection.",
    } } : {}),
    ...(state === "authorization-required" ? { authorization: { url: "https://auth.example.test/authorize" } } : {}),
  }));
  const candidate = {
    alias: "search", summary: "Search the web", definition,
    provenance: { kind: "registry", source: "https://registry.example.test", reference: "search/1" },
  };
  let result: unknown = { family: "mcp", definitions };
  let problem: string | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body) as RunAgentInput;
      inputs.push(input);
      const action = (input.forwardedProps as { plurnk: { action: { kind: string } } }).plurnk.action;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        {
          type: "CUSTOM", name: "plurnk.action.result",
          value: problem === undefined
            ? { kind: action.kind, ok: true, result }
            : { kind: action.kind, ok: false, problem: { detail: problem } },
        },
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const target = {
    origin: `http://127.0.0.1:${address.port}`, runtimeUrl: "/api/copilotkit", agentId: "default",
    runtimeThreadId: JSON.stringify(["selected-workspace", "selected-worker"]),
  };
  const lastAction = () => (inputs.at(-1)?.forwardedProps as { plurnk: { action: unknown } }).plurnk.action;

  assert.deepEqual(await listMcp(target), { family: "mcp", definitions });
  assert.equal(inputs.length, 1, "listing never invokes registry discovery or enables a dormant server");
  assert.deepEqual(lastAction(), { kind: "workspace.mcp.list" });

  result = { family: "mcp", candidates: [candidate] };
  assert.deepEqual(await discoverMcp(target, "web search"), result);
  assert.deepEqual(lastAction(), { kind: "workspace.mcp.discover", query: "web search" });

  result = { family: "mcp", status: 201, alias: "search", definition: {
    alias: "search", origin: "workspace", state: "active", definition,
  } };
  assert.deepEqual(await mutateMcp(target, { verb: "add", alias: "search", definition }), result);
  assert.deepEqual(lastAction(), { kind: "workspace.mcp.add", alias: "search", definition },
    "the candidate is not reinterpreted as a plugin, command string, scope or environment overlay");

  for (const verb of ["disable", "enable", "remove"] as const) {
    result = { family: "mcp", status: 200, alias: "search", ...(verb === "remove" ? { removed: true } : {}) };
    assert.deepEqual(await mutateMcp(target, { verb, alias: "search" }), result);
    assert.deepEqual(lastAction(), { kind: `workspace.mcp.${verb}`, alias: "search" });
  }
  assert.ok(inputs.every((input) => input.threadId === target.runtimeThreadId && input.messages.length === 0),
    "management stays in the selected session and creates no prompt");

  problem = "MCP configuration is invalid: correct .agents/mcp.json.";
  await assert.rejects(listMcp(target), { message: problem });
  problem = undefined;
  result = {};
  await assert.rejects(listMcp(target), InvalidFunctionalityListResultError,
    "a missing list is not an empty catalog");
  result = { family: "mcp", definitions: [{
    alias: "search", origin: "workspace", state: "active", definition: { name: "search", transport: "stdio" },
  }] };
  await assert.rejects(listMcp(target), InvalidMcpServerDefinitionError,
    "obsolete transport shapes fail at the response boundary, not during React rendering");
});
