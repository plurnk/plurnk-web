// {§web-browser-security} No dynamic code generation in the browser.
import "./schema-validation.js";
import {
    PROTOCOL_VERSION,
    client,
    methods,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { acpUrl, recordDaemonPolicy, recordServiceVersion } from "./endpoints.js";
import {
    SessionOutcomeQueue,
    awaitRequestOrInterrupt,
    executeGateResolutions,
} from "./session-agent-runs.js";
import { SessionUpdateTracker } from "./session-agent-updates.js";
import {
    buildElicitationGate,
    buildPermissionGate,
} from "./session-gates.js";
import {
    buildMonitoredWebSocketConfig,
    buildPromptBlocks,
    executeAgentAction,
    normalizeSessionRunError,
    probeWebSocketAuthFailure,
} from "./session-rpc.js";
import {
    SessionTranslator,
    isRecord,
    randomUUID,
} from "./session-translator.js";
import {
    createAcpFetch,
    resolveAcpUrl,
} from "./session-transport.js";

export {
    PROTOCOL_VERSION,
    SessionTranslator,
    buildPromptBlocks,
    client,
    createHttpStream,
    createWebSocketStream,
    methods,
    randomUUID,
};

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
/** @typedef {import("./session-agent-updates.js").PromptImageAttachment} PromptImageAttachment */
/** @typedef {import("./session-agent-updates.js").SessionSubscriber} SessionSubscriber */

/**
 * @typedef {{
 *   abortController?: AbortController,
 *   message?: { id: string, role: "user", content: string, attachments?: readonly PromptImageAttachment[], openPaths?: readonly string[] },
 *   resolutions?: readonly GateResolution[],
 *   action?: Record<string, unknown>,
 *   workspace?: string,
 *   projectRoot?: string,
 *   gates?: readonly string[],
 *   openPaths?: readonly string[],
 *   proposalPolicy?: "review" | "accept" | "reject",
 * }} SessionRunOptions
 */

const CLIENT_INFO = Object.freeze({ name: "@plurnk/plurnk-web", version: "5.0.0" });

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
    /** @type {AbortController | undefined} */
    #activeController = undefined;
    /** @type {SessionUpdateTracker} */
    #updates;
    /** @type {SessionOutcomeQueue} */
    #outcomes = new SessionOutcomeQueue();
    /** @type {number} */
    #inFlightPostCount = 0;
    /** @type {Promise<void>} */
    #outboundPostChain = Promise.resolve();
    /** @type {Promise<{ result: unknown, meta?: Record<string, unknown> }> | undefined} */
    #inFlightRequest = undefined;
    /** @type {SessionErrorPayload | undefined} */
    #streamProblem = undefined;
    /** @type {boolean} */
    #needsConnectionSse = false;
    /** @type {string} */
    #connAuth = "";
    /** @type {"http" | "ws"} */
    #transport = "http";

    /**
     * @param {{
     *   url?: string,
     *   sessionId?: string | null,
     *   headers?: Record<string, string>,
     *   state?: Record<string, unknown>,
     *   messages?: Message[],
     *   fetch?: typeof globalThis.fetch,
     *   transport?: "http" | "ws",
     * }} [config]
     */
    constructor(config = {}) {
        this.url = config.url ?? acpUrl();
        this.sessionId = config.sessionId ?? null;
        this.headers = { ...config.headers };
        this.#transport = config.transport === "ws" && typeof globalThis.WebSocket === "function" ? "ws" : "http";
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
        /** @type {boolean} */
        this.promptImageSupported = false;
        /** @type {boolean} */
        this.promptSkillSupported = false;
        /** @type {string | null} */
        this.serviceVersion = null;
        this.#fetch = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
        this.#updates = new SessionUpdateTracker({
            getState: () => this.state,
            setState: (next) => { this.state = next; },
            getMessages: () => this.messages,
            setMessages: (next) => { this.messages = next; },
            getPendingGates: () => this.pendingGates,
            setPendingGates: (next) => { this.pendingGates = next; },
            getSessionId: () => this.sessionId,
            isConnAborted: () => Boolean(this.#connController?.signal.aborted),
            getNotificationChain: () => this.#notificationChain,
            hasInFlightRequest: () => this.#inFlightRequest !== undefined,
            getInFlightPostCount: () => this.#inFlightPostCount,
            getStreamProblem: () => this.#streamProblem,
            setStreamProblem: (problem) => { this.#streamProblem = problem; },
            emitLiveOutcome: (outcome) => this.#outcomes.emit(outcome),
            getSubscriber: () => this.#subscriber,
        });
    }

    abortRun() {
        this.#activeController?.abort();
        this.abortController?.abort();
    }

    close() {
        this.#updates.reset();
        this.#outcomes.reset();
        this.#inFlightRequest = undefined;
        this.#streamProblem = undefined;
        this.#connController?.abort();
        this.#connController = undefined;
        this.#connAuth = "";
        const prev = this.#conn;
        this.#conn = undefined;
        if (prev) {
            prev.close();
        }
    }

    async #drainNotifications() {
        await new Promise((resolve) => setTimeout(resolve));
        await this.#notificationChain;
    }

    /** @param {AbortSignal} signal */
    async #ensureConnection(signal) {
        const currentAuth = (this.headers.Authorization ?? this.headers.authorization ?? "").trim();
        const wsAuthStale = this.#transport === "ws"
            && ((this.#connAuth !== "" && currentAuth === "")
                || (currentAuth !== this.#connAuth && this.pendingGates.length === 0));
        if (
            !wsAuthStale
            && this.#conn !== undefined
            && this.#connController !== undefined
            && !this.#connController.signal.aborted
        ) {
            return this.#conn;
        }
        this.close();
        this.#connAuth = currentAuth;
        const connController = new AbortController();
        this.#connController = connController;
        this.#streamProblem = undefined;

        /** @type {ReturnType<typeof createHttpStream>} */
        let stream;
        let wsOpened = false;
        if (this.#transport === "ws") {
            const { href, WebSocketClass } = buildMonitoredWebSocketConfig({
                baseUrl: this.url,
                headers: this.headers,
                connSignal: connController.signal,
                getNotificationChain: () => this.#notificationChain,
                getStreamProblem: () => this.#streamProblem,
                emitLiveOutcome: (outcome) => this.#outcomes.emit(outcome),
                onOpened: () => { wsOpened = true; },
                onCancelRequest: () => {
                    for (const id of this.#updates.gates.submittedIds) {
                        this.#updates.gates.cancelledSubmitted.add(id);
                    }
                },
            });
            stream = createWebSocketStream(href, {
                WebSocket: WebSocketClass,
                cookies: "omit",
            });
        } else {
            const acpFetch = createAcpFetch({
                fetchImpl: this.#fetch,
                getHeaders: () => this.headers,
                getSessionId: () => this.sessionId,
                needsConnectionSse: () => this.#needsConnectionSse,
                connSignal: connController.signal,
                getNotificationChain: () => this.#notificationChain,
                getStreamProblem: () => this.#streamProblem,
                setStreamProblem: (problem) => { this.#streamProblem = problem; },
                emitLiveOutcome: (outcome) => this.#outcomes.emit(outcome),
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

            stream = createHttpStream(resolveAcpUrl(this.url), {
                fetch: acpFetch,
                headers: this.headers,
                cookies: "omit",
            });
        }

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
                await this.#updates.handleSessionUpdate(sessionId, update, this.#subscriber);
            });
        });

        app.onNotification(methods.client.elicitation.complete, (ctx) => {
            const elicitationId = isRecord(ctx.params) && typeof ctx.params.elicitationId === "string"
                ? ctx.params.elicitationId
                : "";
            this.#updates.gates.completeElicitation(elicitationId, this.#updates.cancelGateById);
        });

        app.onRequest(methods.client.session.requestPermission, async (ctx) => {
            await this.#notificationChain;
            const entry = buildPermissionGate(/** @type {Record<string, unknown>} */ (ctx.params));
            return await this.#updates.registerGateRequest("session/request_permission", entry, ctx.signal);
        });

        app.onRequest(methods.client.elicitation.create, async (ctx) => {
            await this.#notificationChain;
            const entry = buildElicitationGate(/** @type {Record<string, unknown>} */ (ctx.params));
            return await this.#updates.registerGateRequest("elicitation/create", entry, ctx.signal);
        });

        const conn = app.connect(stream);
        this.#conn = conn;
        try {
            const initRes = /** @type {unknown} */ (await conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-web", version: "5.0.0" },
                capabilities: {
                    session: {
                        commands: {
                            skill: {},
                        },
                        promptSuggestions: {},
                    },
                },
            }));
            const initRecord = isRecord(initRes) ? initRes : {};
            const infoRecord = isRecord(initRecord.info) ? initRecord.info : {};
            if (typeof infoRecord.version === "string" && infoRecord.version.trim() !== "") {
                this.serviceVersion = infoRecord.version.trim();
                recordServiceVersion(this.serviceVersion);
            }
            const initMeta = isRecord(initRecord._meta) && isRecord(initRecord._meta.plurnk)
                ? initRecord._meta.plurnk
                : null;
            if (initMeta) {
                recordDaemonPolicy(initMeta.policy);
            }
            const capabilities = isRecord(initRecord.capabilities) ? initRecord.capabilities : {};
            const sessionCaps = isRecord(capabilities.session) ? capabilities.session : {};
            const promptCaps = isRecord(sessionCaps.prompt) ? sessionCaps.prompt : {};
            const skillCaps = isRecord(promptCaps.skill) ? promptCaps.skill : {};
            this.promptImageSupported = isRecord(promptCaps.image) || promptCaps.image === true;
            this.promptSkillSupported = isRecord(skillCaps.inline) || skillCaps.inline === true;
        } catch (error) {
            const streamProblem = /** @type {SessionErrorPayload | undefined} */ (this.#streamProblem);
            this.close();
            if (streamProblem !== undefined && !signal.aborted) {
                throw Object.assign(new Error(streamProblem.message, { cause: streamProblem.problem }), {
                    status: streamProblem.status,
                    problem: streamProblem.problem,
                });
            }
            if (this.#transport === "ws" && !wsOpened && !signal.aborted) {
                await probeWebSocketAuthFailure({
                    fetchImpl: this.#fetch,
                    url: this.url,
                    headers: this.headers,
                    protocolVersion: PROTOCOL_VERSION,
                    clientInfo: CLIENT_INFO,
                    signal,
                });
            }
            if (!(error instanceof Error)) {
                throw new Error("ACP WebSocket connection failed.", { cause: error });
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
            this.#updates.gates.heldIds = heldGates.length > 0 ? heldGates : undefined;
            if (heldGates.length > 0 && this.#conn !== undefined) {
                const currentIds = this.pendingGates.map(({ id }) => id);
                const sameSet = currentIds.length === heldGates.length
                    && currentIds.every((id, idx) => id === heldGates[idx]);
                if (!sameSet) {
                    const stopReason = this.pendingGates.length > 0 ? "interrupt" : "end_turn";
                    await subscriber.onSettled?.({ stopReason, result: {} });
                    return { result: {}, stopReason };
                }
                const outcome = await this.#outcomes.waitForLiveOutcome(signal);
                await this.#drainNotifications();
                if (outcome.error || this.#streamProblem !== undefined) {
                    const sp = outcome.error ?? this.#streamProblem;
                    this.#streamProblem = undefined;
                    this.close();
                    if (sp) await subscriber.onError?.(sp);
                    return { result: undefined, stopReason: "error", meta: outcome.meta };
                }
                if (outcome.stopReason === "eof") {
                    this.close();
                    return { result: {}, stopReason: "end_turn" };
                }
                await subscriber.onSettled?.({ stopReason: outcome.stopReason, meta: outcome.meta, result: {} });
                return { result: {}, stopReason: outcome.stopReason, meta: outcome.meta };
            }

            this.#updates.gates.retainActive();
            this.#updates.syncPendingGates();
            this.#outcomes.clearQueued();
            this.#updates.pendingLiveThought = undefined;
            this.#needsConnectionSse = false;
            const conn = await this.#ensureConnection(signal);
            this.#updates.beginReplayWindow();

            const params = {
                sessionId: this.sessionId ?? "",
                cwd: "/",
                replayFrom: { type: /** @type {const} */ ("start") },
                _meta: {
                    plurnk: {
                        control: false,
                        window: true,
                        reasoning: "link",
                        bodies: "link",
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

            this.#updates.applyResponseState(rawResult, metaPlurnk);
            if (Object.keys(this.state).length > 0) {
                await subscriber.onStateChanged?.({ state: this.state });
            }

            await this.#updates.flushResumeWindow(metaPlurnk, subscriber);
            await this.#updates.awaitGateCoalesce();

            if (this.pendingGates.length > 0) {
                this.#outcomes.clearQueued();
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: metaPlurnk, result: rawResult });
                return { result: rawResult, stopReason: "interrupt", meta: metaPlurnk };
            }

            const outcome = await this.#outcomes.waitForLiveOutcome(signal);
            if (outcome.error) {
                this.close();
                await subscriber.onError?.(outcome.error);
                return { result: undefined, stopReason: "error", meta: outcome.meta };
            }
            if (outcome.stopReason === "eof") {
                await this.#drainNotifications();
                if (this.#streamProblem !== undefined) {
                    const sp = this.#streamProblem;
                    this.close();
                    await subscriber.onError?.(sp);
                    return { result: undefined, stopReason: "error", meta: outcome.meta };
                }
                this.close();
                return { result: rawResult, stopReason: "end_turn", meta: metaPlurnk };
            }
            const stopReason = outcome.stopReason;
            await subscriber.onSettled?.({ stopReason, meta: outcome.meta ?? metaPlurnk, result: rawResult });
            return { result: rawResult, stopReason, meta: outcome.meta ?? metaPlurnk };
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.#updates.finishRun();
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
            const response = await executeAgentAction(
                {
                    request: (method, params) => conn.agent.request(method, params),
                    notify: (method, params) => conn.agent.notify(method, params),
                },
                methods.agent,
                {
                    sessionId: this.sessionId,
                    actionKind,
                    actionParams,
                    workspace: options.workspace,
                    projectRoot: options.projectRoot,
                },
            );
            await this.#drainNotifications();
            const rawResult = isRecord(response) ? response : {};
            const metaPlurnk = isRecord(rawResult._meta) && isRecord(rawResult._meta.plurnk)
                ? rawResult._meta.plurnk
                : undefined;
            this.#updates.applyResponseState(rawResult, metaPlurnk);
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
            this.#updates.finishRun();
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
     * @param {{ id: string, role: "user", content: string, attachments?: readonly PromptImageAttachment[], openPaths?: readonly string[] }} message
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runPrompt(message, options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        this.#outcomes.clearQueued();
        this.#updates.beginPromptRun(message);
        const { signal } = controller;

        try {
            this.#needsConnectionSse = false;
            const conn = await this.#ensureConnection(signal);
            /** @type {import("@agentclientprotocol/sdk/experimental/v2/unstable").ContentBlock[]} */
            const promptBlocks = [];
            const availableCommands = isRecord(this.state.plurnk) && Array.isArray(this.state.plurnk.availableCommands)
                ? this.state.plurnk.availableCommands
                : [];
            if (message.content.length > 0 || !message.attachments?.length) {
                if (this.promptSkillSupported) {
                    promptBlocks.push(...buildPromptBlocks(message.content, availableCommands));
                } else {
                    promptBlocks.push({ type: /** @type {const} */ ("text"), text: message.content });
                }
            }
            for (const attachment of message.attachments ?? []) {
                promptBlocks.push({
                    type: /** @type {const} */ ("image"),
                    mimeType: attachment.mimeType,
                    data: attachment.data,
                    uri: `file:///${encodeURIComponent(attachment.name)}`,
                });
            }
            const openPaths = options.openPaths?.length ? options.openPaths : message.openPaths;
            const params = {
                sessionId: this.sessionId ?? "session1",
                messageId: message.id,
                prompt: promptBlocks,
                _meta: {
                    plurnk: {
                        messageId: message.id,
                        reasoning: "link",
                        bodies: "link",
                        ...(options.workspace ? { workspace: options.workspace } : {}),
                        ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        ...(openPaths?.length ? { openPaths: [...openPaths] } : {}),
                        ...(options.proposalPolicy ? { proposalPolicy: options.proposalPolicy } : {}),
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

            return await awaitRequestOrInterrupt({
                requestPromise,
                signal,
                subscriber,
                outcomes: this.#outcomes,
                updates: this.#updates,
                drainNotifications: () => this.#drainNotifications(),
                getState: () => this.state,
                getPendingGates: () => this.pendingGates,
                close: () => this.close(),
            });
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.#updates.finishRun();
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
        this.#outcomes.clearQueued();
        this.#updates.beginGateResolutionRun();
        const { signal } = controller;

        try {
            this.#needsConnectionSse = false;
            await this.#ensureConnection(signal);
            return await executeGateResolutions({
                resolutions,
                signal,
                subscriber,
                sessionId: this.sessionId,
                outcomes: this.#outcomes,
                updates: this.#updates,
                getState: () => this.state,
                getPendingGates: () => this.pendingGates,
                getInFlightRequest: () => this.#inFlightRequest,
                getOutboundPostChain: () => this.#outboundPostChain,
                drainNotifications: () => this.#drainNotifications(),
                close: () => this.close(),
            });
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.#updates.finishRun();
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
        }
    }

    /**
     * @param {unknown} error
     * @param {AbortSignal} signal
     * @param {SessionSubscriber} subscriber
     * @param {string} [actionKind]
     */
    async #handleError(error, signal, subscriber, actionKind) {
        return await normalizeSessionRunError(error, {
            signal,
            drainNotifications: () => this.#drainNotifications(),
            getStreamProblem: () => this.#streamProblem,
            takeStreamProblem: () => {
                const sp = this.#streamProblem;
                this.#streamProblem = undefined;
                return sp;
            },
            closeConnection: () => this.close(),
            onError: subscriber.onError,
            actionKind,
        });
    }
}
