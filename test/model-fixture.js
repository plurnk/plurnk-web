import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export default async function startModel() {
    const requests = [];
    const errors = [];
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
