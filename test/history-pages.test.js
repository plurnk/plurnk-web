import assert from "node:assert/strict";
import test from "node:test";
import HistoryPages from "../web/history-pages.js";
import SessionAgent, { buildPromptBlocks } from "../web/session-agent.js";
import { SessionTranslator } from "../web/session-translator.js";

const message = (id, content = id) => ({ id, role: /** @type {const} */ ("user"), content });
const snapshot = (messages, older) => ({ messages, older });
const ids = (history) => history.view().messages.map(({ id }) => id);

test("{§web-session-history} explicit pages preserve chronology and never mutate live input", () => {
    const history = new HistoryPages();
    const live = Object.freeze([Object.freeze(message("c")), Object.freeze(message("d"))]);
    history.snapshot(snapshot(live, "/older/b"));
    history.live(live);
    assert.deepEqual(history.view().gaps, [{ url: "/older/b", before: "c" }]);
    history.accept("/older/b", { final: true, messages: [message("b"), message("c", "old")], older: "/older/a" });
    history.accept("/older/a", { final: true, messages: [message("a"), message("b")], older: null });
    assert.deepEqual(ids(history), ["a", "b", "c", "d"]);
    assert.equal(history.view().messages[2].content, "c", "live content wins overlap at its original position");
    assert.deepEqual(history.view().gaps, []);
    assert.deepEqual(live, [message("c"), message("d")]);
    assert.deepEqual(history.mutable(), []);
});

test("{§web-session-history} reconnect exposes a gap without fetching or losing selected pages", () => {
    const history = new HistoryPages();
    history.snapshot(snapshot([message("c")], "/b"));
    history.live([message("c")]);
    history.accept("/b", { final: true, messages: [message("b")], older: "/a" });
    history.snapshot(snapshot([message("e")], "/d"));
    history.live([message("e")]);
    assert.deepEqual(ids(history), ["b", "e"]);
    assert.deepEqual(history.view().gaps, [{ url: "/a", before: "b" }, { url: "/d", before: "e" }]);
    history.accept("/d", { final: true, messages: [message("d")], older: "/c" });
    history.accept("/c", { final: true, messages: [message("c")], older: "/b" });
    assert.deepEqual(ids(history), ["b", "c", "d", "e"]);
    assert.deepEqual(history.view().gaps, [{ url: "/a", before: "b" }]);
});

test("{§web-session-history} late results update an archived call once, then survive its final refetch", () => {
    const history = new HistoryPages();
    const call = { id: "call-message", role: /** @type {const} */ ("assistant"), toolCalls: [{ toolCallId: "call", name: "read", rawInput: {} }] };
    const result = { id: "result", role: /** @type {const} */ ("tool"), toolCallId: "call", content: "live result" };
    history.snapshot(snapshot([message("new")], "/old"));
    history.live([message("new")]);
    history.accept("/old", { final: false, messages: [call], older: null });
    assert.deepEqual(history.mutable(), ["/old"]);
    history.live([message("new"), result]);
    assert.deepEqual(ids(history), ["call-message", "result", "new"]);
    history.snapshot(snapshot([message("new")], "/old"));
    history.live([message("new")]);
    assert.deepEqual(ids(history), ["call-message", "result", "new"], "a revalidation failure cannot erase an already observed result");
    history.accept("/old", { final: false, messages: [call], older: null });
    assert.deepEqual(ids(history), ["call-message", "result", "new"], "a read begun before the result does not erase it either");
    history.live([message("new"), result]);
    history.accept("/old", { final: true, messages: [call, { ...result, content: "snapshot result" }], older: null });
    assert.deepEqual(ids(history), ["call-message", "result", "new"]);
    assert.equal(history.view().messages[1].content, "live result");
    assert.deepEqual(history.mutable(), []);
    history.snapshot(snapshot([message("newer")], "/new"));
    history.live([message("newer")]);
    assert.deepEqual(ids(history), ["call-message", "result", "newer"]);
});

