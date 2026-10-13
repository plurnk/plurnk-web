import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite";

export default async function verifyAgui(browser, base, token, projectRoot, model, t) {
    const [{ output }] = await build({
        configFile: false,
        logLevel: "warn",
        build: {
            write: false,
            lib: { entry: fileURLToPath(new URL("./http-agent-entry.js", import.meta.url)), formats: ["es"] },
        },
    });
    const chunks = output.filter(({ type }) => type === "chunk");
    assert.equal(chunks.length, 1, "the test SDK has one self-contained browser entry");
    const context = await browser.newContext();
    try {
        const tab = await context.newPage();
        const errors = [];
        const requests = [];
        tab.on("pageerror", (error) => errors.push(error.message));
        tab.on("request", (request) => requests.push(request.url()));
        // Only the test SDK bundle is injected; every /agui request reaches the daemon.
        await tab.route(new URL("/__test__/http-agent.js", base).href, (route) => route.fulfill({
            contentType: "text/javascript", body: chunks[0].code,
        }));
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
                assert.match(problem.type, /\/bearer-token-required$/u);
                assert.deepEqual(result.events, []);
                assert.equal(result.running, false);
            }
            assert.equal(model.requests.length, 0);
        });

        await t.test("{§web-agui-conformance} authenticated discovery uses the standard Run transport", async () => {
            const result = await run({ token, plurnk: { action: { kind: "discover" } } });
            assert.deepEqual(result.failures, []);
            assert.equal(result.rejected, undefined);
            const action = result.events.find(({ name }) => name === "plurnk.action.result")?.value;
            assert.equal(action?.kind, "discover");
            assert.equal(action.ok, true);
            assert.equal(action.result.actions["workspace.list"].scope, "worldless");
            assert.equal(action.result.actions["entry.read"].scope, "workspace");
            assert.equal(result.events.at(-1).type, "RUN_FINISHED");
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
                event.type === "RUN_ERROR" || (event.name === "plurnk.row" && event.value.origin === "model"))));
            assert.deepEqual(result.events.at(-1).outcome, { type: "success" });
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
            const readResult = JSON.parse(receipt.content);
            assert.equal(readResult.status, 200);
            assert.match(readResult.content, /cobalt heron/u);
            assert.ok(result.events.some(({ name, value }) => name === "plurnk.row"
                && value.origin === "model" && value.op === "READ"
                && value.tx.target.raw === "witness.txt" && value.rx.content === readResult.content),
                "Plurnk receipts remain available alongside the native projection");
            assert.ok(result.events.some(({ type }) => type === "STATE_SNAPSHOT"));
            assert.ok(result.events.some(({ type }) => type === "STATE_DELTA"));
            assert.equal(result.state.plurnk.workspace.name, "browser-conformance");
            assert.equal(result.state.plurnk.workspace.projectRoot, projectRoot);
            assert.equal(result.state.plurnk.status.lifecycle, "completed");
            assert.equal(result.state.plurnk.status.packetCount, 2);
            assert.equal(result.state.plurnk.status.activity, null);
            assert.equal(model.requests.length, 2);
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

        assert.deepEqual(model.errors, []);
        assert.deepEqual(errors, []);
        assert.ok(requests.every((url) => new URL(url).origin === new URL(base).origin));
        assert.equal(await tab.locator("main h1").innerText(), "Hello world", "conformance adds no application UI");
        assert.deepEqual(await tab.evaluate(() => Object.keys(localStorage)), []);
    } finally {
        await context.close();
    }
}
