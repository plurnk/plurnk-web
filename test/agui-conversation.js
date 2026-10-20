import assert from "node:assert/strict";

// {§web-agui-conformance} The SDK's messages, not CUSTOM rows, are the conversation.
export default async function verifyConversation({ t, tab, start, finish, read, event, successful, prompt, model, action, observe, detach, inspect }) {
    await t.test("{§web-agui-conformance} pre-attached, submitting, late and refreshed browsers receive the same conversation", async (probe) => {
        probe.after(() => tab.evaluate(() => globalThis.lifecycle.close()));
        const workspace = "conversation-workspace";
        const worker = "user";
        await action(workspace, worker, "worker.model.set", { selector: "browser" });
        await action("conversation-elsewhere", worker, "worker.model.set", { selector: "browser" });
        const before = model.requests.length;
        await observe("conversation-live", workspace, worker);
        await observe("conversation-foreign", "conversation-elsewhere", worker);
        const messages = prompt("conversation");
        await start("conversation-submitter", { workspace, threadId: worker, messages });
        await event("conversation-submitter", "REASONING_MESSAGE_CONTENT");
        await event("conversation-live", "REASONING_MESSAGE_CONTENT");
        const late = await observe("conversation-late", workspace, worker);

        for (const result of [await read("conversation-live"), await read("conversation-submitter"), late]) {
            assert.deepEqual(result.messages.filter(({ role }) => role === "user").map(({ id, role, content }) => ({ id, role, content })), messages,
                "the arriving prompt is present once, with its exact identity and text, before inference completes");
        }
        assert.deepEqual((await read("conversation-foreign")).messages, [], "another workspace's same-named worker receives nothing");
        await detach("conversation-foreign");
        model.release("conversation");
        const completed = await Promise.all(["conversation-live", "conversation-submitter", "conversation-late"].map(finish));
        for (const result of completed) successful(result);
        const fresh = await observe("conversation-fresh", workspace, worker);
        await detach("conversation-fresh");

        for (const result of [...completed, fresh]) {
            const { messages: conversation } = result;
            assert.deepEqual(conversation.filter(({ role }) => role === "user").map(({ id, role, content }) => ({ id, role, content })), messages);
            const arrival = conversation.find(({ role }) => role === "user").metadata.plurnk;
            assert.equal(arrival.op, "SEND");
            assert.equal(arrival.source, "agui://operator/threads/user/messages/message-conversation");
            assert.ok(Number.isSafeInteger(arrival.id));
            assert.equal(new Set(conversation.map(({ id }) => id)).size, conversation.length, "message identities do not duplicate");
            assert.deepEqual(conversation.filter(({ role }) => role === "reasoning").map(({ content }) => content),
                ["Considering conversation.", "Considering conversation."], "both accepted reasoning turns survive");
            assert.equal(conversation.findLast(({ role }) => role === "assistant")?.content, "Completed conversation.");
            const calls = conversation.flatMap(({ toolCalls }) => toolCalls ?? []);
            assert.deepEqual(calls.map(({ function: fn }) => fn.name), ["READ", "READ"]);
            const [local, hosted] = calls.map(({ function: fn }) => JSON.parse(fn.arguments));
            assert.equal(local.target.raw, "witness.txt");
            assert.deepEqual(local.lineMarker.marks, [1, 1]);
            assert.deepEqual(local.matcher, { dialect: "regex", raw: "/cobalt/", pattern: "cobalt", flags: "" });
            assert.equal(local.aside, "selected evidence");
            assert.equal(hosted.target.raw, "worker://user/identity.md");
            assert.equal(hosted.target.hostname, "user", "a host is part of the requested address");
            assert.deepEqual(hosted.lineMarker.marks, [1, 2]);
            const receipts = await Promise.all(calls.map(({ id }) => {
                const matching = conversation.filter(({ role, toolCallId }) => role === "tool" && toolCallId === id);
                assert.equal(matching.length, 1, "each attempted operation has exactly one correlated receipt");
                return inspect(matching[0].content);
            }));
            assert.equal(receipts[0].status, 200);
            assert.equal(receipts[0].content, "cobalt heron");
            assert.equal(receipts[1].status, 404);
            assert.match(receipts[1].problem.type, /\/entry-not-found$/u);
            assert.equal(receipts[1].problem.target, "worker://user/identity.md");
            assert.deepEqual(conversation, fresh.messages, "live and replay preserve order, identities, arguments and results");
        }

        await tab.evaluate(() => globalThis.lifecycle.reconnect("conversation-live"));
        await event("conversation-live", "MESSAGES_SNAPSHOT");
        assert.deepEqual((await read("conversation-live")).messages, fresh.messages,
            "reattaching an SDK instance replaces history without duplicating or reordering it");
        await detach("conversation-live");
        assert.equal(model.requests.length, before + 2, "observation and refresh neither submit prompts nor run inference");
    });
}