test("{§web-session-history} multiple late receipts preserve their supplied order beside an archived call", () => {
    const history = new HistoryPages();
    const call = { id: "calls", role: /** @type {const} */ ("assistant"), toolCalls: ["one", "two"].map((toolCallId) => ({ toolCallId, name: "read", rawInput: {} })) };
    const results = ["one", "two"].map((id) => ({ id: `result-${id}`, role: /** @type {const} */ ("tool"), toolCallId: id, content: id }));
    history.snapshot(snapshot([message("now")], "/old"));
    history.live([message("now")]);
    history.accept("/old", { final: false, messages: [call], older: null });
    history.live([message("now"), ...results]);
    assert.deepEqual(ids(history), ["calls", "result-one", "result-two", "now"]);
});

test("{§web-session-history} abandoned reads and invalid cursor cycles cannot change the view", () => {
    const history = new HistoryPages();
    history.snapshot(snapshot([message("new")], "/old"));
    history.live([message("new")]);
    history.snapshot(snapshot([message("newer")], "/later"));
    history.live([message("newer")]);
    assert.equal(history.accept("/old", { final: true, messages: [message("old")], older: null }), false);
    assert.deepEqual(ids(history), ["newer"]);
    assert.throws(() => history.accept("/later", { final: true, messages: [], older: "/later" }), /History page repeats its own cursor/u);
    assert.throws(() => history.snapshot(snapshot([], /** @type {any} */ (42))), /History boundary must be a URL or null/u);
    assert.throws(() => history.snapshot(/** @type {any} */ ({ messages: [] })), /History boundary must be a URL or null/u);
    assert.throws(() => history.live([message("duplicate"), message("duplicate")]), /duplicate message identities/u);
    assert.deepEqual(ids(history), ["newer"]);
});

test("{§web-session-history} a cyclic daemon page chain fails without accepting the page", () => {
    const history = new HistoryPages();
    history.snapshot(snapshot([message("latest")], "/b"));
    history.live([message("latest")]);
    history.accept("/b", { final: true, messages: [message("b")], older: "/a" });
    assert.throws(() => history.accept("/a", { final: true, messages: [message("a")], older: "/b" }), /History page cursors form a cycle/u);
    assert.deepEqual(ids(history), ["b", "latest"]);
});

test("{§web-session-conversation} {§web-session-history} ambient call tracking is isolated per session projection", () => {
    const sessionAAmbient = new Set();
    const afterAmbientCall = SessionTranslator.projectMessages([
        {
            sessionUpdate: "tool_call",
            toolCallId: "shared-call-1",
            name: "read",
            _meta: { plurnk: { coordinate: "shared-call-1", origin: "system", op: "read" } },
        },
    ], [], sessionAAmbient);
    assert.deepEqual(afterAmbientCall, []);
    assert.equal(sessionAAmbient.has("shared-call-1"), true);

    const sessionADischarge = SessionTranslator.projectMessages([
        {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-call-1",
            rawOutput: "ambient receipt",
            _meta: { plurnk: { coordinate: "obs:1", origin: "system", op: "read" } },
        },
    ], afterAmbientCall, sessionAAmbient);
    assert.deepEqual(sessionADischarge, [], "ambient call discharge stays suppressed within the originating session");

    const sessionBDischarge = SessionTranslator.projectMessages([
        {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-call-1",
            rawOutput: "model receipt",
            _meta: { plurnk: { coordinate: "obs:1", origin: "model", op: "read" } },
        },
    ]);
    assert.equal(sessionBDischarge.length, 1, "another session sharing toolCallId is unaffected by session A's ambient set");
    assert.equal(sessionBDischarge[0].id, "obs:1");
});

/**
 * @param {{
 *   capabilities?: Record<string, unknown>,
 *   onRequest: (input: Record<string, unknown>) => Promise<{ updates?: readonly Record<string, unknown>[], result?: Record<string, unknown>, closeStream?: boolean }> | { updates?: readonly Record<string, unknown>[], result?: Record<string, unknown>, closeStream?: boolean },
 * }} options
 */
