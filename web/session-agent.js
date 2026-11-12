// {§web-browser-security} No dynamic code generation in the browser.
import "./schema-validation.js";
import {
    PROTOCOL_VERSION,
    client,
    methods,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { Validator } from "@plurnk/plurnk-contracts";
import {
    SessionTranslator,
    isRecord,
    randomUUID,
} from "./session-translator.js";
import {
    SessionGateBook,
    buildElicitationGate,
    buildPermissionGate,
    gateSessionKey,
    syncDescendantGatesInState,
} from "./session-gates.js";
import {
    applyAvailableCommandsUpdate,
    applyConfigOptionUpdate,
    applyLifecycleStateUpdate,
    applyNoticeStateUpdate,
    applyResponseState,
    applySubagentState,
    applyTerminalStreamUpdate,
    applyUsageUpdate,
} from "./session-state-projection.js";
import {
    createAcpFetch,
    extractRpcFailure,
    extractTerminalFailure,
    resolveAcpUrl,
} from "./session-transport.js";

export { PROTOCOL_VERSION, SessionTranslator, Validator, client, createHttpStream, methods, randomUUID };

/** @typedef {import("./session-translator.js").ToolCall} ToolCall */
/** @typedef {import("./session-translator.js").MessagePart} MessagePart */
/** @typedef {import("./session-translator.js").Message} Message */
/** @typedef {import("./session-translator.js").AcpSessionUpdate} AcpSessionUpdate */
/** @typedef {import("./session-translator.js").AcpSessionUpdatePayload} AcpSessionUpdatePayload */
/** @typedef {import("./session-translator.js").MessagesSnapshot} MessagesSnapshot */
/** @typedef {import("./session-gates.js").PermissionGate} PermissionGate */
/** @typedef {import("./session-gates.js").ElicitationGate} ElicitationGate */
/** @typedef {import("./session-gates.js").SessionGate} SessionGate */
/** @typedef {import("./session-gates.js").GateResolution} GateResolution */
/** @typedef {import("./session-transport.js").SessionErrorPayload} SessionErrorPayload */
/** @typedef {import("./session-transport.js").LiveOutcome} LiveOutcome */

/**
 * @typedef {{
 *   onSessionUpdate?: (args: { update: AcpSessionUpdatePayload, sessionId: string }) => void | Promise<void>,
 *   onThoughtChunk?: (args: { update: AcpSessionUpdatePayload }) => void | Promise<void>,
 *   onMessagesChanged?: (args: { messages: Message[] }) => void | Promise<void>,
 *   onMessagesSnapshot?: (args: { snapshot: MessagesSnapshot }) => void | Promise<void>,
 *   onUserMessage?: (args: { messageId: string }) => void | Promise<void>,
 *   onStateChanged?: (args: { state: Record<string, unknown> }) => void | Promise<void>,
 *   onSettled?: (args: { stopReason: string, meta?: Record<string, unknown>, result?: unknown }) => void | Promise<void>,
 *   onError?: (args: SessionErrorPayload) => void | Promise<void>,
 * }} SessionSubscriber
 */

/**
 * @typedef {{
 *   abortController?: AbortController,
 *   message?: { id: string, role: "user", content: string },
 *   resolutions?: readonly GateResolution[],
 *   action?: Record<string, unknown>,
 *   workspace?: string,
 *   projectRoot?: string,
 *   gates?: readonly string[],
 * }} SessionRunOptions
 */

/** {§web-session-observer} {§web-session-reasoning} Official ACP v2 client over `/acp`. */
export default class SessionAgent {
    /** @type {typeof globalThis.fetch} */
    #fetch;
    /** @type {ReturnType<ReturnType<typeof client>["connect"]> | undefined} */
    #conn = undefined;
    /** @type {AbortController | undefined} */
    #connController = undefined;
    /** @type {Promise<void>} */
    #notificationChain = Promise.resolve();
    /** @type {SessionSubscriber} */
    #subscriber = {};
    /** @type {boolean} */
    #bufferingReplay = false;
    /** @type {AcpSessionUpdatePayload[]} */
    #replayUpdates = [];
    /** @type {Set<string>} */
    #ambientCallIds = new Set();
    /** @type {AbortController | undefined} */
    #activeController = undefined;
    /** @type {SessionGateBook} */
    #gates = new SessionGateBook();
    /** @type {number} */
    #inFlightPostCount = 0;
    /** @type {Promise<void>} */
    #outboundPostChain = Promise.resolve();
    /** @type {((outcome: LiveOutcome) => void) | undefined} */
    #onLiveOutcome = undefined;
    /** @type {LiveOutcome | undefined} */
    #queuedLiveOutcome = undefined;
    /** @type {Promise<{ result: unknown, meta?: Record<string, unknown> }> | undefined} */
    #inFlightRequest = undefined;
    /** @type {SessionErrorPayload | undefined} */
    #streamProblem = undefined;
    /** @type {{ messageId: string, body: Record<string, unknown> } | undefined} */
    #pendingLiveThought = undefined;
    /** @type {{ id: string, content: string } | undefined} */
    #submittedPrompt = undefined;
    /** @type {boolean} */
    #needsConnectionSse = false;

    /**
     * @param {{
     *   url?: string,
     *   sessionId?: string | null,
     *   headers?: Record<string, string>,
     *   state?: Record<string, unknown>,
     *   messages?: Message[],
     *   fetch?: typeof globalThis.fetch,
     * }} [config]
     */
    constructor(config = {}) {
        this.url = config.url ?? "/acp";
        this.sessionId = config.sessionId ?? null;
        this.headers = { ...config.headers };
        /** @type {Record<string, unknown>} */
        this.state = isRecord(config.state) ? structuredClone(config.state) : {};
        /** @type {Message[]} */
        this.messages = Array.isArray(config.messages) ? structuredClone(config.messages) : [];
        /** @type {SessionGate[]} */
        this.pendingGates = [];
        /** @type {AbortController | undefined} */
        this.abortController = undefined;
        /** @type {boolean} */
        this.isRunning = false;
        this.#fetch = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
    }

    abortRun() {
        this.#activeController?.abort();
        this.abortController?.abort();
    }

    close() {
        this.#gates.reset();
        this.pendingGates = [];
        this.#ambientCallIds.clear();
        this.#onLiveOutcome = undefined;
        this.#queuedLiveOutcome = undefined;
        this.#inFlightRequest = undefined;
        this.#pendingLiveThought = undefined;
        this.#streamProblem = undefined;
        this.#connController?.abort();
        this.#connController = undefined;
        const prev = this.#conn;
        this.#conn = undefined;
        if (prev) {
            prev.close();
        }
    }

    #syncDescendantGates() {
        const synced = syncDescendantGatesInState(this.state, this.#gates.allPending);
        if (synced.changed) {
            this.state = synced.state;
        }
        return synced.changed;
    }

    #syncPendingGates() {
        const synced = this.#gates.sync(this.state);
        this.pendingGates = synced.pending;
        if (synced.changed) {
            this.state = synced.state;
        }
        return synced.changed;
    }

    /** @param {LiveOutcome} outcome */
    #emitLiveOutcome(outcome) {
        if (this.#onLiveOutcome !== undefined) {
            this.#onLiveOutcome(outcome);
        } else {
            this.#queuedLiveOutcome = outcome;
        }
    }

    #scheduleGateCoalesce() {
        if (this.#gates.coalesceTimer !== undefined) {
            clearTimeout(this.#gates.coalesceTimer);
        }
        this.#gates.coalesceTimer = setTimeout(() => {
            this.#gates.coalesceTimer = undefined;
            void this.#notificationChain.then(async () => {
                if (this.#connController?.signal.aborted) return;
                this.#syncPendingGates();
                if (!this.#bufferingReplay) {
                    await this.#subscriber.onStateChanged?.({ state: this.state });
                }
                this.#gates.onSettled?.();
                const held = this.#gates.heldIds;
                const currentIds = this.pendingGates.map(({ id }) => id);
                const sameHeld = held !== undefined
                    && held.length === currentIds.length
                    && currentIds.every((id, idx) => id === held[idx]);
                if (!sameHeld && this.pendingGates.length > 0) {
                    this.#emitLiveOutcome({ stopReason: "interrupt" });
                }
            });
        });
    }

    /** @param {string} gateId */
    #cancelGateById = (gateId) => {
        const existed = this.#gates.resolvers.has(gateId)
            || this.#gates.allPending.some((item) => item.id === gateId);
        if (!existed) return;
        this.#gates.resolvers.delete(gateId);
        this.#gates.allPending = this.#gates.allPending.filter((item) => item.id !== gateId);
        const changed = this.#syncPendingGates();
        if (this.#gates.submittedIds.has(gateId)) {
            this.#gates.cancelledSubmitted.add(gateId);
        }
        if (this.#connController?.signal.aborted) {
            return;
        }
        setTimeout(() => {
            void this.#notificationChain.then(async () => {
                if (this.#connController?.signal.aborted) return;
                if (changed && !this.#bufferingReplay) {
                    await this.#subscriber.onStateChanged?.({ state: this.state });
                }
                if (this.pendingGates.length > 0) {
                    this.#emitLiveOutcome({ stopReason: "interrupt" });
                } else if (this.#gates.heldIds !== undefined) {
                    this.#emitLiveOutcome({ stopReason: "end_turn" });
                } else if (this.#inFlightRequest === undefined) {
                    const status = isRecord(this.state.plurnk) && isRecord(this.state.plurnk.status)
                        ? this.state.plurnk.status
                        : undefined;
                    const lifecycle = typeof status?.lifecycle === "string" ? status.lifecycle : "idle";
                    if (!["queued", "running", "parked"].includes(lifecycle)) {
                        this.#emitLiveOutcome({ stopReason: "end_turn" });
                    }
                }
            });
        });
    };

    async #drainNotifications() {
        await new Promise((resolve) => setTimeout(resolve));
        await this.#notificationChain;
    }

    async #awaitGateCoalesce() {
        if (this.#gates.coalesceTimer === undefined) return;
        await new Promise((r) => {
            this.#gates.onSettled = () => {
                this.#gates.onSettled = undefined;
                r(undefined);
            };
        });
    }

    /**
     * @param {"session/request_permission" | "elicitation/create"} method
     * @param {SessionGate} entry
     * @param {AbortSignal} signal
     */
    #registerGateRequest(method, entry, signal) {
        this.#gates.allPending.push(entry);
        this.#syncPendingGates();
        return new Promise((resolve, reject) => {
            this.#gates.resolvers.set(entry.id, {
                method,
                resolve: (res) => {
                    signal.removeEventListener("abort", onCancel);
                    resolve(/** @type {never} */ (res));
                },
                reject: (err) => {
                    signal.removeEventListener("abort", onCancel);
                    reject(err);
                },
            });
            const onCancel = () => {
                this.#cancelGateById(entry.id);
                reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            signal.onabort = onCancel;
            this.#scheduleGateCoalesce();
        });
    }

    /** @param {AbortSignal} signal */
    async #ensureConnection(signal) {
        if (this.#conn !== undefined && this.#connController !== undefined && !this.#connController.signal.aborted) {
            return this.#conn;
        }
        this.close();
        const connController = new AbortController();
        this.#connController = connController;
        this.#streamProblem = undefined;

        const acpFetch = createAcpFetch({
            fetchImpl: this.#fetch,
            getHeaders: () => this.headers,
            getSessionId: () => this.sessionId,
            needsConnectionSse: () => this.#needsConnectionSse,
            connSignal: connController.signal,
            getNotificationChain: () => this.#notificationChain,
            getStreamProblem: () => this.#streamProblem,
            setStreamProblem: (problem) => { this.#streamProblem = problem; },
            emitLiveOutcome: (outcome) => this.#emitLiveOutcome(outcome),
            onPostStart: (fetchPromise) => {
                this.#inFlightPostCount += 1;
                this.#outboundPostChain = this.#outboundPostChain
                    .catch(() => undefined)
                    .then(() => fetchPromise.then(() => undefined, () => undefined));
            },
            onPostEnd: () => {
                this.#inFlightPostCount = Math.max(0, this.#inFlightPostCount - 1);
            },
        });

        const stream = createHttpStream(resolveAcpUrl(this.url), {
            fetch: acpFetch,
            headers: this.headers,
            cookies: "omit",
        });

        const app = client({ name: "@plurnk/plurnk-web" });

        app.onNotification(methods.client.session.update, (ctx) => {
            this.#notificationChain = this.#notificationChain.then(async () => {
                if (connController.signal.aborted) return;
                const sessionId = typeof ctx.params.sessionId === "string"
                    ? ctx.params.sessionId
                    : (this.sessionId ?? "");
                const rawUpdate = /** @type {Record<string, unknown>} */ (ctx.params.update);
                if (!isRecord(rawUpdate)) return;
                const plurnk = isRecord(rawUpdate._meta) && isRecord(rawUpdate._meta.plurnk)
                    ? rawUpdate._meta.plurnk
                    : undefined;
                const update = /** @type {AcpSessionUpdatePayload} */ (
                    typeof plurnk?.subagentRunId === "string" && rawUpdate.subagentRunId === undefined
                        ? { ...rawUpdate, subagentRunId: plurnk.subagentRunId }
                        : rawUpdate
                );
                await this.#handleSessionUpdate(sessionId, update, this.#subscriber);
            });
        });

        app.onNotification(methods.client.elicitation.complete, (ctx) => {
            const elicitationId = isRecord(ctx.params) && typeof ctx.params.elicitationId === "string"
                ? ctx.params.elicitationId
                : "";
            this.#gates.completeElicitation(elicitationId, this.#cancelGateById);
        });

        app.onRequest(methods.client.session.requestPermission, async (ctx) => {
            await this.#notificationChain;
            const entry = buildPermissionGate(/** @type {Record<string, unknown>} */ (ctx.params));
            return await this.#registerGateRequest("session/request_permission", entry, ctx.signal);
        });

        app.onRequest(methods.client.elicitation.create, async (ctx) => {
            await this.#notificationChain;
            const entry = buildElicitationGate(/** @type {Record<string, unknown>} */ (ctx.params));
            return await this.#registerGateRequest("elicitation/create", entry, ctx.signal);
        });

        const conn = app.connect(stream);
        this.#conn = conn;
        try {
            await conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-web", version: "2.1.0" },
                capabilities: {},
            });
        } catch (error) {
            const streamProblem = /** @type {SessionErrorPayload | undefined} */ (this.#streamProblem);
            this.close();
            if (streamProblem !== undefined && !signal.aborted) {
                throw Object.assign(new Error(streamProblem.message, { cause: streamProblem.problem }), {
                    status: streamProblem.status,
                    problem: streamProblem.problem,
                });
            }
            throw error;
        }
        return conn;
    }

    /**
     * @param {SessionRunOptions} [options]
     * @param {SessionSubscriber} [subscriber]
     */
    async resume(options = {}, subscriber = {}) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        const { signal } = controller;
        const heldGates = Array.isArray(options.gates) ? [...options.gates] : [];

        try {
            this.#gates.heldIds = heldGates.length > 0 ? heldGates : undefined;
            if (heldGates.length > 0 && this.#conn !== undefined) {
                const currentIds = this.pendingGates.map(({ id }) => id);
                const sameSet = currentIds.length === heldGates.length
                    && currentIds.every((id, idx) => id === heldGates[idx]);
                if (!sameSet) {
                    const stopReason = this.pendingGates.length > 0 ? "interrupt" : "end_turn";
                    await subscriber.onSettled?.({ stopReason, result: {} });
                    return { result: {}, stopReason };
                }
                const outcome = await this.#waitForLiveOutcome(signal);
                if (outcome.error) {
                    this.close();
                    await subscriber.onError?.(outcome.error);
                    return { result: undefined, stopReason: "error" };
                }
                if (outcome.stopReason === "eof") {
                    this.close();
                    return { result: {}, stopReason: "end_turn" };
                }
                await subscriber.onSettled?.({ stopReason: outcome.stopReason, meta: outcome.meta, result: {} });
                return { result: {}, stopReason: outcome.stopReason, meta: outcome.meta };
            }

            this.#gates.retainActive();
            this.#syncPendingGates();
            this.#queuedLiveOutcome = undefined;
            this.#pendingLiveThought = undefined;
            this.#bufferingReplay = true;
            this.#replayUpdates = [];
            this.#ambientCallIds.clear();
            this.#needsConnectionSse = false;
            const conn = await this.#ensureConnection(signal);

            const params = {
                sessionId: this.sessionId ?? "",
                cwd: "/",
                replayFrom: { type: /** @type {const} */ ("start") },
                _meta: {
                    plurnk: {
                        control: false,
                        window: true,
                        reasoning: "link",
                        ...(options.workspace ? { workspace: options.workspace } : {}),
                        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
                    },
                },
            };

            const response = /** @type {unknown} */ (
                await conn.agent.request(methods.agent.session.resume, params)
            );
            await this.#drainNotifications();
            const rawResult = isRecord(response) ? response : {};
            const metaPlurnk = isRecord(rawResult._meta) && isRecord(rawResult._meta.plurnk)
                ? rawResult._meta.plurnk
                : undefined;

            this.#applyResponseState(rawResult, metaPlurnk);
            if (Object.keys(this.state).length > 0) {
                await subscriber.onStateChanged?.({ state: this.state });
            }

            if (this.#bufferingReplay) {
                this.#bufferingReplay = false;
                const replayed = this.#replayUpdates.splice(0);
                const history = isRecord(metaPlurnk?.history) ? metaPlurnk.history : undefined;
                if (history !== undefined) {
                    this.messages = SessionTranslator.projectMessages(replayed, [], this.#ambientCallIds);
                    const older = typeof history.older === "string" ? history.older : null;
                    await subscriber.onMessagesSnapshot?.({
                        snapshot: {
                            messages: this.messages,
                            older,
                            hasMore: typeof history.hasMore === "boolean" ? history.hasMore : Boolean(older),
                            beforeLoopSeq: typeof history.beforeLoopSeq === "number" ? history.beforeLoopSeq : null,
                        },
                    });
                    await subscriber.onMessagesChanged?.({ messages: this.messages });
                } else {
                    for (const u of replayed) {
                        await this.#applyLiveMessageUpdate(u, subscriber);
                    }
                }
            }

            await this.#awaitGateCoalesce();

            if (this.pendingGates.length > 0) {
                this.#queuedLiveOutcome = undefined;
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: metaPlurnk, result: rawResult });
                return { result: rawResult, stopReason: "interrupt", meta: metaPlurnk };
            }

            const outcome = await this.#waitForLiveOutcome(signal);
            if (outcome.error) {
                this.close();
                await subscriber.onError?.(outcome.error);
                return { result: undefined, stopReason: "error", meta: outcome.meta };
            }
            if (outcome.stopReason === "eof") {
                this.close();
                return { result: rawResult, stopReason: "end_turn", meta: metaPlurnk };
            }
            const stopReason = outcome.stopReason;
            await subscriber.onSettled?.({ stopReason, meta: outcome.meta ?? metaPlurnk, result: rawResult });
            return { result: rawResult, stopReason, meta: outcome.meta ?? metaPlurnk };
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.#submittedPrompt = undefined;
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
        }
    }

    /**
     * @param {SessionRunOptions} [options]
     * @param {SessionSubscriber} [subscriber]
     */
    async send(options = {}, subscriber = {}) {
        if (options.action) {
            return await this.#runAction(options, subscriber);
        }
        if (Array.isArray(options.resolutions) && options.resolutions.length > 0) {
            return await this.#runGateResolutions(options.resolutions, options, subscriber);
        }
        if (options.message) {
            return await this.#runPrompt(options.message, options, subscriber);
        }
        return await this.resume(options, subscriber);
    }

    /**
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runAction(options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        const { signal } = controller;
        const rawAction = options.action ?? {};
        const { kind, params: nestedParams, ...rest } = rawAction;
        const actionParams = isRecord(nestedParams) ? nestedParams : rest;
        const actionKind = typeof kind === "string" ? kind : "";
        const needsConnSse = !this.sessionId || actionKind === "session/new" || actionKind === "providers/list" || actionKind === "session/list";
        if (needsConnSse && !this.#needsConnectionSse && this.#conn !== undefined) {
            this.close();
        }
        this.#needsConnectionSse = needsConnSse;
        const hadConn = this.#conn !== undefined && this.#connController !== undefined && !this.#connController.signal.aborted;

        try {
            const conn = await this.#ensureConnection(signal);
            let response;
            if (actionKind === "session/new") {
                response = await conn.agent.request(methods.agent.session.new, {
                    cwd: "/",
                    _meta: {
                        plurnk: {
                            ...(this.sessionId ? { session: this.sessionId } : {}),
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/set_config_option") {
                const configId = String(actionParams.configId ?? "");
                const value = String(actionParams.value ?? "");
                response = await conn.agent.request(methods.agent.session.setConfigOption, {
                    sessionId: this.sessionId ?? "user",
                    type: "id",
                    configId,
                    value,
                    _meta: {
                        plurnk: {
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/resume") {
                response = await conn.agent.request(methods.agent.session.resume, {
                    sessionId: this.sessionId ?? "user",
                    cwd: "/",
                    ...(actionParams.replayFrom !== undefined
                        ? { replayFrom: /** @type {import("@agentclientprotocol/sdk/experimental/v2/unstable").ReplayFrom | null} */ (actionParams.replayFrom) }
                        : {}),
                    _meta: {
                        plurnk: {
                            control: false,
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/fork") {
                response = await conn.agent.request(methods.agent.session.fork, {
                    sessionId: this.sessionId ?? "user",
                    cwd: "/",
                    ...(typeof actionParams.name === "string" ? { title: actionParams.name } : {}),
                    _meta: {
                        plurnk: {
                            ...(typeof actionParams.name === "string" ? { name: actionParams.name } : {}),
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/cancel") {
                await conn.agent.notify(methods.agent.session.cancel, {
                    sessionId: this.sessionId ?? "user",
                    ...(typeof actionParams.reason === "string"
                        ? { _meta: { plurnk: { reason: actionParams.reason } } }
                        : {}),
                });
                response = { cancelled: true };
            } else if (actionKind === "session/list") {
                response = await conn.agent.request(methods.agent.session.list, {
                    cwd: typeof actionParams.cwd === "string" ? actionParams.cwd : undefined,
                    ...(isRecord(actionParams._meta) ? { _meta: actionParams._meta } : {}),
                });
            } else if (actionKind === "session/delete") {
                response = await conn.agent.request(methods.agent.session.delete, {
                    sessionId: typeof actionParams.sessionId === "string" ? actionParams.sessionId : (this.sessionId ?? "user"),
                });
            } else if (actionKind === "providers/list") {
                response = await conn.agent.request(methods.agent.providers.list, {});
            } else {
                response = await conn.agent.request("_plurnk/action", {
                    kind: actionKind,
                    params: actionParams,
                    ...(this.sessionId ? { sessionId: this.sessionId } : {}),
                    ...(options.workspace ? { workspace: options.workspace } : {}),
                    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                });
            }
            await this.#drainNotifications();
            const rawResult = isRecord(response) ? response : {};
            const metaPlurnk = isRecord(rawResult._meta) && isRecord(rawResult._meta.plurnk)
                ? rawResult._meta.plurnk
                : undefined;
            this.#applyResponseState(rawResult, metaPlurnk);
            if (Object.keys(this.state).length > 0) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            const result = Object.hasOwn(rawResult, "ok")
                ? rawResult
                : { kind: actionKind, ok: true, result: response };
            await subscriber.onSettled?.({ stopReason: "end_turn", meta: metaPlurnk, result });
            return { result, stopReason: "end_turn", meta: metaPlurnk };
        } catch (error) {
            return await this.#handleError(error, signal, subscriber, actionKind);
        } finally {
            this.#submittedPrompt = undefined;
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
            if (!hadConn) {
                this.close();
            }
        }
    }

    /**
     * @param {{ id: string, role: "user", content: string }} message
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runPrompt(message, options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        this.#bufferingReplay = false;
        this.#replayUpdates = [];
        this.#pendingLiveThought = undefined;
        this.#submittedPrompt = { id: message.id, content: message.content };
        this.#queuedLiveOutcome = undefined;
        this.#gates.heldIds = undefined;
        this.#gates.retainActive();
        this.#syncPendingGates();
        const { signal } = controller;

        try {
            this.#needsConnectionSse = false;
            const conn = await this.#ensureConnection(signal);
            const params = {
                sessionId: this.sessionId ?? "user",
                messageId: message.id,
                prompt: [{ type: /** @type {const} */ ("text"), text: message.content }],
                _meta: {
                    plurnk: {
                        messageId: message.id,
                        reasoning: "link",
                        ...(options.workspace ? { workspace: options.workspace } : {}),
                        ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                    },
                },
            };

            const requestPromise = conn.agent.request(methods.agent.session.prompt, params).then((res) => {
                const rawResult = /** @type {Record<string, unknown>} */ (isRecord(res) ? res : {});
                const metaPlurnk = isRecord(rawResult._meta) && isRecord(rawResult._meta.plurnk)
                    ? rawResult._meta.plurnk
                    : undefined;
                return { result: rawResult, meta: metaPlurnk };
            });
            this.#inFlightRequest = requestPromise;
            void requestPromise.then(
                () => {
                    if (this.#inFlightRequest === requestPromise) {
                        this.#inFlightRequest = undefined;
                    }
                },
                () => {
                    if (this.#inFlightRequest === requestPromise) {
                        this.#inFlightRequest = undefined;
                    }
                },
            );

            return await this.#awaitRequestOrInterrupt(requestPromise, signal, subscriber);
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.#submittedPrompt = undefined;
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
        }
    }

    /**
     * @param {readonly GateResolution[]} resolutions
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runGateResolutions(resolutions, options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        this.#bufferingReplay = false;
        this.#replayUpdates = [];
        this.#gates.submittedIds.clear();
        this.#gates.cancelledSubmitted.clear();
        this.#queuedLiveOutcome = undefined;
        this.#gates.heldIds = undefined;
        const { signal } = controller;

        try {
            this.#needsConnectionSse = false;
            await this.#ensureConnection(signal);
            let missingGate = false;
            const plurnkState = isRecord(this.state.plurnk) ? this.state.plurnk : undefined;
            const statusState = isRecord(plurnkState?.status) ? plurnkState.status : undefined;
            const rawParts = typeof this.sessionId === "string" ? this.sessionId.split("#") : [];
            const boundName = typeof statusState?.name === "string" ? statusState.name : (rawParts[1] || "user");
            const boundId = typeof statusState?.id === "number" ? String(statusState.id) : "";
            let resolvedDescendantOnly = resolutions.length > 0;
            for (const res of resolutions) {
                const existing = this.#gates.allPending.find((item) => item.id === res.id);
                if (existing) {
                    const key = gateSessionKey(existing);
                    if (!key || key === boundName || key === boundId) {
                        resolvedDescendantOnly = false;
                    }
                } else {
                    resolvedDescendantOnly = false;
                }
            }

            for (const res of resolutions) {
                const gate = this.#gates.resolvers.get(res.id);
                this.#gates.allPending = this.#gates.allPending.filter((item) => item.id !== res.id);
                if (!gate) {
                    missingGate = true;
                    continue;
                }
                this.#gates.resolvers.delete(res.id);
                this.#gates.submittedIds.add(res.id);
                gate.resolve(/** @type {Record<string, unknown>} */ (res.response));
            }

            const gatesChanged = this.#syncPendingGates();

            if (missingGate) {
                await subscriber.onError?.({
                    message: "Request is no longer pending.",
                    settled: true,
                });
            }

            if (this.pendingGates.length === 0 && this.#inFlightRequest !== undefined) {
                return await this.#awaitRequestOrInterrupt(this.#inFlightRequest, signal, subscriber);
            }

            const boundLifecycle = typeof statusState?.lifecycle === "string" ? statusState.lifecycle : "idle";
            if (
                (resolvedDescendantOnly && !["queued", "running", "parked"].includes(boundLifecycle))
                || this.pendingGates.length > 0
            ) {
                await new Promise((r) => setTimeout(r));
                await this.#outboundPostChain;
                await this.#drainNotifications();
                if (gatesChanged && !this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
                if (this.#gates.cancelledSubmitted.size > 0 && !missingGate) {
                    await subscriber.onError?.({
                        message: "Request is no longer pending.",
                        settled: true,
                    });
                }
                const nextStop = this.pendingGates.length > 0 ? "interrupt" : "end_turn";
                if (nextStop === "interrupt") {
                    this.#queuedLiveOutcome = undefined;
                }
                await subscriber.onSettled?.({ stopReason: nextStop, result: {} });
                return { result: {}, stopReason: nextStop };
            }

            const outcome = await this.#waitForLiveOutcome(signal);
            await this.#outboundPostChain;
            await this.#drainNotifications();
            if (outcome.error) {
                this.close();
                await subscriber.onError?.(outcome.error);
                return { result: undefined, stopReason: "error", meta: outcome.meta };
            }
            if (outcome.stopReason === "eof") {
                this.close();
                return { result: {}, stopReason: "end_turn", meta: outcome.meta };
            }
            if (this.#gates.cancelledSubmitted.size > 0 && !missingGate) {
                await subscriber.onError?.({
                    message: "Request is no longer pending.",
                    settled: true,
                });
            }
            const stopReason = outcome.stopReason;
            const terminalFailure = extractTerminalFailure(outcome.meta, stopReason);
            if (terminalFailure) {
                await subscriber.onError?.(terminalFailure);
            } else {
                await subscriber.onSettled?.({ stopReason, meta: outcome.meta, result: {} });
            }
            return { result: {}, stopReason, meta: outcome.meta };
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.#submittedPrompt = undefined;
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
        }
    }

    /**
     * @param {Promise<{ result: unknown, meta?: Record<string, unknown> }>} requestPromise
     * @param {AbortSignal} signal
     * @param {SessionSubscriber} subscriber
     */
    async #awaitRequestOrInterrupt(requestPromise, signal, subscriber) {
        const outcomePromise = this.#waitForLiveOutcome(signal);
        const raced = await Promise.race([
            requestPromise.then((res) => ({ kind: /** @type {const} */ ("response"), ...res })),
            outcomePromise.then((out) => ({ kind: /** @type {const} */ ("outcome"), ...out })),
        ]);

        if (raced.kind === "outcome") {
            void requestPromise.catch(() => undefined);
            this.#onLiveOutcome = undefined;
            if (raced.error) {
                this.close();
                await subscriber.onError?.(raced.error);
                return { result: undefined, stopReason: "error", meta: raced.meta };
            }
            if (raced.stopReason === "interrupt") {
                if (this.#queuedLiveOutcome?.stopReason === "interrupt") {
                    this.#queuedLiveOutcome = undefined;
                }
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: raced.meta, result: {} });
                return { result: {}, stopReason: "interrupt", meta: raced.meta };
            }
            if (raced.stopReason === "eof") {
                this.close();
                return { result: undefined, stopReason: "end_turn", meta: raced.meta };
            }
        }

        const { result, meta: initialMeta } = raced.kind === "response"
            ? raced
            : await requestPromise;
        await this.#drainNotifications();
        const rawResult = isRecord(result) ? result : {};
        let metaPlurnk = initialMeta;
        this.#applyResponseState(rawResult, metaPlurnk);
        if (Object.keys(this.state).length > 0) {
            await subscriber.onStateChanged?.({ state: this.state });
        }

        await this.#awaitGateCoalesce();

        /** @type {Awaited<typeof outcomePromise> | undefined} */
        let liveOutcome = raced.kind === "outcome" ? raced : undefined;
        const hasImmediateOutcome = typeof rawResult.stopReason === "string"
            || typeof metaPlurnk?.stopReason === "string"
            || metaPlurnk?.terminal !== undefined
            || this.pendingGates.length > 0;
        if (liveOutcome === undefined && !hasImmediateOutcome) {
            liveOutcome = await outcomePromise;
        }
        this.#onLiveOutcome = undefined;

        if (liveOutcome !== undefined) {
            if (liveOutcome.error) {
                this.close();
                await subscriber.onError?.(liveOutcome.error);
                return { result: undefined, stopReason: "error", meta: liveOutcome.meta };
            }
            if (liveOutcome.meta) {
                metaPlurnk = metaPlurnk ? { ...metaPlurnk, ...liveOutcome.meta } : liveOutcome.meta;
                this.#applyResponseState(rawResult, metaPlurnk);
                if (Object.keys(this.state).length > 0) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
        }

        if (this.#gates.cancelledSubmitted.size > 0) {
            await subscriber.onError?.({
                message: "Request is no longer pending.",
                settled: true,
            });
        }

        if (liveOutcome?.stopReason === "eof" && !hasImmediateOutcome) {
            this.close();
            return { result: rawResult, stopReason: "end_turn", meta: metaPlurnk };
        }
        const rawStopReason = this.pendingGates.length > 0
            ? "interrupt"
            : typeof liveOutcome?.stopReason === "string"
                ? liveOutcome.stopReason
                : typeof metaPlurnk?.stopReason === "string"
                    ? metaPlurnk.stopReason
                    : typeof rawResult.stopReason === "string"
                        ? rawResult.stopReason
                        : "end_turn";
        const stopReason = rawStopReason === "eof" ? "end_turn" : rawStopReason;
        if (stopReason === "interrupt" && this.#queuedLiveOutcome?.stopReason === "interrupt") {
            this.#queuedLiveOutcome = undefined;
        }
        const terminalFailure = extractTerminalFailure(metaPlurnk, stopReason);
        if (terminalFailure) {
            await subscriber.onError?.(terminalFailure);
        } else {
            await subscriber.onSettled?.({
                stopReason,
                meta: metaPlurnk,
                result: rawResult,
            });
        }
        return { result: rawResult, stopReason, meta: metaPlurnk };
    }

    /**
     * @param {AbortSignal} signal
     * @returns {Promise<{ stopReason: string, meta?: Record<string, unknown>, error?: SessionErrorPayload }>}
     */
    #waitForLiveOutcome(signal) {
        if (this.#queuedLiveOutcome !== undefined) {
            const outcome = this.#queuedLiveOutcome;
            this.#queuedLiveOutcome = undefined;
            if (outcome.transportError !== undefined) {
                return Promise.reject(outcome.transportError);
            }
            return Promise.resolve(outcome);
        }
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                if (this.#onLiveOutcome === settle) {
                    this.#onLiveOutcome = undefined;
                }
                reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : new DOMException("The operation was aborted.", "AbortError"),
                );
            };
            /** @param {LiveOutcome} outcome */
            const settle = (outcome) => {
                signal.onabort = null;
                if (this.#onLiveOutcome === settle) {
                    this.#onLiveOutcome = undefined;
                }
                if (outcome.transportError !== undefined) {
                    reject(outcome.transportError);
                    return;
                }
                resolve(outcome);
            };
            this.#onLiveOutcome = settle;
            signal.onabort = onAbort;
            if (signal.aborted) {
                onAbort();
            }
        });
    }

    /**
     * @param {Record<string, unknown>} rawResult
     * @param {Record<string, unknown> | undefined} metaPlurnk
     */
    #applyResponseState(rawResult, metaPlurnk) {
        const projected = applyResponseState(
            this.state,
            rawResult,
            metaPlurnk,
            (descendants) => this.#gates.pruneFromDescendants(descendants, this.#cancelGateById),
        );
        this.state = projected.state;
        if (projected.appliedMeta) {
            this.#syncDescendantGates();
        }
    }

    /**
     * @param {unknown} error
     * @param {AbortSignal} signal
     * @param {SessionSubscriber} subscriber
     * @param {string} [actionKind]
     */
    async #handleError(error, signal, subscriber, actionKind) {
        if (signal.aborted && this.#streamProblem === undefined) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError");
        }
        await this.#drainNotifications();
        if (signal.aborted && this.#streamProblem === undefined) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError");
        }
        if (this.#streamProblem === undefined && error instanceof Error && error.message === "ACP session SSE stream closed") {
            this.close();
            return { result: undefined, stopReason: "end_turn" };
        }
        if (this.#streamProblem !== undefined) {
            const sp = this.#streamProblem;
            this.#streamProblem = undefined;
            if (sp.status === 401) {
                throw Object.assign(new Error(sp.message, { cause: sp.problem }), {
                    status: 401,
                    problem: sp.problem,
                });
            }
            if (sp.problem !== undefined) {
                await subscriber.onError?.(sp);
                const errorResult = actionKind !== undefined
                    ? { kind: actionKind, ok: false, problem: sp.problem }
                    : undefined;
                return { result: errorResult, stopReason: "error" };
            }
            throw Object.assign(new Error(sp.message), { status: sp.status });
        }
        const { message, status, problem, terminal } = extractRpcFailure(error);
        if (status === 401) {
            throw Object.assign(new Error(message, { cause: problem }), { status: 401, problem });
        }
        if (problem !== undefined || terminal !== undefined) {
            await subscriber.onError?.({ message, status, problem, terminal });
            const errorResult = actionKind !== undefined && problem !== undefined
                ? { kind: actionKind, ok: false, problem }
                : undefined;
            return { result: errorResult, stopReason: "error" };
        }
        throw error;
    }

    /** @param {SessionSubscriber} subscriber */
    async #finalizeLiveThought(subscriber) {
        const pending = this.#pendingLiveThought;
        if (!pending) return;
        this.#pendingLiveThought = undefined;
        const idx = this.messages.findIndex((m) => m.id === pending.messageId && m.role === "reasoning");
        const found = idx !== -1 ? this.messages[idx] : undefined;
        if (!found || (isRecord(found._meta?.plurnk) && found._meta.plurnk.body !== undefined)) {
            return;
        }
        const updated = {
            ...found,
            _meta: {
                ...found._meta,
                plurnk: {
                    ...(isRecord(found._meta?.plurnk) ? found._meta.plurnk : {}),
                    body: pending.body,
                },
            },
        };
        this.messages = this.messages.with(idx, updated);
        await subscriber.onMessagesChanged?.({ messages: this.messages });
    }

    /**
     * @param {AcpSessionUpdatePayload} update
     * @param {SessionSubscriber} subscriber
     */
    async #applyLiveMessageUpdate(update, subscriber) {
        const kind = update.sessionUpdate;
        const plurnk = isRecord(update._meta) && isRecord(update._meta.plurnk)
            ? update._meta.plurnk
            : undefined;
        if (kind === "user_message_chunk" && typeof update.messageId === "string") {
            await subscriber.onUserMessage?.({ messageId: update.messageId });
        }
        let projectedUpdate = update;
        if (kind === "agent_thought_chunk") {
            const id = typeof update.messageId === "string" && update.messageId.length > 0
                ? update.messageId
                : typeof plurnk?.coordinate === "string"
                    ? `${plurnk.coordinate}/reasoning`
                    : "";
            if (this.#pendingLiveThought && this.#pendingLiveThought.messageId !== id) {
                await this.#finalizeLiveThought(subscriber);
            }
            const isResourceLink = isRecord(update.content) && update.content.type === "resource_link";
            if (isResourceLink) {
                this.#pendingLiveThought = undefined;
            } else if (id && isRecord(plurnk?.body)) {
                this.#pendingLiveThought = { messageId: id, body: structuredClone(plurnk.body) };
                const { body: _body, ...restPlurnk } = plurnk;
                projectedUpdate = {
                    ...update,
                    _meta: {
                        ...(isRecord(update._meta) ? update._meta : {}),
                        plurnk: restPlurnk,
                    },
                };
            }
            if (
                isRecord(update.content)
                && update.content.type === "text"
                && typeof update.content.text === "string"
                && update.content.text.length > 0
            ) {
                await subscriber.onThoughtChunk?.({ update });
            }
        } else if (
            kind === "agent_message_chunk"
            || kind === "tool_call"
            || kind === "tool_call_update"
        ) {
            await this.#finalizeLiveThought(subscriber);
        }
        this.messages = SessionTranslator.projectMessages([projectedUpdate], this.messages, this.#ambientCallIds);
        await subscriber.onMessagesChanged?.({ messages: this.messages });
    }

    /**
     * @param {string} sessionId
     * @param {AcpSessionUpdatePayload} update
     * @param {SessionSubscriber} subscriber
     */
    async #handleSessionUpdate(sessionId, update, subscriber) {
        const kind = update.sessionUpdate;
        if (!(this.#bufferingReplay && kind === "agent_thought_chunk")) {
            await subscriber.onSessionUpdate?.({ update, sessionId });
        }
        const plurnk = isRecord(update._meta) && isRecord(update._meta.plurnk)
            ? update._meta.plurnk
            : undefined;

        if (kind === "config_option_update") {
            this.state = applyConfigOptionUpdate(this.state, update, plurnk);
            if (!this.#bufferingReplay) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            return;
        }

        if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
            this.state = applyAvailableCommandsUpdate(this.state, update.availableCommands);
            if (!this.#bufferingReplay) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            return;
        }

        if (kind === "usage_update") {
            this.state = applyUsageUpdate(this.state, update, plurnk);
            if (!this.#bufferingReplay) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            return;
        }

        if (kind === "subagent_update") {
            const childId = typeof plurnk?.id === "number" ? plurnk.id : undefined;
            const childName = typeof plurnk?.name === "string"
                ? plurnk.name
                : typeof update.title === "string"
                    ? update.title
                    : undefined;
            if (childId === undefined || childName === undefined) return;
            const stateObj = isRecord(update.state) ? update.state : {};
            const rawLifecycle = typeof plurnk?.lifecycle === "string"
                ? plurnk.lifecycle
                : stateObj.state === "running" || stateObj.state === "requires_action"
                    ? "running"
                    : stateObj.stopReason === "cancelled"
                        ? "cancelled"
                        : stateObj.stopReason === "refusal" || stateObj.stopReason === "error"
                            ? "failed"
                            : "completed";
            const coord = typeof plurnk?.coordinate === "string"
                ? plurnk.coordinate.split("#")[1]
                : undefined;
            this.#gates.cancelForSubagent(childId, childName, stateObj.state, coord, this.#cancelGateById);
            if (Array.isArray(plurnk?.gates)) {
                this.#gates.pruneFromDescendants([{ id: childId, name: childName, gates: plurnk.gates }], this.#cancelGateById);
            }
            this.state = applySubagentState(this.state, childId, childName, rawLifecycle, plurnk);
            this.#syncDescendantGates();
            if (!this.#bufferingReplay) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            return;
        }

        if (kind === "state_update") {
            if (update.state === "running" || update.state === "idle") {
                this.#gates.cancelForBoundSession(
                    this.state,
                    this.sessionId,
                    this.#bufferingReplay,
                    this.#inFlightPostCount,
                    this.#cancelGateById,
                );
            }
            await this.#finalizeLiveThought(subscriber);
            const projected = applyLifecycleStateUpdate(this.state, update, plurnk);
            if (projected.changed) {
                this.state = projected.state;
                if (!this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
            if (update.state === "idle" && isRecord(plurnk?.terminal)) {
                const stopReason = typeof update.stopReason === "string" ? update.stopReason : "end_turn";
                const terminalFailure = extractTerminalFailure(plurnk, stopReason);
                if (terminalFailure) {
                    this.#emitLiveOutcome({
                        stopReason: "error",
                        meta: plurnk,
                        error: terminalFailure,
                    });
                } else {
                    this.#emitLiveOutcome({
                        stopReason,
                        meta: plurnk,
                    });
                }
            }
            return;
        }

        if (kind === "notice" || kind === "_plurnk_telemetry") {
            const notice = isRecord(plurnk?.notice) ? plurnk.notice : undefined;
            if (notice?.kind === "turn_generated" || typeof plurnk?.id === "number") {
                await this.#finalizeLiveThought(subscriber);
            }
            if (isRecord(plurnk?.status)) {
                if (Array.isArray(plurnk.status.descendants)) {
                    this.#gates.pruneFromDescendants(plurnk.status.descendants, this.#cancelGateById);
                }
                if (Array.isArray(plurnk.status.inbox) && this.#submittedPrompt !== undefined) {
                    const submitted = this.#submittedPrompt;
                    const inboxItem = plurnk.status.inbox.find((item) => isRecord(item) && item.id === submitted.id);
                    if (isRecord(inboxItem) && !this.messages.some((m) => m.id === submitted.id && m.role === "user")) {
                        this.messages = SessionTranslator.projectMessages([{
                            sessionUpdate: "user_message_chunk",
                            messageId: submitted.id,
                            content: { type: "text", text: submitted.content },
                            _meta: {
                                plurnk: {
                                    loopId: inboxItem.loopId,
                                    lifecycle: inboxItem.lifecycle,
                                    published: false,
                                    ...(isRecord(inboxItem.body) ? { body: structuredClone(inboxItem.body) } : {}),
                                },
                            },
                        }], this.messages, this.#ambientCallIds);
                        if (!this.#bufferingReplay) {
                            await subscriber.onMessagesChanged?.({ messages: this.messages });
                        }
                    }
                }
            }
            const projected = applyNoticeStateUpdate(this.state, plurnk);
            if (projected.changed) {
                this.state = projected.state;
                this.#syncDescendantGates();
                if (!this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
            if (update.severity === "error" && isRecord(plurnk?.problem)) {
                const problem = plurnk.problem;
                const status = typeof problem.status === "number" ? problem.status : undefined;
                const message = typeof problem.detail === "string"
                    ? problem.detail
                    : typeof problem.title === "string"
                        ? problem.title
                        : "Stream error.";
                if (!this.#bufferingReplay) {
                    this.#streamProblem = { message, status, problem };
                }
                if (status === 401 || this.#gates.submittedIds.size > 0) {
                    this.#streamProblem = { message, status, problem };
                    this.#emitLiveOutcome({
                        stopReason: "error",
                        error: { message, status, problem },
                    });
                }
            }
            return;
        }

        if (kind === "terminal_update") {
            const projected = applyTerminalStreamUpdate(this.state, update, plurnk);
            if (projected.changed) {
                this.state = projected.state;
                if (!this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
            return;
        }

        if (
            kind === "user_message_chunk"
            || kind === "agent_message_chunk"
            || kind === "agent_thought_chunk"
            || kind === "tool_call"
            || kind === "tool_call_update"
        ) {
            if (kind === "tool_call" || kind === "tool_call_update") {
                this.#gates.cancelForToolUpdate(update, this.#cancelGateById);
            }
            if (this.#bufferingReplay) {
                this.#replayUpdates.push(update);
                return;
            }
            if (kind === "tool_call_update" && (plurnk?.proposal !== undefined || plurnk?.interaction !== undefined)) {
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: plurnk, result: {} });
            }
            await this.#applyLiveMessageUpdate(update, subscriber);
        }
    }
}
