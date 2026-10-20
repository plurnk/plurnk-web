import assert from "node:assert/strict";
import aguiSession from "./agui-session.js";

// {§web-agui-conformance} Close real submitting transports; the daemon still owns admitted work.
export default async function verifyDisconnect({ tab, t, model, base, mount, token, projectRoot, action, observe, read, finish, detach, successful, prompt, inspect }) {
    for (const departure of ["abort", "navigate", "close"]) {
        await t.test(`{§web-agui-conformance} submitting ${departure} preserves admitted work and authoritative replay`, async () => {
            const workspace = `disconnect-${departure}`;
            const name = `held-${workspace}`;
            await action(workspace, "user", "worker.model.set", { selector: "browser" });
            const before = model.requests.length;
            await observe(`${name}-observer`, workspace, "user");
            const sender = await tab.context().newPage();
            try {
                await mount(sender, base);
                await sender.goto(base);
                const submitter = await aguiSession(sender, { token, projectRoot });
                await submitter.start(name, { workspace, threadId: "user", messages: prompt(name) });
                await submitter.event(name, "REASONING_MESSAGE_CONTENT");
                if (departure === "abort") {
                    await sender.evaluate((id) => globalThis.lifecycle.abort(id), name);
                    const detached = await submitter.finish(name);
                    assert.equal(detached.failure, null);
                    const errors = detached.events.filter(({ type }) => type === "RUN_ERROR");
                    assert.deepEqual(errors.map(({ code }) => code), ["abort"], "HttpAgent reports its local fetch abortion");
                    assert.equal(detached.events.some(({ type, metadata }) => type === "RUN_FINISHED" || metadata?.plurnk?.terminal !== undefined), false,
                        "the SDK's abort error is not a daemon worker outcome");
                } else if (departure === "navigate") {
                    await sender.goto(new URL("/index.html", base).href);
                    assert.equal(await sender.evaluate(() => typeof globalThis.lifecycle), "undefined",
                        "native navigation destroyed the submitting document");
                } else {
                    await sender.close();
                }

                assert.equal((await read(`${name}-observer`)).settled, false);
                const late = await observe(`${name}-late`, workspace, "user");
                assert.equal(late.settled, false);
                assert.equal(late.state.plurnk.status.lifecycle, "running");
                assert.deepEqual(late.messages.filter(({ role }) => role === "user").map(({ id, role, content }) => ({ id, role, content })), prompt(name));
                model.release(name);
                const completed = await Promise.all([finish(`${name}-observer`), finish(`${name}-late`)]);
                const replay = await observe(`${name}-replay`, workspace, "user");
                await detach(`${name}-replay`);
                for (const result of completed) {
                    successful(result);
                    assert.equal(result.events.at(-1).result.status, 200);
                    assert.equal(result.events.at(-1).usage[0].inputTokens, 400);
                    assert.deepEqual(result.messages, replay.messages);
                    assert.equal(result.messages.findLast(({ role }) => role === "assistant").content, `Completed ${name}.`);
                    assert.equal(new Set(result.messages.map(({ id }) => id)).size, result.messages.length);
                }
                assert.equal(replay.state.plurnk.status.lifecycle, "completed");
                assert.equal(model.requests.length, before + 1, "departure and reattachment add no admission or inference");
            } finally {
                if (!sender.isClosed()) await sender.close();
            }
        });
    }

    await t.test("{§web-agui-conformance} closing the submitting page leaves its approval pending and discoverable", async () => {
        const workspace = "approval-disconnect";
        await action(workspace, "user", "worker.model.set", { selector: "browser" });
        const before = model.requests.length;
        const sender = await tab.context().newPage();
        try {
            await mount(sender, base);
            await sender.goto(base);
            const submitter = await aguiSession(sender, { token, projectRoot });
            await submitter.start(workspace, { workspace, threadId: "user", messages: prompt(workspace) });
            const paused = await submitter.finish(workspace);
            assert.equal(paused.failure, null);
            assert.equal(paused.events.at(-1).outcome.type, "interrupt");
            assert.equal(paused.interrupts.length, 1);
            const original = paused.interrupts[0];
            await sender.close();

            await observe(workspace, workspace, "user");
            const rediscovered = await finish(workspace);
            assert.equal(rediscovered.failure, null);
            assert.equal(rediscovered.events.at(-1).outcome.type, "interrupt");
            assert.equal(rediscovered.interrupts.length, 1);
            const current = rediscovered.interrupts[0];
            assert.notEqual(current.id, original.id);
            assert.equal(current.toolCallId, original.toolCallId);
            assert.deepEqual(rediscovered.messages, paused.messages);
            assert.equal(rediscovered.messages.some(({ role, toolCallId }) => role === "tool" && toolCallId === current.toolCallId), false);
            assert.equal(model.requests.length, before + 1, "closing and rediscovering neither answers the gate nor restarts inference");

            await tab.evaluate(({ id, interruptId }) => globalThis.lifecycle.resume(id, [
                { interruptId, status: "resolved", payload: { decision: "accept" } },
            ]), { id: workspace, interruptId: current.id });
            const completed = await finish(workspace);
            successful(completed);
            assert.deepEqual(completed.interrupts, []);
            const receipts = completed.events.filter(({ type, toolCallId }) => type === "TOOL_CALL_RESULT" && toolCallId === current.toolCallId);
            assert.equal(receipts.length, 1);
            const { status, content, exitCode, terminal } = await inspect(receipts[0].content);
            assert.deepEqual({ status, content, exitCode, terminal }, { status: 200, content: "approved", exitCode: 0, terminal: true });
            assert.equal(completed.messages.findLast(({ role }) => role === "assistant").content, `Completed ${workspace}.`);
            assert.equal(model.requests.length, before + 2);
        } finally {
            if (!sender.isClosed()) await sender.close();
        }
    });
}
