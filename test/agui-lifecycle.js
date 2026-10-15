import assert from "node:assert/strict";
import verifyObserver from "./agui-observer.js";

// {§web-agui-conformance} The fixture uses only the official SDK and the daemon's public wire.
export default async function verifyLifecycle(tab, { token, projectRoot, model, t, stop }) {
    await tab.evaluate(async (token) => {
        const { HttpAgent, Observer } = await import("/__test__/http-agent.js");
        const runs = new Map();
        const execute = (run, parameters, observe = false) => {
            run.events = [];
            run.failure = null;
            run.settled = false;
            run.parameters = parameters;
            run.promise = run.agent[observe ? "connectAgent" : "runAgent"](parameters, {
                onEvent: ({ event }) => { run.events.push(event); },
            }).catch((error) => {
                run.failure = { name: error.name, message: error.message, status: error.status, payload: error.payload };
            }).finally(() => { run.settled = true; });
        };
        globalThis.lifecycle = {
            start(id, { workspace, threadId = workspace, observe = false, messages = [], tools = [], resume, ...plurnk }) {
                const agent = new (observe ? Observer : HttpAgent)({
                    url: new URL(observe ? "/agui/connect" : "/agui", location.href).href,
                    threadId, headers: { Authorization: `Bearer ${token}` }, initialMessages: messages,
                });
                const run = { agent, events: [], failure: null, settled: false };
                runs.set(id, run);
                const parameters = { tools, forwardedProps: { plurnk: { workspace, ...plurnk } }, ...(resume ? { resume } : {}) };
                execute(run, parameters, observe);
            },
            resume(id, resume) { const run = runs.get(id); execute(run, { ...run.parameters, resume }); },
            reconnect(id) { const run = runs.get(id); execute(run, run.parameters, true); },
            async finish(id) { await runs.get(id).promise; return this.read(id); },
            read(id) {
                const run = runs.get(id);
                return { events: run.events, failure: run.failure, settled: run.settled,
                    messages: run.agent.messages, state: run.agent.state, running: run.agent.isRunning,
                    interrupts: run.agent.pendingInterrupts };
            },
            async detach(id) {
                const { agent } = runs.get(id);
                // SDK 1.0.2 detaches its consumer without closing the SSE fetch; release the observer transport too.
                try { await agent.detachActiveRun(); }
                finally { agent.abortRun(); }
            },
            abort(id) { runs.get(id).agent.abortRun(); },
            close() { for (const { agent } of runs.values()) agent.abortRun(); },
        };
    }, token);
    const start = (id, options) => tab.evaluate(({ id, options }) => globalThis.lifecycle.start(id, options), { id, options: { projectRoot, ...options } });
    const finish = async (id) => {
        try {
            await tab.waitForFunction((id) => globalThis.lifecycle.read(id).settled, id, { timeout: 10_000 });
        } catch (cause) {
            const result = await read(id);
            throw new Error(`SDK run ${id} did not settle: ${JSON.stringify(result)}`, { cause });
        }
        return tab.evaluate((id) => globalThis.lifecycle.finish(id), id);
    };
    const read = (id) => tab.evaluate((id) => globalThis.lifecycle.read(id), id);
    const event = async (id, type) => {
        try {
            await tab.waitForFunction(({ id, type }) => {
                const result = globalThis.lifecycle.read(id);
                return result.settled || result.events.some((event) => event.type === type);
            }, { id, type }, { timeout: 10_000 });
        } catch (cause) {
            throw new Error(`SDK run ${id} never received ${type}: ${JSON.stringify(await read(id))}`, { cause });
        }
        const result = await read(id);
        assert.ok(result.events.some((event) => event.type === type), `SDK run ${id} ended before ${type}: ${JSON.stringify(result)}`);
    };
    const successful = (result) => {
        assert.equal(result.failure, null);
        assert.equal(result.events.at(-1)?.type, "RUN_FINISHED");
        assert.deepEqual(result.events.at(-1).outcome, { type: "success" });
        assert.equal(result.running, false);
    };
    const prompt = (name) => [{ id: `message-${name}`, role: "user", content: `Lifecycle fixture: ${name}.` }];
    try {
        await t.test("{§web-agui-conformance} synchronization is authoritative and inference-free", async () => {
            const before = model.requests.length;
            await start("sync", { workspace: "browser-conformance", mode: "sync" });
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
            assert.match(JSON.parse(receipt.content).content, /cobalt heron/u);
        });
        await t.test("{§web-agui-conformance} a repeated thread name in another workspace has no borrowed history", async () => {
            const before = model.requests.length;
            await start("other-create", { workspace: "other-workspace", threadId: "browser-conformance", mode: "sync", control: true });
            successful(await finish("other-create"));
            await start("other", { workspace: "other-workspace", threadId: "browser-conformance", mode: "sync" });
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
        await t.test("{§web-agui-conformance} controlling disconnect cancels its work and an observer sees that outcome", async () => {
            await start("cancel-controller", { workspace: "cancel-live", messages: prompt("held-cancel") });
            await event("cancel-controller", "REASONING_MESSAGE_CONTENT");
            await start("cancel-observer", { workspace: "cancel-live", observe: true });
            await event("cancel-observer", "MESSAGES_SNAPSHOT");
            await tab.evaluate(() => globalThis.lifecycle.abort("cancel-controller"));
            await finish("cancel-controller");
            const result = await finish("cancel-observer");
            assert.equal(result.failure, null);
            assert.equal(result.events.at(-1).type, "RUN_ERROR");
            const terminal = result.events.find(({ name }) => name === "plurnk.terminated")?.value;
            assert.equal(terminal?.result.status, 499);
            assert.equal(terminal?.result.problem.reason, "client_disconnected");
            assert.equal(result.running, false);
        });
        await t.test("{§web-agui-conformance} native approval interrupts and resumes once through the official SDK", async () => {
            const before = model.requests.length;
            const tools = [{ name: "request_approval", description: "Review operations", parameters: { type: "object" } }];
            await start("approval", { workspace: "approval-live", messages: prompt("approval"), tools });
            const paused = await finish("approval");
            assert.equal(paused.failure, null);
            assert.equal(paused.events.at(-1).outcome?.type, "interrupt", JSON.stringify({
                events: paused.events.filter(({ name, type, value }) => type === "RUN_ERROR" || name === "plurnk.notice" || (name === "plurnk.row" && value.origin === "model")),
            }));
            assert.equal(paused.running, false);
            assert.equal(paused.interrupts.length, 1);
            const interrupt = paused.interrupts[0];
            assert.ok(interrupt.id);
            const resume = [{ interruptId: interrupt.id, status: "resolved", payload: { decision: "accept" } }];
            await start("wrong-owner", { workspace: "approval-live", threadId: "observer", resume, tools });
            const refused = await finish("wrong-owner");
            assert.equal(refused.events.at(-1).type, "RUN_ERROR");
            await tab.evaluate(({ resume }) => globalThis.lifecycle.resume("approval", resume), { resume });
            const completed = await finish("approval");
            successful(completed);
            assert.deepEqual(completed.interrupts, []);
            assert.equal(completed.messages.findLast(({ role }) => role === "assistant").content, "Completed approval.");
            const acknowledgement = completed.events.find(({ type, toolCallId }) => type === "TOOL_CALL_RESULT" && toolCallId === interrupt.toolCallId);
            assert.deepEqual(JSON.parse(acknowledgement?.content ?? "null"), { status: "resolved", payload: { decision: "accept" } });
            await start("duplicate", { workspace: "approval-live", resume, tools });
            assert.equal((await finish("duplicate")).events.at(-1).type, "RUN_ERROR");
            assert.equal(model.requests.length, before + 2, "one proposed command and one answer, without a model retry");
        });
        await verifyObserver({ tab, t, start, finish, read, event, successful, prompt, model });
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
        await tab.evaluate(() => globalThis.lifecycle.close());
    }
}
