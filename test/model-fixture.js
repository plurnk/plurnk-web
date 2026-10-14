import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export default async function startModel() {
    const requests = [];
    const errors = [];
    const pending = new Map();
    const visits = new Map();
    const programs = [
        { reasoning: "I will read the requested project file.", content: "```READ (witness.txt)\n```" },
        { reasoning: "The file confirms the browser connection.", content: "```SEND [200]\nBrowser connection verified: cobalt heron.\n```" },
    ];
    let turn = 0;
    const server = createServer(async (request, response) => {
        try {
            assert.equal(request.method, "POST");
            assert.equal(request.url, "/v1/chat/completions");
            let json = "";
            for await (const chunk of request) json += chunk;
            const body = JSON.parse(json);
            requests.push(body);
            assert.equal(body.model, "browser-fixture");
            assert.equal(body.stream, true);
            const packet = JSON.stringify(body.messages);
            const lifecycle = /Lifecycle fixture: ([a-z-]+)/u.exec(packet)?.[1];
            if (lifecycle) {
                const visit = (visits.get(lifecycle) ?? 0) + 1;
                visits.set(lifecycle, visit);
                response.writeHead(200, { "content-type": "text/event-stream" });
                const frame = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
                    id: `${lifecycle}-${visit}`, object: "chat.completion.chunk", created: visit, model: body.model,
                    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
                })}\n\n`);
                const reasoning = `Considering ${lifecycle}.`;
                frame({ reasoning_content: reasoning });
                if (lifecycle.startsWith("held-")) {
                    assert.ok(!pending.has(lifecycle), "a lifecycle request is not duplicated");
                    const release = Promise.withResolvers();
                    pending.set(lifecycle, release);
                    response.once("close", () => release.resolve());
                    await release.promise;
                    pending.delete(lifecycle);
                }
                if (!response.destroyed) {
                    const content = lifecycle === "approval" && visit === 1 ? "```sh\nprintf approved\n```"
                        : `\`\`\`SEND [200]\nCompleted ${lifecycle}.\n\`\`\``;
                    frame({ content });
                    const completion_tokens = Math.ceil((reasoning.length + content.length) / 4);
                    frame({}, "stop", { prompt_tokens: 400, completion_tokens, total_tokens: 400 + completion_tokens });
                    response.end("data: [DONE]\n\n");
                }
                return;
            }
            if (packet.includes("Exercise the rejected browser request.")) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "Browser fixture deliberately refused this request." } }));
                return;
            }
            assert.ok(packet.includes("Read witness.txt and report its contents."));
            assert.ok(turn < programs.length, "no unexpected inference after completion");
            if (turn === 1) assert.ok(packet.includes("cobalt heron"), "the file READ reaches the next model packet");
            const program = programs[turn++];
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
                id: `browser-${turn}`, object: "chat.completion.chunk", created: turn, model: body.model,
                choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
            })}\n\n`);
            frame({ reasoning_content: program.reasoning });
            frame({ content: program.content });
            frame({}, "stop", { prompt_tokens: 400, completion_tokens: 80, total_tokens: 480 });
            response.end("data: [DONE]\n\n");
        } catch (error) {
            errors.push(error);
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: String(error) } }));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    return {
        requests,
        errors,
        release(name) {
            const gate = pending.get(name);
            assert.ok(gate, `the ${name} request reached the controlled model`);
            gate.resolve();
        },
        env: {
            PLURNK_MODEL: "browser",
            PLURNK_MODEL_browser: "browser-fixture/browser-fixture",
            PLURNK_PROVIDERS_PROVIDER_BROWSER_FIXTURE_NPM: "@ai-sdk/openai-compatible",
            PLURNK_PROVIDERS_PROVIDER_BROWSER_FIXTURE_BASE_URL: `http://127.0.0.1:${port}/v1`,
            PLURNK_PROVIDERS_CONTEXT_WINDOW_browser: "32768",
            PLURNK_PROVIDERS_OUTPUT_BUDGET_browser: "4096",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS_browser: "0",
            PLURNK_PROVIDERS_FETCH_TIMEOUT_browser: "5000",
            PLURNK_PROVIDERS_OPERATION_TIMEOUT_browser: "15000",
        },
        async close() {
            const closed = once(server, "close");
            server.close();
            server.closeAllConnections();
            await closed;
        },
    };
}
