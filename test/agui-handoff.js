import assert from "node:assert/strict";

// {§web-agui-conformance} The same official SDK history crosses each transport boundary.
export default async function verifyHandoff({ tab, t, model, start, finish, read, event, successful, prompt, action, detach, observe }) {
    await t.test("{§web-agui-conformance} one SDK history moves from observation to a message Run and back without replaying input", async () => {
        const before = model.requests.length;
        const initial = await observe("handoff", "browser-conformance", "browser-conformance");
        const readCall = initial.messages.flatMap(({ toolCalls }) => toolCalls ?? []).find(({ function: fn }) => fn.name === "READ");
        assert.ok(readCall);
        assert.ok(initial.messages.some(({ role, toolCallId }) => role === "tool" && toolCallId === readCall.id));
        await detach("handoff");
        await tab.evaluate((messages) => globalThis.lifecycle.send("handoff", messages), prompt("handoff"));
        const completed = await finish("handoff");
        successful(completed);
        assert.deepEqual(completed.messages.slice(0, initial.messages.length), initial.messages);
        assert.equal(completed.messages.filter(({ id }) => id === "message-handoff").length, 1);
        assert.equal(completed.messages.findLast(({ role }) => role === "assistant").content, "Completed handoff.");
        assert.equal(model.requests.length, before + 1, "only the fresh prompt causes inference");

        await tab.evaluate(() => globalThis.lifecycle.reconnect("handoff"));
        await event("handoff", "MESSAGES_SNAPSHOT");
        const observed = await read("handoff");
        assert.equal(observed.settled, false);
        assert.deepEqual(observed.messages, completed.messages, "the authoritative replay agrees with the controlling Run");
        assert.equal(model.requests.length, before + 1);

        await start("handoff-other", { workspace: "browser-conformance", messages: prompt("held-handoff") });
        await event("handoff-other", "REASONING_MESSAGE_CONTENT");
        await event("handoff", "REASONING_MESSAGE_CONTENT");
        await detach("handoff");
        assert.equal((await read("handoff-other")).settled, false, "the former controller is now only an observer");
        model.release("held-handoff");
        successful(await finish("handoff-other"));
        assert.equal(model.requests.length, before + 2);
    });

    await t.test("{§web-agui-conformance} observation rediscovers a controlling Run's approval without resolving or duplicating it", async () => {
        const workspace = "handoff-approval";
        await action(workspace, "review", "worker.model.set", { selector: "browser" });
        const before = model.requests.length;
        await observe("handoff-review", workspace, "review");
        await detach("handoff-review");
        await tab.evaluate((messages) => globalThis.lifecycle.send("handoff-review", messages), prompt("approval-handoff"));
        const paused = await finish("handoff-review");
        assert.equal(paused.failure, null);
        assert.equal(paused.events.at(-1).outcome.type, "interrupt");
        assert.equal(paused.interrupts.length, 1);
        const original = paused.interrupts[0];
        assert.ok(original.metadata.plurnk.proposal);
        assert.equal(paused.messages.some(({ role, toolCallId }) => role === "tool" && toolCallId === original.toolCallId), false);

        await tab.evaluate(() => globalThis.lifecycle.reconnect("handoff-review"));
        const rediscovered = await finish("handoff-review");
        assert.equal(rediscovered.failure, null);
        assert.equal(rediscovered.events.at(-1).outcome.type, "interrupt");
        assert.equal(rediscovered.interrupts.length, 1);
        const current = rediscovered.interrupts[0];
        assert.notEqual(current.id, original.id, "each presentation has its own continuation, not the original Run's lifetime");
        assert.equal(current.toolCallId, original.toolCallId);
        assert.deepEqual(rediscovered.messages, paused.messages);
        assert.equal(model.requests.length, before + 1, "observation neither answers the gate nor restarts inference");

        await tab.evaluate((interruptId) => globalThis.lifecycle.resume("handoff-review", [
            { interruptId, status: "resolved", payload: { decision: "accept" } },
        ]), current.id);
        const completed = await finish("handoff-review");
        successful(completed);
        assert.deepEqual(completed.interrupts, []);
        const receipts = completed.events.filter(({ type, toolCallId }) => type === "TOOL_CALL_RESULT" && toolCallId === current.toolCallId);
        assert.equal(receipts.length, 1);
        assert.equal(JSON.parse(receipts[0].content).content, "approved");
        assert.equal(completed.messages.findLast(({ role }) => role === "assistant").content, "Completed approval-handoff.");
        assert.equal(model.requests.length, before + 2);

        await tab.evaluate(() => globalThis.lifecycle.reconnect("handoff-review"));
        await event("handoff-review", "MESSAGES_SNAPSHOT");
        const observed = await read("handoff-review");
        assert.equal(observed.settled, false);
        assert.deepEqual(observed.messages, completed.messages);
        assert.deepEqual(observed.interrupts, []);
        assert.equal(model.requests.length, before + 2);
        await detach("handoff-review");
    });
}
