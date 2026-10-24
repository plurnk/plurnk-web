import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

// A deterministic MCP peer, not an ACP mock. The installed daemon owns its adapter and continuation.
export default async function startMcp() {
    const answers = [];
    const errors = [];
    const server = createServer(async (request, response) => {
        try {
            assert.equal(request.method, "POST");
            let body = "";
            for await (const chunk of request) body += chunk;
            const { id, method, params } = JSON.parse(body);
            let result;
            if (method === "server/discover") result = {
                supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private",
            };
            else if (method === "tools/list") result = { tools: [{
                name: "batch", description: "Request several independent answers.",
                inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true },
            }], ttlMs: 0, cacheScope: "private" };
            else if (method === "tools/call") {
                assert.equal(params.name, "batch");
                if (params.requestState === undefined) result = {
                    resultType: "input_required", requestState: "private-continuation",
                    inputRequests: {
                        profile: { method: "elicitation/create", params: { mode: "form", message: "Name the operator.", requestedSchema: {
                            type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false,
                        } } },
                        approval: { method: "elicitation/create", params: { mode: "form", message: "Continue?", requestedSchema: {
                            type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"],
                        } } },
                        authorize: { method: "elicitation/create", params: {
                            mode: "url", message: "Open the authorization page only if you choose to.",
                            elicitationId: "browser-fixture", url: "https://authorization.invalid/authorize",
                        } },
                    },
                };
                else {
                    assert.equal(params.requestState, "private-continuation");
                    answers.push(params.inputResponses);
                    result = { content: [{ type: "text", text: JSON.stringify({ witness: "MCP answer received", answers: params.inputResponses }) }] };
                }
            } else throw new Error(`Unexpected MCP method: ${method}`);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } }));
        } catch (error) {
            errors.push(error);
            response.writeHead(500, { "content-type": "text/plain" });
            response.end(String(error));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        answers, errors,
        env: { PLURNK_MCP_fixture: JSON.stringify({ name: "fixture", type: "streamable-http", url: `http://127.0.0.1:${server.address().port}/mcp` }) },
        async close() {
            const closed = once(server, "close");
            server.close();
            server.closeAllConnections();
            await closed;
        },
    };
}
