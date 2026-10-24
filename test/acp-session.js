import assert from "node:assert/strict";
import { inspectResult } from "./result-body.js";

// {§web-acp-conformance} One browser fixture drives the official SDK; it owns no protocol reducer.
export default async function acpSession(tab, { token, projectRoot }) {
    await tab.evaluate(async (token) => {
        const { HttpAgent, Observer } = await import("/__test__/http-agent.js");
        const runs = new Map();
        const execute = (run, parameters, observe = false) => {
            run.events = [];
            run.failure = null;
            run.settled = false;
            run.promise = run.agent[observe ? "connectAgent" : "runAgent"](parameters, {
                onEvent: ({ event }) => { run.events.push(event); },
            }).catch((error) => {
                run.failure = { name: error.name, message: error.message, status: error.status, payload: error.payload };
            }).finally(() => { run.settled = true; });
        };
        globalThis.lifecycle = {
            start(id, { workspace, threadId = workspace, observe = false, messages = [], tools = [], resume, ...plurnk }) {
                const agent = new (observe ? Observer : HttpAgent)({
                    url: new URL(observe ? "/acp/connect" : "/acp", location.href).href,
                    threadId, headers: { Authorization: `Bearer ${token}` }, initialMessages: messages,
                });
                const parameters = { tools, forwardedProps: { plurnk: { workspace, ...plurnk } }, ...(resume ? { resume } : {}) };
                const run = { agent, parameters, events: [], failure: null, settled: false };
                runs.set(id, run);
                execute(run, parameters, observe);
            },
            send(id, messages) {
                const run = runs.get(id);
                if (!run.settled) throw new Error("Detach observation before submitting input.");
                run.agent.url = new URL("/acp", location.href).href;
                run.agent.addMessages(messages);
                execute(run, run.parameters);
            },
            resume(id, resume) {
                const run = runs.get(id);
                run.agent.url = new URL("/acp", location.href).href;
                execute(run, { ...run.parameters, resume });
            },
            reconnect(id) {
                const run = runs.get(id);
                run.agent.url = new URL("/acp/connect", location.href).href;
                execute(run, run.parameters, true);
            },
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
            async close() {
                for (const { agent } of runs.values()) agent.abortRun();
                await Promise.all([...runs.values()].map(({ promise }) => promise));
            },
        };
    }, token);
    const start = (id, options) => tab.evaluate(({ id, options }) => globalThis.lifecycle.start(id, options), { id, options: { projectRoot, ...options } });
    const read = (id) => tab.evaluate((id) => globalThis.lifecycle.read(id), id);
    const finish = async (id) => {
        try {
            await tab.waitForFunction((id) => globalThis.lifecycle.read(id).settled, id, { timeout: 10_000 });
        } catch (cause) {
            throw new Error(`SDK run ${id} did not settle: ${JSON.stringify(await read(id))}`, { cause });
        }
        return tab.evaluate((id) => globalThis.lifecycle.finish(id), id);
    };
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
    let sequence = 0;
    const action = async (workspace, threadId, kind, parameters = {}) => {
        const id = `observer-action-${sequence++}`;
        await start(id, { workspace, threadId, action: { kind, ...parameters } });
        const result = await finish(id);
        successful(result);
        const outcome = result.events.at(-1).result;
        assert.equal(outcome?.ok, true, JSON.stringify(outcome));
        return outcome.result;
    };
    const detach = async (id) => {
        await tab.evaluate((id) => globalThis.lifecycle.detach(id), id);
        assert.equal((await finish(id)).failure, null);
    };
    const observe = async (id, workspace, worker) => {
        await start(id, { workspace, threadId: worker, observe: true });
        await event(id, "MESSAGES_SNAPSHOT");
        const result = await read(id);
        assert.equal(result.failure, null);
        assert.equal(result.events[0].type, "RUN_STARTED");
        assert.equal(result.events[1].type, "STATE_SNAPSHOT");
        return result;
    };
    const prompt = (name) => [{ id: `message-${name}`, role: "user", content: `Lifecycle fixture: ${name}.` }];
    const close = () => tab.evaluate(() => globalThis.lifecycle.close());
    const inspect = (content) => inspectResult(content, token, tab.url());
    return { tab, start, finish, read, event, successful, action, detach, observe, prompt, close, inspect };
}
