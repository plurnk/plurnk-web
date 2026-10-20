import assert from "node:assert/strict";
import verifyObserver from "./agui-observer.js";
import aguiSession from "./agui-session.js";
import verifyHandoff from "./agui-handoff.js";
import verifyDisconnect from "./agui-disconnect.js";

// {§web-agui-conformance} The fixture uses only the official SDK and the daemon's public wire.
export default async function verifyLifecycle(tab, { token, projectRoot, model, t, stop, checkBrowser, mount, base }) {
    const session = await aguiSession(tab, { token, projectRoot });
    const { start, finish, read, event, successful, prompt, action, inspect } = session;
    try {
        await t.test("{§web-agui-conformance} synchronization is authoritative and inference-free", async () => {
            const before = model.requests.length;
            await start("sync", { workspace: "browser-conformance" });
            const result = await finish("sync");
            successful(result);
            const snapshot = result.events.find(({ type }) => type === "MESSAGES_SNAPSHOT");
            assert.ok(snapshot);
            assert.deepEqual(result.messages, snapshot.messages);
            assert.equal(result.messages.findLast(({ role }) => role === "assistant").content, "Browser connection verified: cobalt heron.");
            assert.equal(result.messages.filter(({ role }) => role === "reasoning").length, 2);
            assert.equal(model.requests.length, before);
            assert.equal(result.state.plurnk.status.packetCount, 2);
        });
        await t.test("{§web-agui-conformance} a fresh replay retains the native operation and its result", async () => {
            const result = await read("sync");
            const readCall = result.messages.flatMap(({ toolCalls }) => toolCalls ?? []).find(({ function: fn }) => fn.name === "READ");
            assert.ok(readCall, "a refresh must not discard the READ that the connected client received");
            const receipt = result.messages.find(({ role, toolCallId }) => role === "tool" && toolCallId === readCall.id);
            assert.ok(receipt, "replay retains the correlated operation result");
            assert.match((await inspect(receipt.content)).content, /cobalt heron/u);
        });
        await t.test("{§web-agui-conformance} a repeated thread name in another workspace has no borrowed history", async () => {
            const before = model.requests.length;
            await start("other-create", { workspace: "other-workspace", threadId: "browser-conformance", action: { kind: "worker.model.set", selector: "browser" } });
            const created = await finish("other-create");
            successful(created);
            assert.equal(created.events.at(-1).result.ok, true);
            await start("other", { workspace: "other-workspace", threadId: "browser-conformance" });
            const result = await finish("other");
            successful(result);
            assert.deepEqual(result.messages, []);
            assert.equal(result.state.plurnk.workspace.name, "other-workspace");
            assert.equal(result.state.plurnk.status.loopId, null);
            assert.equal(model.requests.length, before);
        });
        await t.test("{§web-agui-conformance} idle observation remains open without inference and can reconnect", async () => {
            const before = model.requests.length;
            for (const id of ["idle-a", "idle-b"]) {
                await start(id, { workspace: "browser-conformance", observe: true });
                await event(id, "MESSAGES_SNAPSHOT");
                const result = await read(id);
                assert.equal(result.settled, false);
                assert.equal(result.running, true);
                assert.equal(result.messages.findLast(({ role }) => role === "assistant").content, "Browser connection verified: cobalt heron.");
                await tab.evaluate((id) => globalThis.lifecycle.detach(id), id);
                const ended = await finish(id);
                assert.equal(ended.failure, null);
                assert.equal(ended.running, false);
                assert.equal(ended.events.some(({ type }) => type === "RUN_ERROR"), false);
            }
            assert.equal(model.requests.length, before);
        });
        await t.test("{§web-agui-conformance} detaching one observer does not cancel another client's running work", async () => {
            await start("controller", { workspace: "observe-live", messages: prompt("held-observe") });
            await event("controller", "REASONING_MESSAGE_CONTENT");
            await start("observer-a", { workspace: "observe-live", observe: true });
            await event("observer-a", "MESSAGES_SNAPSHOT");
            await tab.evaluate(() => globalThis.lifecycle.detach("observer-a"));
            assert.equal((await finish("observer-a")).failure, null);
            assert.equal((await read("controller")).settled, false);
            await start("observer-b", { workspace: "observe-live", observe: true });
            await event("observer-b", "MESSAGES_SNAPSHOT");
            model.release("held-observe");
            const [controller, observer] = await Promise.all([finish("controller"), finish("observer-b")]);
            successful(controller);
            successful(observer);
            assert.equal(observer.messages.findLast(({ role }) => role === "assistant").content, "Completed held-observe.");
        });
        await verifyDisconnect({ ...session, t, model, token, projectRoot, mount, base });
        checkBrowser();
        await t.test("{§web-agui-conformance} explicit cancellation reaches the submitter and observer as a worker outcome", async () => {
            await start("cancel-controller", { workspace: "cancel-live", messages: prompt("held-cancel") });
            await event("cancel-controller", "REASONING_MESSAGE_CONTENT");
            await start("cancel-observer", { workspace: "cancel-live", observe: true });
            await event("cancel-observer", "MESSAGES_SNAPSHOT");
            await start("cancel-unrelated", { workspace: "cancel-other", messages: prompt("held-cancel-unrelated") });
            await event("cancel-unrelated", "REASONING_MESSAGE_CONTENT");
            assert.deepEqual(await action("cancel-live", "cancel-live", "loop.cancel", { reason: "browser-stop" }), { cancelled: true });
            const controller = await finish("cancel-controller");
            const result = await finish("cancel-observer");
            assert.equal(controller.failure, null);
            assert.equal(controller.events.at(-1).type, "RUN_FINISHED");
            assert.deepEqual(controller.events.at(-1).outcome, { type: "cancelled" });
            assert.deepEqual(controller.events.at(-1).metadata.plurnk.terminal, result.events.at(-1).metadata.plurnk.terminal);
            assert.equal(result.failure, null);
            assert.equal(result.events.at(-1).type, "RUN_FINISHED");
            assert.deepEqual(result.events.at(-1).outcome, { type: "cancelled" });
            assert.equal(result.events.some(({ type }) => type === "RUN_ERROR"), false);
            assert.equal(Object.hasOwn(result.events.at(-1), "usage"), false,
                "an interrupted request with no provider usage does not report zero tokens");
            const terminal = result.events.at(-1).metadata.plurnk.terminal;
            assert.equal(terminal?.result.status, 499);
            assert.equal(terminal?.result.problem.reason, "browser-stop");
            assert.equal(result.running, false);
            assert.equal((await read("cancel-unrelated")).settled, false, "explicit Stop targets its worker, not another active loop");
            model.release("held-cancel-unrelated");
            successful(await finish("cancel-unrelated"));
        });
        await t.test("{§web-agui-conformance} native approval interrupts and resumes once through the official SDK", async () => {
            const before = model.requests.length;
            await start("approval", { workspace: "approval-live", messages: prompt("approval") });
            const paused = await finish("approval");
            assert.equal(paused.failure, null);
            assert.equal(paused.events.at(-1).outcome?.type, "interrupt", JSON.stringify({
                events: paused.events.filter(({ name, type }) => type === "RUN_ERROR" || name === "plurnk.notice" || type === "TOOL_CALL_START"),
            }));
            assert.equal(paused.running, false);
            assert.equal(paused.interrupts.length, 1);
            const interrupt = paused.interrupts[0];
            assert.ok(interrupt.id);
            const call = paused.messages.flatMap(({ toolCalls }) => toolCalls ?? []).find(({ id }) => id === interrupt.toolCallId);
            assert.equal(call?.function.name, "sh", "the interrupt belongs to the gated operation, not a fabricated approval tool");
            assert.equal(JSON.parse(call.function.arguments).body, "printf approved");
            assert.ok(interrupt.metadata.plurnk.proposal);
            assert.equal(paused.messages.some(({ role, toolCallId }) => role === "tool" && toolCallId === interrupt.toolCallId), false,
                "a pending approval has no invented execution result");
            const resume = [{ interruptId: interrupt.id, status: "resolved", payload: { decision: "accept" } }];
            await start("wrong-owner", { workspace: "approval-live", threadId: "observer", resume });
            const refused = await finish("wrong-owner");
            assert.equal(refused.events.at(-1).type, "RUN_ERROR");
            await tab.evaluate(({ resume }) => globalThis.lifecycle.resume("approval", resume), { resume });
            const completed = await finish("approval");
            successful(completed);
            assert.deepEqual(completed.interrupts, []);
            assert.equal(completed.messages.findLast(({ role }) => role === "assistant").content, "Completed approval.");
            const receipts = completed.events.filter(({ type, toolCallId }) => type === "TOOL_CALL_RESULT" && toolCallId === interrupt.toolCallId);
            assert.equal(receipts.length, 1, "the approved operation has one actual result, not an invented approval acknowledgement");
            const output = await inspect(receipts[0].content);
            assert.equal(output.status, 200);
            assert.equal(output.content, "approved");
            assert.equal(output.exitCode, 0);
            assert.equal(output.terminal, true);
            await start("duplicate", { workspace: "approval-live", resume });
            assert.equal((await finish("duplicate")).events.at(-1).type, "RUN_ERROR");
            assert.equal(model.requests.length, before + 2, "one proposed command and one answer, without a model retry");
        });
        await verifyHandoff({ ...session, t, model });
        checkBrowser();
        await verifyObserver({ ...session, t, model, checkBrowser });
        await t.test("{§web-agui-conformance} an idle observer receives daemon shutdown as a terminal error", async () => {
            await start("shutdown", { workspace: "browser-conformance", observe: true });
            await event("shutdown", "MESSAGES_SNAPSHOT");
            await stop();
            const result = await finish("shutdown");
            assert.equal(result.failure, null);
            assert.equal(result.events.at(-1).type, "RUN_ERROR");
            assert.match(result.events.at(-1).code, /service-stopping$/u);
            assert.equal(result.running, false);
        });
    } finally {
        await session.close();
    }
}