function createMockAcpTransport({ capabilities = {}, onRequest }) {
    const encoder = new TextEncoder();
    /** @type {Record<string, unknown>[]} */
    const requests = [];
    let connSeq = 0;
    /** @type {Map<string, { controller: ReadableStreamDefaultController<Uint8Array> | null, queue: string[], closed: boolean }>} */
    const streams = new Map();
    /** @param {string} key */
    const getStream = (key) => {
        let entry = streams.get(key);
        if (!entry) {
            entry = { controller: null, queue: [], closed: false };
            streams.set(key, entry);
        }
        return entry;
    };
    /** @param {string} key @param {string} frame */
    const writeSse = (key, frame) => {
        const entry = getStream(key);
        if (entry.closed) return;
        if (entry.controller) entry.controller.enqueue(encoder.encode(frame));
        else entry.queue.push(frame);
    };
    /** @param {string} key */
    const closeSse = (key) => {
        const entry = getStream(key);
        if (entry.closed) return;
        entry.closed = true;
        try { entry.controller?.close(); } catch { /* already closed */ }
    };
    /** @type {typeof globalThis.fetch} */
    const mockFetch = async (_input, init = {}) => {
        const method = (init.method ?? "GET").toUpperCase();
        const headers = new Headers(init.headers);
        const connId = headers.get("acp-connection-id") ?? "";
        const headerSessionId = headers.get("acp-session-id") ?? "";
        if (method === "GET") {
            const key = `${connId}:${headerSessionId}`;
            const entry = getStream(key);
            const body = new ReadableStream({
                start(controller) {
                    entry.controller = controller;
                    controller.enqueue(encoder.encode(":\n\n"));
                    for (const queued of entry.queue.splice(0)) {
                        controller.enqueue(encoder.encode(queued));
                    }
                    if (entry.closed) controller.close();
                },
                cancel() {
                    if (entry.controller) entry.controller = null;
                },
            });
            return new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        }
        if (method === "DELETE") {
            for (const key of streams.keys()) {
                if (key.startsWith(`${connId}:`)) closeSse(key);
            }
            return new Response(null, { status: 202 });
        }
        const rawBody = typeof init.body === "string"
            ? init.body
            : init.body instanceof Uint8Array
                ? new TextDecoder().decode(init.body)
                : "";
        const rpc = /** @type {Record<string, unknown>} */ (JSON.parse(rawBody));
        requests.push(rpc);
        if (rpc.method === "initialize") {
            const assignedConn = `conn-${++connSeq}`;
            return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                    protocolVersion: 2,
                    capabilities,
                    info: { name: "@plurnk/plurnk-service", version: "6.0.0" },
                },
            }), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "acp-connection-id": assignedConn,
                },
            });
        }
        const params = typeof rpc.params === "object" && rpc.params !== null
            ? /** @type {Record<string, unknown>} */ (rpc.params)
            : {};
        const sessionId = headerSessionId || (typeof params.sessionId === "string" ? params.sessionId : "");
        const key = `${connId}:${sessionId}`;
        queueMicrotask(async () => {
            const outcome = await onRequest(rpc);
            for (const update of outcome.updates ?? []) {
                writeSse(key, `data: ${JSON.stringify({
                    jsonrpc: "2.0",
                    method: "session/update",
                    params: { sessionId, update },
                })}\n\n`);
            }
            writeSse(key, `data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                result: outcome.result ?? {},
            })}\n\n`);
            if (outcome.closeStream) closeSse(key);
        });
        return new Response(null, { status: 202 });
    };
    return {
        fetch: mockFetch,
        requests,
        push(sessionId, update) {
            for (const key of streams.keys()) {
                if (key.endsWith(`:${sessionId}`)) {
                    writeSse(key, `data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: { sessionId, update },
                    })}\n\n`);
                }
            }
        },
        closeAll() {
            for (const key of streams.keys()) closeSse(key);
        },
    };
}

