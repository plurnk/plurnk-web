import assert from "node:assert/strict";

// {§web-acp-conformance} No Plurnk selector, action, capability or response interpretation.
export default async function verifyOrdinary(tab, token, model, t) {
    await t.test("{§web-acp-conformance} stock browser agents create, continue and replay isolated conversations", async () => {
        const before = model.requests.length;
        const inputs = [];
        const capture = (request) => {
            if (new URL(request.url()).pathname === "/acp") inputs.push(request.postDataJSON());
        };
        tab.on("request", capture);
        try {
            const result = await tab.evaluate(async (token) => {
                const { HttpAgent } = await import("/__test__/http-agent.js");
                const options = { url: new URL("/acp", location.href).href, headers: { Authorization: `Bearer ${token}` } };
                const run = async (agent, prompt) => {
                    if (prompt) agent.addMessage({ id: crypto.randomUUID(), role: "user", content: `Lifecycle fixture: ${prompt}.` });
                    const events = [];
                    await agent.runAgent({}, { onEvent: ({ event }) => { events.push(event); } });
                    return { messages: structuredClone(agent.messages), events, threadId: agent.threadId, running: agent.isRunning };
                };
                const agent = new HttpAgent(options);
                const first = await run(agent, "ordinary-first");
                const unchanged = await run(agent);
                const next = await run(agent, "ordinary-next");
                const fresh = await run(new HttpAgent({ ...options, threadId: agent.threadId }));
                const independent = await run(new HttpAgent(options), "ordinary-independent");
                return { first, unchanged, next, fresh, independent };
            }, token);
            for (const run of Object.values(result)) {
                assert.equal(run.events.at(-1).type, "RUN_FINISHED");
                assert.deepEqual(run.events.at(-1).outcome, { type: "success" });
                assert.equal(run.running, false);
            }
            assert.equal(result.first.messages.findLast(({ role }) => role === "assistant").content, "Completed ordinary-first.");
            assert.deepEqual(result.unchanged.messages, result.first.messages, "retained history is not a new prompt");
            assert.equal(result.next.messages.findLast(({ role }) => role === "assistant").content, "Completed ordinary-next.");
            assert.deepEqual(result.fresh.messages, result.next.messages, "a fresh browser agent needs only the thread ID to reconstruct the conversation");
            assert.equal(result.next.messages.filter(({ role }) => role === "user").length, 2);
            assert.notEqual(result.independent.threadId, result.first.threadId);
            assert.deepEqual(result.independent.messages.filter(({ role }) => role === "user").map(({ content }) => content),
                ["Lifecycle fixture: ordinary-independent."]);
            assert.equal(result.independent.messages.findLast(({ role }) => role === "assistant").content, "Completed ordinary-independent.");
            assert.equal(model.requests.length, before + 3, "synchronization and reconstruction add no inference");
            assert.equal(inputs.length, 5);
            for (const input of inputs) {
                assert.equal(input.forwardedProps?.plurnk, undefined);
                assert.deepEqual(input.tools, []);
            }
        } finally {
            tab.off("request", capture);
        }
    });
}
