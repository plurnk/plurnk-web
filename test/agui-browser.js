import assert from "node:assert/strict";
import verifyLifecycle from "./agui-lifecycle.js";
import verifyOrdinary from "./agui-ordinary.js";
import httpAgentBundle from "./http-agent-bundle.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";
import { inspectResult } from "./result-body.js";

export default async function verifyAgui(browser, base, token, projectRoot, model, t, stop) {
    const mount = await httpAgentBundle();
    const context = await browser.newContext();
    const checkBrowser = browserDiagnostics(context);
    try {
        const tab = await context.newPage();
        const requests = [];
        tab.on("request", (request) => requests.push(request.url()));
        await mount(tab, base);
        await tab.goto(base);
        const run = (options) => tab.evaluate(async ({ token, ...options }) => {
            const { HttpAgent } = await import("/__test__/http-agent.js");
            const agent = new HttpAgent({
                url: new URL("/agui", location.href).href,
                threadId: options.threadId ?? "browser-conformance",
                headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
            });
            agent.messages = options.messages ?? [];
            const events = [];
            const failures = [];
            let rejected;
            let timedOut = false;
            const deadline = setTimeout(() => {
                timedOut = true;
                agent.abortRun();
            }, 30_000);
            try {
                await agent.runAgent({ forwardedProps: { plurnk: options.plurnk } }, {
                    onEvent: ({ event }) => { events.push(event); },
                    onRunFailed: ({ error }) => { failures.push(error.message); },
                });
            } catch (error) {
                rejected = { message: error.message, status: error.status, payload: error.payload };
            } finally {
                clearTimeout(deadline);
            }
            if (timedOut) throw new Error(`Browser fixture exceeded its test deadline: ${JSON.stringify(events)}`);
            return { events, failures, rejected, messages: agent.messages, state: agent.state, running: agent.isRunning };
        }, options);

        await t.test("{§web-agui-conformance} absent and incorrect bearer credentials fail before inference", async () => {
            for (const credential of [undefined, "incorrect-test-token"]) {
                const result = await run({ token: credential, plurnk: { action: { kind: "discover" } } });
                assert.equal(result.rejected?.status, 401);
                const problem = typeof result.rejected.payload === "string" ? JSON.parse(result.rejected.payload) : result.rejected.payload;
                assert.equal(problem.status, 401);
                assert.match(problem.type, credential === undefined ? /\/bearer-token-required$/u : /\/bearer-token-invalid$/u);
                assert.deepEqual(result.events, []);
                assert.equal(result.running, false);
                checkBrowser([
                    httpFailure("/agui", 401),
                    new RegExp(`^error /__test__/http-agent\\.js: Agent execution failed: Error: HTTP 401: .*"type":"${RegExp.escape(problem.type)}"`, "u"),
                ]);
            }
            assert.equal(model.requests.length, 0);
        });

        await t.test("{§web-agui-conformance} authenticated discovery uses the standard Run transport", async () => {
            const result = await run({ token, plurnk: { action: { kind: "discover" } } });
            assert.deepEqual(result.failures, []);
            assert.equal(result.rejected, undefined);
            const action = result.events.at(-1).result;
            assert.equal(action?.kind, "discover");
            assert.equal(action.ok, true);
            assert.equal(action.result.actions["workspace.list"].scope, "daemon");
            assert.equal(action.result.actions["entry.read"].scope, "workspace");
            assert.equal(result.events.at(-1).type, "RUN_FINISHED");
            assert.deepEqual(result.state, {});
            assert.equal(model.requests.length, 0);
        });

        await t.test("{§web-agui-conformance} browser assembles reasoning, file receipts, state and final answer", async () => {
            const result = await run({
                token,
                messages: [{ id: "browser-question", role: "user", content: "Read witness.txt and report its contents." }],
                plurnk: { workspace: "browser-conformance", projectRoot, maxTurns: 3 },
            });
            assert.deepEqual(result.failures, []);
            assert.equal(result.rejected, undefined);
            assert.equal(result.events[0].type, "RUN_STARTED");
            assert.equal(result.events.at(-1).type, "RUN_FINISHED", JSON.stringify(result.events.filter((event) =>
                event.type === "RUN_ERROR" || event.type === "TOOL_CALL_RESULT")));
            assert.deepEqual(result.events.at(-1).outcome, { type: "success" });
            assert.equal(result.events.at(-1).result?.status, 200);
            assert.deepEqual(result.events.at(-1).usage, [{ provider: "provider:browser-fixture", model: "browser-fixture",
                inputTokens: 800, outputTokens: 160, totalTokens: 960 }],
            "standard completion aggregates the two reported requests, without invented cache or reasoning counts");
            assert.equal(result.events.some(({ type }) => type === "RUN_ERROR"), false);
            assert.equal(result.running, false);
            assert.equal(result.messages.findLast(({ role }) => role === "assistant").content,
                "Browser connection verified: cobalt heron.");
            assert.equal(result.events.filter(({ type }) => type === "REASONING_MESSAGE_CONTENT").map(({ delta }) => delta).join(""),
                "I will read the requested project file.The file confirms the browser connection.");
            const calls = result.messages.flatMap(({ toolCalls }) => toolCalls ?? []);
            const read = calls.find(({ function: fn }) => fn.name === "READ");
            assert.ok(read, "READ survives the official SDK's native tool-call projection");
            const receipt = result.messages.find(({ role, toolCallId }) => role === "tool" && toolCallId === read.id);
            assert.ok(receipt, "the native tool result retains its call correlation");
            const readResult = await inspectResult(receipt.content, token, base);
            assert.equal(readResult.status, 200);
            assert.match(readResult.content, /cobalt heron/u);
            const projected = result.events.find(({ type, toolCallId }) => type === "TOOL_CALL_RESULT" && toolCallId === read.id);
            assert.equal(read.metadata.plurnk.op, "READ");
            assert.equal(read.metadata.plurnk.address, "witness.txt");
            assert.equal(read.metadata.plurnk.status, 200);
            assert.equal(projected.metadata, undefined, "the call's own result does not repeat its row facts");
            assert.deepEqual(projected.content, receipt.content, "live and replay preserve the same standard parts");
            assert.ok(result.events.some(({ type }) => type === "STATE_SNAPSHOT"));
            assert.ok(result.events.some(({ type }) => type === "STATE_DELTA"));
            assert.equal(result.state.plurnk.workspace.name, "browser-conformance");
            assert.equal(result.state.plurnk.workspace.projectRoot, projectRoot);
            assert.equal(result.state.plurnk.status.lifecycle, "completed");
            assert.equal(result.state.plurnk.status.packetCount, 2);
            assert.equal(result.state.plurnk.workspace.activity, null);
            assert.ok(Object.hasOwn(result.state.plurnk.workspace, "preparation"));
            assert.equal(Object.hasOwn(result.state.plurnk.status, "activity"), false);
            assert.equal(Object.hasOwn(result.state.plurnk.status, "preparation"), false);
            assert.equal(model.requests.length, 2);
        });

        await t.test("{§web-agui-conformance} workspace actions report workspace activity without selecting a model worker", async () => {
            const before = model.requests.length;
            const result = await run({ token, threadId: "not-a-worker", plurnk: {
                workspace: "browser-conformance", action: { kind: "workspace.workers" },
            } });
            assert.equal(result.rejected, undefined);
            assert.deepEqual(result.failures, []);
            const action = result.events.at(-1).result;
            assert.equal(action?.kind, "workspace.workers");
            assert.equal(action.ok, true);
            assert.equal(result.events.at(-1).type, "RUN_FINISHED");
            assert.deepEqual(result.events.at(-1).outcome, { type: "success" });
            assert.equal(result.state.plurnk.workspace.name, "browser-conformance");
            assert.ok(Object.hasOwn(result.state.plurnk.workspace, "activity"));
            assert.ok(Object.hasOwn(result.state.plurnk.workspace, "preparation"));
            assert.equal(Object.hasOwn(result.state.plurnk, "status"), false);
            assert.equal(Object.hasOwn(result.state, "budget"), false);
            assert.equal(model.requests.length, before);
        });

        await t.test("{§web-agui-conformance} provider refusal arrives as RUN_ERROR, not a successful completion", async () => {
            const result = await run({
                token, threadId: "browser-rejected",
                messages: [{ id: "browser-rejection", role: "user", content: "Exercise the rejected browser request." }],
                plurnk: { workspace: "browser-rejected", projectRoot, maxTurns: 3 },
            });
            assert.deepEqual(result.failures, []);
            assert.equal(result.rejected, undefined, "a valid RUN_ERROR is not a transport failure");
            assert.equal(result.events.at(-1).type, "RUN_ERROR");
            assert.match(result.events.at(-1).message, /Browser fixture deliberately refused this request/u);
            assert.equal(result.events.some(({ type }) => type === "RUN_FINISHED"), false);
            assert.equal(result.running, false);
            assert.equal(model.requests.length, 3, "a provider refusal is not retried");
        });

        checkBrowser();
        await verifyOrdinary(tab, token, model, t);
        checkBrowser();
        await verifyLifecycle(tab, { token, projectRoot, model, t, stop, checkBrowser, mount, base });
        assert.deepEqual(model.errors, []);
        checkBrowser();
        assert.ok(requests.every((url) => new URL(url).origin === new URL(base).origin));
        assert.equal(await tab.locator("main").innerText(), "", "conformance adds no worker UI");
        assert.deepEqual(await tab.evaluate(() => Object.keys(localStorage)), []);
    } finally {
        await context.close();
    }
}