test("{§web-session-observer} {§web-session-reasoning} replay_complete transitions resume from historical replay to live thought and error Problem intake", async () => {
    const catalogProblem = {
        type: "https://plurnk.dev/problems/providers/catalog-unavailable",
        title: "Provider catalog unavailable",
        status: 503,
        detail: "Provider catalog probe failed.",
    };
    const transport = createMockAcpTransport({
        onRequest: (rpc) => {
            if (rpc.method === "session/resume") {
                return {
                    updates: [
                        {
                            sessionUpdate: "user_message_chunk",
                            messageId: "hist-user-1",
                            content: { type: "text", text: "Earlier prompt" },
                            _meta: { plurnk: { id: 1, coordinate: "1/1/1", loopId: 1, loopSeq: 1 } },
                        },
                        {
                            sessionUpdate: "agent_thought_chunk",
                            messageId: "hist-thought-1",
                            content: { type: "text", text: "Historical thought during replay" },
                            _meta: { plurnk: { sessionName: "user", loopSeq: 1, turnSeq: 1 } },
                        },
                        {
                            sessionUpdate: "notice",
                            severity: "error",
                            title: "Historical error",
                            _meta: {
                                plurnk: {
                                    problem: {
                                        type: "https://plurnk.dev/problems/history/past-error",
                                        title: "Historical error",
                                        status: 500,
                                        detail: "Already settled in an earlier turn.",
                                    },
                                },
                            },
                        },
                        { sessionUpdate: "replay_complete" },
                        {
                            sessionUpdate: "agent_thought_chunk",
                            messageId: "live-thought-2",
                            content: { type: "text", text: "Live held thought after replay_complete" },
                            _meta: { plurnk: { sessionName: "user", loopSeq: 2, turnSeq: 1 } },
                        },
                        {
                            sessionUpdate: "notice",
                            severity: "error",
                            title: catalogProblem.title,
                            description: catalogProblem.detail,
                            _meta: { plurnk: { problem: catalogProblem } },
                        },
                    ],
                    result: {
                        configOptions: [],
                        availableCommands: [],
                        _meta: {
                            plurnk: {
                                workspace: { id: 7, name: "alpha", projectRoot: null, projectLabel: null, preparation: [], activity: null },
                                history: { older: null },
                            },
                        },
                    },
                    closeStream: true,
                };
            }
            return { result: {} };
        },
    });
    const observedThoughtUpdates = [];
    const liveThoughtChunks = [];
    const errors = [];
    const agent = new SessionAgent({
        url: "http://127.0.0.1:1066/acp",
        sessionId: "7#user",
        fetch: transport.fetch,
    });
    const outcome = await agent.resume({}, {
        onSessionUpdate({ update }) {
            if (update.sessionUpdate === "agent_thought_chunk") {
                observedThoughtUpdates.push(update.messageId);
            }
        },
        onThoughtChunk({ update }) {
            liveThoughtChunks.push(update.messageId);
        },
        onError(err) {
            errors.push(err);
        },
    });
    assert.deepEqual(observedThoughtUpdates, ["live-thought-2"], "historical thought before replay_complete stays suppressed while held live thought is delivered");
    assert.deepEqual(liveThoughtChunks, ["live-thought-2"], "held live thought after replay_complete fires onThoughtChunk after snapshot projection");
    assert.equal(agent.messages.some((m) => m.id === "hist-user-1"), true, "replayed user message remains in snapshot");
    assert.equal(agent.messages.some((m) => m.id === "live-thought-2"), true, "post-replay live thought survives snapshot assembly");
    assert.equal(outcome.stopReason, "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, catalogProblem.detail, "post-replay error Problem notice is recorded and surfaced");
    agent.close();

    // Fallback when a fixture omits replay_complete: settlement clears replay mode and historical error notice does not become a stream error.
    const fallbackTransport = createMockAcpTransport({
        onRequest: () => ({
            updates: [
                {
                    sessionUpdate: "user_message_chunk",
                    messageId: "fallback-user-1",
                    content: { type: "text", text: "Fixture without replay_complete" },
                    _meta: { plurnk: { id: 1, coordinate: "1/1/1", loopId: 1, loopSeq: 1 } },
                },
                {
                    sessionUpdate: "notice",
                    severity: "error",
                    title: "Historical error",
                    _meta: {
                        plurnk: {
                            problem: {
                                type: "https://plurnk.dev/problems/history/past-error",
                                title: "Historical error",
                                status: 500,
                                detail: "Past problem.",
                            },
                        },
                    },
                },
            ],
            result: {
                configOptions: [],
                availableCommands: [],
                _meta: {
                    plurnk: {
                        workspace: { id: 7, name: "alpha", projectRoot: null, projectLabel: null, preparation: [], activity: null },
                        history: { older: null },
                    },
                },
            },
            closeStream: true,
        }),
    });
    const fallbackErrors = [];
    const fallbackAgent = new SessionAgent({
        url: "http://127.0.0.1:1066/acp",
        sessionId: "7#user",
        fetch: fallbackTransport.fetch,
    });
    const fallbackOutcome = await fallbackAgent.resume({}, {
        onError(err) { fallbackErrors.push(err); },
    });
    assert.equal(fallbackOutcome.stopReason, "end_turn");
    assert.deepEqual(fallbackErrors, []);
    assert.equal(fallbackAgent.messages.length, 1);
    fallbackAgent.close();
});

test("{§web-session-observer} {§web-session-input} {§web-session-conversation} ACP 2.7.0 skill capability, inline $skill prompt blocks, and skill chunk projection", async () => {
    const availableCommands = [
        { type: "skill", name: "triage", description: "Triage build failures" },
        { type: "skill", name: "release.audit", description: "Audit release" },
        { type: "command", name: "compact", description: "Non-skill command" },
    ];
    assert.deepEqual(
        buildPromptBlocks(
            "Check ($triage, $release.audit.) and keep $HOME/$100/$compact literal",
            availableCommands,
        ),
        [
            { type: "text", text: "Check (" },
            { type: "skill", name: "triage" },
            { type: "text", text: ", " },
            { type: "skill", name: "release.audit" },
            { type: "text", text: ".) and keep $HOME/$100/$compact literal" },
        ],
    );
    assert.deepEqual(buildPromptBlocks("$triage", availableCommands), [
        { type: "skill", name: "triage" },
    ]);

    const projected = SessionTranslator.projectMessages([
        {
            sessionUpdate: "user_message_chunk",
            messageId: "skill-msg-1",
            content: { type: "text", text: "Run " },
        },
        {
            sessionUpdate: "user_message_chunk",
            messageId: "skill-msg-1",
            content: { type: "skill", name: "triage" },
        },
        {
            sessionUpdate: "user_message_chunk",
            messageId: "skill-msg-1",
            content: { type: "text", text: " now" },
        },
    ]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].content, "Run $triage now");

    for (const inlineSupported of [true, false]) {
        const transport = createMockAcpTransport({
            capabilities: inlineSupported
                ? { session: { prompt: { skill: { inline: {} } } } }
                : { session: { prompt: {} } },
            onRequest: (rpc) => {
                if (rpc.method === "session/prompt") {
                    const p = /** @type {{ messageId?: string }} */ (rpc.params);
                    return {
                        updates: [
                            {
                                sessionUpdate: "state_update",
                                state: "idle",
                                stopReason: "end_turn",
                                _meta: { plurnk: { terminal: { status: 200 } } },
                            },
                        ],
                        result: { messageId: p.messageId ?? "prompt-1", stopReason: "end_turn" },
                    };
                }
                return { result: {} };
            },
        });
        const agent = new SessionAgent({
            url: "http://127.0.0.1:1066/acp",
            sessionId: "7#user",
            state: { plurnk: { availableCommands } },
            fetch: transport.fetch,
        });
        await agent.send({
            message: { id: "prompt-1", role: "user", content: "Apply $triage please" },
        });
        assert.equal(agent.promptSkillSupported, inlineSupported);
        const initReq = transport.requests.find((r) => r.method === "initialize");
        assert.deepEqual(initReq?.params, {
            protocolVersion: 2,
            info: { name: "@plurnk/plurnk-web", version: "2.1.0" },
            capabilities: { session: { commands: { skill: {} } } },
        });
        const promptReq = transport.requests.find((r) => r.method === "session/prompt");
        const promptParams = /** @type {{ prompt: unknown[] }} */ (promptReq?.params);
        assert.deepEqual(
            promptParams.prompt,
            inlineSupported
                ? [
                    { type: "text", text: "Apply " },
                    { type: "skill", name: "triage" },
                    { type: "text", text: " please" },
                ]
                : [{ type: "text", text: "Apply $triage please" }],
        );
        agent.close();
    }
});
