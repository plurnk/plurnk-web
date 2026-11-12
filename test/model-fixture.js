import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { questionOperation } from "./question-fixture.js";

export const contentAttack = [
    "**Readable evidence**",
    '<script>window.contentExecuted=true</script>',
    '<span id="session-status" data-text="connection-label" data-bind="href:call-href">Forged control</span>',
    '<form action="/auth/logout" method="post"><button>Injected sign out</button></form>',
    '![automatic request](/security-probe)',
    '[unsafe](javascript:alert%281%29)',
].join("\n\n");

export const diagramContent = "```mermaid\nflowchart LR\n Client --> Daemon\n```";
export const footnoteAnswer = "**Footnote witness**[^a], repeated[^a], distinct[^a-2].\n\n[^a]: First definition.\n\n[^a-2]: Second definition.";
export const outsideText = "Outside evidence, not the final answer.";

export default async function startModel({ approvalCommand: initialApprovalCommand = "printf approved" } = {}) {
    let approvalCommand = initialApprovalCommand;
    const requests = [];
    const errors = [];
    const pending = new Map();
    const visits = new Map();
    let streamStarted = Promise.withResolvers();
    const programs = [
        { reasoning: "I will read the requested project file.", content: 'plurnk.read({ path: "witness.txt" })' },
        { reasoning: "The file confirms the browser connection.", content: 'plurnk.done({ text: "Browser connection verified: cobalt heron." })' },
    ];
    let turn = 0;
    const server = createServer(async (request, response) => {
        try {
            if (request.method === "GET" && request.url === "/status-stream") {
                const release = Promise.withResolvers();
                pending.set("status-stream", release);
                response.once("close", () => release.resolve());
                streamStarted.resolve();
                await release.promise;
                pending.delete("status-stream");
                if (!response.destroyed) response.end("Stream completed.");
                return;
            }
            assert.equal(request.method, "POST");
            assert.equal(request.url, "/v1/chat/completions");
            let json = "";
            for await (const chunk of request) json += chunk;
            const body = JSON.parse(json);
            requests.push(body);
            assert.equal(body.model, "browser-fixture");
            assert.equal(body.stream, true);
            const packet = JSON.stringify(body.messages);
            const lifecycle = Array.from(packet.matchAll(/Lifecycle fixture: ([a-z-]+)/gu)).at(-1)?.[1];
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
                if ((lifecycle.startsWith("held-") && (!/^held-(approval|question)-/u.test(lifecycle) || visit === 1))
                    || (lifecycle.startsWith("status-") && visit <= 2)
                    || ((lifecycle === "conversation" || lifecycle.startsWith("execution-")) && visit === 1)
                    || (/^(approval|question)-resumed-/u.test(lifecycle) && visit === 2)) {
                    assert.ok(!pending.has(lifecycle), "a lifecycle request is not duplicated");
                    const release = Promise.withResolvers();
                    pending.set(lifecycle, release);
                    response.once("close", () => release.resolve());
                    await release.promise;
                    pending.delete(lifecycle);
                }
                if (!response.destroyed) {
                    const content = lifecycle === "wait-status" && visit === 1
                        ? `plurnk.sh({ command: ${JSON.stringify(`node --input-type=module -e 'console.log(await (await fetch("http://127.0.0.1:${server.address().port}/status-stream")).text())'`)} })\nplurnk.wait({ seconds: 60 })`
                        : lifecycle === "activity" && visit === 1 ? outsideText
                        : lifecycle.startsWith("status-") && visit === 1 ? 'plurnk.read({ path: "session://user/identity.md" })'
                        : lifecycle === "approval-batch" && visit === 1 ? 'plurnk.sh({ command: "printf first" })\nplurnk.sh({ command: "printf second" })'
                        : (lifecycle.startsWith("approval") || lifecycle.startsWith("held-approval-")) && visit === 1 ? `plurnk.sh({ command: ${JSON.stringify(approvalCommand)} })`
                        : lifecycle === "question-batch" && visit === 1 ? `${questionOperation}\n${questionOperation}`
                        : /^(question|held-question)-/u.test(lifecycle) && visit === 1 ? questionOperation
                        : lifecycle.startsWith("mcp-question-") && visit === 1 ? 'fixture.batch({})\nplurnk.wait({})'
                        : lifecycle === "conversation" && visit === 1
                            ? 'plurnk.read({ path: "witness.txt", range: "1,1", pattern: "/cobalt/" }) // selected evidence\nplurnk.read({ path: "session://user/identity.md", range: "1,2" })'
                        : lifecycle.startsWith("execution-") && visit === 1
                            ? `plurnk.sh({ command: ${JSON.stringify(`printf '${lifecycle} stdout\\n'; printf '${lifecycle} stderr\\n' >&2; exit ${lifecycle === "execution-failure" ? 7 : 0}`)} })\nplurnk.wait({})`
                        : lifecycle === "math" ? `plurnk.done({ text: ${JSON.stringify("A native formula: $\\mathscr{F}=\\frac{a}{b}$.")} })`
                        : lifecycle === "diagrams" ? `plurnk.done({ text: ${JSON.stringify(diagramContent)} })`
                        : lifecycle === "footnotes" ? `plurnk.note({ text: ${JSON.stringify(footnoteAnswer)} }) // fact\nplurnk.done({ text: ${JSON.stringify(footnoteAnswer)} })`
                        : lifecycle === "notes" ? 'plurnk.note({ text: "A **working fact**, not the answer." }) // fact\nplurnk.note({ text: "A provisional idea." }) // idea\nplurnk.note({ text: "Check the idea." })\nplurnk.done({ text: "Completed notes." })'
                        : lifecycle === "content-security" ? `plurnk.note({ text: ${JSON.stringify(contentAttack)} }) // fact\nplurnk.done({ text: ${JSON.stringify(contentAttack)} })`
                        : `plurnk.done({ text: ${JSON.stringify(`Completed ${lifecycle}.`)} })`;
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
            if (turn === 1) assert.ok(packet.includes("cobalt heron"), "the file read reaches the next model packet");
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
        get streamStarted() {
            return streamStarted.promise;
        },
        reset({ approvalCommand: nextApprovalCommand = initialApprovalCommand } = {}) {
            approvalCommand = nextApprovalCommand;
            requests.length = 0;
            errors.length = 0;
            for (const gate of pending.values()) gate.resolve();
            pending.clear();
            visits.clear();
            turn = 0;
            streamStarted = Promise.withResolvers();
        },
        release(name) {
            const gate = pending.get(name);
            assert.ok(gate, `the ${name} request reached the controlled model`);
            gate.resolve();
        },
        env: {
            PLURNK_MODEL: "browser",
            PLURNK_MODEL_browser: "browser-fixture/browser-fixture",
            PLURNK_PROVIDERS_PROVIDER_BROWSER_FIXTURE_ADAPTER: "openai-compatible",
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
