import {
    SessionGateBook,
    syncDescendantGatesInState,
} from "./session-gates.js";
import {
    applyAvailableCommandsUpdate,
    applyConfigOptionUpdate,
    applyLifecycleStateUpdate,
    applyNoticeStateUpdate,
    applyPromptSuggestionsUpdate,
    applyResponseState,
    applySubagentState,
    applyTerminalStreamUpdate,
    applyUsageUpdate,
} from "./session-state-projection.js";
import { extractTerminalFailure } from "./session-transport.js";
import { SessionTranslator, isRecord } from "./session-translator.js";

const GATE_COALESCE_MS = 10;

/** @typedef {import("./session-translator.js").Message} Message */
/** @typedef {import("./session-translator.js").AcpSessionUpdatePayload} AcpSessionUpdatePayload */
/** @typedef {import("./session-translator.js").MessagesSnapshot} MessagesSnapshot */
/** @typedef {import("./session-gates.js").SessionGate} SessionGate */
/** @typedef {import("./session-transport.js").SessionErrorPayload} SessionErrorPayload */
/** @typedef {import("./session-transport.js").LiveOutcome} LiveOutcome */

/**
 * @typedef {{
 *   name: string,
 *   mimeType: string,
 *   data: string,
 * }} PromptImageAttachment
 */

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
 * {§web-session-observer} {§web-session-reasoning} {§web-session-approval} {§web-session-questions}
 * Stateful ACP notification intake, replay window buffer, live-thought finalizer, and gate coordinator.
 */
export class SessionUpdateTracker {
    /** @type {SessionGateBook} */
    gates = new SessionGateBook();
    /** @type {boolean} */
    replaying = false;
    /** @type {boolean} */
    resuming = false;
    /** @type {AcpSessionUpdatePayload[]} */
    replayUpdates = [];
    /** @type {AcpSessionUpdatePayload[]} */
    postReplayUpdates = [];
    /** @type {Set<string>} */
    ambientCallIds = new Set();
    /** @type {{ messageId: string, body: Record<string, unknown> } | undefined} */
    pendingLiveThought = undefined;
    /** @type {{ id: string, content: string, attachments?: readonly PromptImageAttachment[] } | undefined} */
    submittedPrompt = undefined;

    #host;

    /**
     * @param {{
     *   readonly getState: () => Record<string, unknown>,
     *   readonly setState: (state: Record<string, unknown>) => void,
     *   readonly getMessages: () => Message[],
     *   readonly setMessages: (messages: Message[]) => void,
     *   readonly getPendingGates: () => SessionGate[],
     *   readonly setPendingGates: (gates: SessionGate[]) => void,
     *   readonly getSessionId: () => string | null,
     *   readonly isConnAborted: () => boolean,
     *   readonly getNotificationChain: () => Promise<void>,
     *   readonly hasInFlightRequest: () => boolean,
     *   readonly getInFlightPostCount: () => number,
     *   readonly getStreamProblem: () => SessionErrorPayload | undefined,
     *   readonly setStreamProblem: (problem: SessionErrorPayload | undefined) => void,
     *   readonly emitLiveOutcome: (outcome: LiveOutcome) => void,
     *   readonly getSubscriber: () => SessionSubscriber,
     * }} host
     */
    constructor(host) {
        this.#host = host;
    }

    reset() {
        this.gates.reset();
        this.#host.setPendingGates([]);
        this.replaying = false;
        this.resuming = false;
        this.replayUpdates = [];
        this.postReplayUpdates = [];
        this.ambientCallIds.clear();
        this.pendingLiveThought = undefined;
        this.submittedPrompt = undefined;
    }

    finishRun() {
        this.replaying = false;
        this.resuming = false;
        this.submittedPrompt = undefined;
    }

    beginReplayWindow() {
        this.replaying = true;
        this.resuming = true;
        this.replayUpdates = [];
        this.postReplayUpdates = [];
        this.ambientCallIds.clear();
    }

    /**
     * @param {{ id: string, content: string, attachments?: readonly PromptImageAttachment[] }} message
     */
    beginPromptRun(message) {
        this.replaying = false;
        this.resuming = false;
        this.replayUpdates = [];
        this.postReplayUpdates = [];
        this.pendingLiveThought = undefined;
        this.submittedPrompt = {
            id: message.id,
            content: message.content,
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        };
        this.gates.heldIds = undefined;
        this.gates.retainActive();
        this.syncPendingGates();
    }

    beginGateResolutionRun() {
        this.replaying = false;
        this.resuming = false;
        this.replayUpdates = [];
        this.postReplayUpdates = [];
        this.gates.submittedIds.clear();
        this.gates.cancelledSubmitted.clear();
        this.gates.heldIds = undefined;
    }

    syncDescendantGates() {
        const synced = syncDescendantGatesInState(this.#host.getState(), this.gates.allPending);
        if (synced.changed) {
            this.#host.setState(synced.state);
        }
        return synced.changed;
    }

    syncPendingGates() {
        const synced = this.gates.sync(this.#host.getState());
        this.#host.setPendingGates(synced.pending);
        if (synced.changed) {
            this.#host.setState(synced.state);
        }
        return synced.changed;
    }

    /**
     * @param {Record<string, unknown>} rawResult
     * @param {Record<string, unknown> | undefined} metaPlurnk
     */
    applyResponseState(rawResult, metaPlurnk) {
        const projected = applyResponseState(
            this.#host.getState(),
            rawResult,
            metaPlurnk,
            (descendants) => this.gates.pruneFromDescendants(descendants, this.cancelGateById),
        );
        this.#host.setState(projected.state);
        if (projected.appliedMeta) {
            this.syncDescendantGates();
        }
    }

    scheduleGateCoalesce() {
        if (this.gates.coalesceTimer !== undefined) {
            clearTimeout(this.gates.coalesceTimer);
        }
        this.gates.coalesceTimer = setTimeout(() => {
            this.gates.coalesceTimer = undefined;
            void this.#host.getNotificationChain().then(async () => {
                if (this.#host.isConnAborted()) return;
                this.syncPendingGates();
                if (!this.resuming) {
                    await this.#host.getSubscriber().onStateChanged?.({ state: this.#host.getState() });
                }
                this.gates.onSettled?.();
                const held = this.gates.heldIds;
                const pendingGates = this.#host.getPendingGates();
                const currentIds = pendingGates.map(({ id }) => id);
                const sameHeld = held !== undefined
                    && held.length === currentIds.length
                    && currentIds.every((id, idx) => id === held[idx]);
                if (!sameHeld && pendingGates.length > 0) {
                    this.#host.emitLiveOutcome({ stopReason: "interrupt" });
                }
            });
        }, GATE_COALESCE_MS);
    }

    async awaitGateCoalesce() {
        if (this.gates.coalesceTimer === undefined) return;
        await new Promise((r) => {
            this.gates.onSettled = () => {
                this.gates.onSettled = undefined;
                r(undefined);
            };
        });
    }

    /** @param {string} gateId */
    cancelGateById = (gateId) => {
        const existed = this.gates.resolvers.has(gateId)
            || this.gates.allPending.some((item) => item.id === gateId);
        if (!existed) return;
        this.gates.resolvers.delete(gateId);
        this.gates.allPending = this.gates.allPending.filter((item) => item.id !== gateId);
        const changed = this.syncPendingGates();
        if (this.gates.submittedIds.has(gateId)) {
            this.gates.cancelledSubmitted.add(gateId);
        }
        if (this.#host.isConnAborted()) {
            return;
        }
        setTimeout(() => {
            void this.#host.getNotificationChain().then(async () => {
                if (this.#host.isConnAborted() || this.#host.getStreamProblem() !== undefined) return;
                if (changed && !this.resuming) {
                    await this.#host.getSubscriber().onStateChanged?.({ state: this.#host.getState() });
                }
                if (this.#host.getPendingGates().length > 0) {
                    this.#host.emitLiveOutcome({ stopReason: "interrupt" });
                } else if (this.gates.heldIds !== undefined) {
                    this.#host.emitLiveOutcome({ stopReason: "end_turn" });
                } else if (!this.#host.hasInFlightRequest()) {
                    const state = this.#host.getState();
                    const status = isRecord(state.plurnk) && isRecord(state.plurnk.status)
                        ? state.plurnk.status
                        : undefined;
                    const lifecycle = typeof status?.lifecycle === "string" ? status.lifecycle : "idle";
                    if (!["queued", "running", "parked"].includes(lifecycle)) {
                        this.#host.emitLiveOutcome({ stopReason: "end_turn" });
                    }
                }
            });
        });
    };

    /**
     * @param {"session/request_permission" | "elicitation/create"} method
     * @param {SessionGate} entry
     * @param {AbortSignal} signal
     */
    registerGateRequest(method, entry, signal) {
        this.gates.allPending.push(entry);
        this.syncPendingGates();
        return new Promise((resolve, reject) => {
            this.gates.resolvers.set(entry.id, {
                method,
                resolve: (res) => {
                    signal.onabort = null;
                    resolve(/** @type {never} */ (res));
                },
                reject: (err) => {
                    signal.onabort = null;
                    reject(err);
                },
            });
            const onCancel = () => {
                this.cancelGateById(entry.id);
                reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            signal.onabort = onCancel;
            this.scheduleGateCoalesce();
        });
    }

    /**
     * Flush buffered replay + post-replay updates when `session/resume` settles.
     * @param {Record<string, unknown> | undefined} metaPlurnk
     * @param {SessionSubscriber} subscriber
     */
    async flushResumeWindow(metaPlurnk, subscriber) {
        if (!this.resuming) return;
        this.replaying = false;
        this.resuming = false;
        const replayed = this.replayUpdates.splice(0);
        const postReplay = this.postReplayUpdates.splice(0);
        const history = isRecord(metaPlurnk?.history) ? metaPlurnk.history : undefined;
        if (history !== undefined) {
            const projectedMessages = SessionTranslator.projectMessages(replayed, [], this.ambientCallIds);
            this.#host.setMessages(projectedMessages);
            const older = typeof history.older === "string" ? history.older : null;
            await subscriber.onMessagesSnapshot?.({
                snapshot: {
                    messages: projectedMessages,
                    older,
                    hasMore: typeof history.hasMore === "boolean" ? history.hasMore : Boolean(older),
                    beforeLoopSeq: typeof history.beforeLoopSeq === "number" ? history.beforeLoopSeq : null,
                },
            });
            await subscriber.onMessagesChanged?.({ messages: projectedMessages });
        } else {
            for (const u of replayed) {
                await this.applyLiveMessageUpdate(u, subscriber);
            }
        }
        for (const u of postReplay) {
            const uPlurnk = isRecord(u._meta) && isRecord(u._meta.plurnk) ? u._meta.plurnk : undefined;
            if (u.sessionUpdate === "tool_call_update" && (uPlurnk?.proposal !== undefined || uPlurnk?.interaction !== undefined)) {
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: uPlurnk, result: {} });
            }
            await this.applyLiveMessageUpdate(u, subscriber);
        }
    }

    /** @param {SessionSubscriber} subscriber */
    async finalizeLiveThought(subscriber) {
        const pending = this.pendingLiveThought;
        this.pendingLiveThought = undefined;
        let changed = false;
        const nextMessages = this.#host.getMessages().map((item) => {
            if (item.role !== "reasoning") return item;
            const itemPlurnk = isRecord(item._meta?.plurnk) ? item._meta.plurnk : undefined;
            const matchesPending = pending !== undefined && item.id === pending.messageId && itemPlurnk?.body === undefined;
            const wasStreaming = itemPlurnk?.streaming === true;
            if (!matchesPending && !wasStreaming) return item;
            changed = true;
            const { streaming: _streaming, ...restPlurnk } = itemPlurnk ?? {};
            return {
                ...item,
                _meta: {
                    ...item._meta,
                    plurnk: {
                        ...restPlurnk,
                        ...(matchesPending ? { body: pending.body } : {}),
                    },
                },
            };
        });
        if (changed) {
            this.#host.setMessages(nextMessages);
            await subscriber.onMessagesChanged?.({ messages: nextMessages });
        }
    }

    /**
     * @param {AcpSessionUpdatePayload} update
     * @param {SessionSubscriber} subscriber
     */
    async applyLiveMessageUpdate(update, subscriber) {
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
            if (this.pendingLiveThought && this.pendingLiveThought.messageId !== id) {
                await this.finalizeLiveThought(subscriber);
            }
            const isResourceLink = isRecord(update.content) && update.content.type === "resource_link";
            if (isResourceLink) {
                this.pendingLiveThought = undefined;
            } else if (id && isRecord(plurnk?.body)) {
                this.pendingLiveThought = { messageId: id, body: structuredClone(plurnk.body) };
                const { body: _body, ...restPlurnk } = plurnk;
                projectedUpdate = {
                    ...update,
                    _meta: {
                        ...(isRecord(update._meta) ? update._meta : {}),
                        plurnk: { ...restPlurnk, streaming: true },
                    },
                };
            } else if (
                isRecord(update.content)
                && update.content.type === "text"
                && typeof update.content.text === "string"
                && update.content.text.length > 0
            ) {
                projectedUpdate = {
                    ...update,
                    _meta: {
                        ...(isRecord(update._meta) ? update._meta : {}),
                        plurnk: { ...(plurnk ?? {}), streaming: true },
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
            await this.finalizeLiveThought(subscriber);
        }
        const nextMessages = SessionTranslator.projectMessages([projectedUpdate], this.#host.getMessages(), this.ambientCallIds);
        this.#host.setMessages(nextMessages);
        await subscriber.onMessagesChanged?.({ messages: nextMessages });
    }

    /**
     * @param {string} sessionId
     * @param {AcpSessionUpdatePayload} update
     * @param {SessionSubscriber} subscriber
     */
    async handleSessionUpdate(sessionId, update, subscriber) {
        const kind = update.sessionUpdate;
        if (!(this.replaying && kind === "agent_thought_chunk")) {
            await subscriber.onSessionUpdate?.({ update, sessionId });
        }
        if (kind === "replay_complete") {
            this.replaying = false;
            return;
        }
        const plurnk = isRecord(update._meta) && isRecord(update._meta.plurnk)
            ? update._meta.plurnk
            : undefined;

        if (kind === "config_option_update") {
            const nextState = applyConfigOptionUpdate(this.#host.getState(), update, plurnk);
            this.#host.setState(nextState);
            if (!this.resuming) {
                await subscriber.onStateChanged?.({ state: nextState });
            }
            return;
        }

        if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
            const nextState = applyAvailableCommandsUpdate(this.#host.getState(), update.availableCommands);
            this.#host.setState(nextState);
            if (!this.resuming) {
                await subscriber.onStateChanged?.({ state: nextState });
            }
            return;
        }

        if (kind === "prompt_suggestions_update" && Array.isArray(update.suggestions)) {
            const nextState = applyPromptSuggestionsUpdate(this.#host.getState(), update.suggestions);
            this.#host.setState(nextState);
            if (!this.resuming) {
                await subscriber.onStateChanged?.({ state: nextState });
            }
            return;
        }

        if (kind === "usage_update") {
            const nextState = applyUsageUpdate(this.#host.getState(), update, plurnk);
            this.#host.setState(nextState);
            if (!this.resuming) {
                await subscriber.onStateChanged?.({ state: nextState });
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
            this.gates.cancelForSubagent(childId, childName, stateObj.state, coord, this.cancelGateById);
            if (Array.isArray(plurnk?.gates)) {
                this.gates.pruneFromDescendants([{ id: childId, name: childName, gates: plurnk.gates }], this.cancelGateById);
            }
            this.#host.setState(applySubagentState(this.#host.getState(), childId, childName, rawLifecycle, plurnk));
            this.syncDescendantGates();
            if (!this.resuming) {
                await subscriber.onStateChanged?.({ state: this.#host.getState() });
            }
            return;
        }

        if (kind === "state_update") {
            if (update.state === "running" || update.state === "idle") {
                this.gates.cancelForBoundSession(
                    this.#host.getState(),
                    this.#host.getSessionId(),
                    this.resuming,
                    this.#host.getInFlightPostCount(),
                    this.cancelGateById,
                );
            }
            await this.finalizeLiveThought(subscriber);
            const projected = applyLifecycleStateUpdate(this.#host.getState(), update, plurnk);
            if (projected.changed) {
                this.#host.setState(projected.state);
                if (!this.resuming) {
                    await subscriber.onStateChanged?.({ state: projected.state });
                }
            }
            if (update.state === "idle" && isRecord(plurnk?.terminal)) {
                const stopReason = typeof update.stopReason === "string" ? update.stopReason : "end_turn";
                const terminalFailure = extractTerminalFailure(plurnk, stopReason);
                if (terminalFailure) {
                    this.#host.emitLiveOutcome({
                        stopReason: "error",
                        meta: plurnk,
                        error: terminalFailure,
                    });
                } else {
                    this.#host.emitLiveOutcome({
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
                await this.finalizeLiveThought(subscriber);
            }
            if (isRecord(plurnk?.status)) {
                if (Array.isArray(plurnk.status.descendants)) {
                    this.gates.pruneFromDescendants(plurnk.status.descendants, this.cancelGateById);
                }
                if (Array.isArray(plurnk.status.inbox) && this.submittedPrompt !== undefined) {
                    const submitted = this.submittedPrompt;
                    const inboxItem = plurnk.status.inbox.find((item) => isRecord(item) && item.id === submitted.id);
                    const curMessages = this.#host.getMessages();
                    if (isRecord(inboxItem) && !curMessages.some((m) => m.id === submitted.id && m.role === "user")) {
                        const unobservedPlurnk = {
                            loopId: inboxItem.loopId,
                            lifecycle: inboxItem.lifecycle,
                            published: false,
                            ...(isRecord(inboxItem.body) ? { body: structuredClone(inboxItem.body) } : {}),
                        };
                        /** @type {AcpSessionUpdatePayload[]} */
                        const unobservedUpdates = [];
                        if (submitted.content.length > 0 || !submitted.attachments?.length) {
                            unobservedUpdates.push({
                                sessionUpdate: "user_message_chunk",
                                messageId: submitted.id,
                                content: { type: "text", text: submitted.content },
                                _meta: { plurnk: unobservedPlurnk },
                            });
                        }
                        for (const attachment of submitted.attachments ?? []) {
                            unobservedUpdates.push({
                                sessionUpdate: "user_message_chunk",
                                messageId: submitted.id,
                                content: {
                                    type: "image",
                                    mimeType: attachment.mimeType,
                                    data: attachment.data,
                                    uri: `file:///${encodeURIComponent(attachment.name)}`,
                                },
                                _meta: { plurnk: unobservedPlurnk },
                            });
                        }
                        const nextMessages = SessionTranslator.projectMessages(unobservedUpdates, curMessages, this.ambientCallIds);
                        this.#host.setMessages(nextMessages);
                        if (!this.resuming) {
                            await subscriber.onMessagesChanged?.({ messages: nextMessages });
                        }
                    }
                }
            }
            const projected = applyNoticeStateUpdate(this.#host.getState(), plurnk);
            if (projected.changed) {
                this.#host.setState(projected.state);
                this.syncDescendantGates();
                if (!this.resuming) {
                    await subscriber.onStateChanged?.({ state: this.#host.getState() });
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
                if (!this.replaying) {
                    this.#host.setStreamProblem({ message, status, problem });
                }
                if (status === 401 || this.gates.submittedIds.size > 0) {
                    this.#host.setStreamProblem({ message, status, problem });
                    this.#host.emitLiveOutcome({
                        stopReason: "error",
                        error: { message, status, problem },
                    });
                }
            }
            return;
        }

        if (kind === "terminal_update") {
            const projected = applyTerminalStreamUpdate(this.#host.getState(), update, plurnk);
            if (projected.changed) {
                this.#host.setState(projected.state);
                if (!this.resuming) {
                    await subscriber.onStateChanged?.({ state: projected.state });
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
                this.gates.cancelForToolUpdate(update, this.cancelGateById);
            }
            if (this.replaying) {
                this.replayUpdates.push(update);
                return;
            }
            if (this.resuming) {
                this.postReplayUpdates.push(update);
                return;
            }
            if (kind === "tool_call_update" && (plurnk?.proposal !== undefined || plurnk?.interaction !== undefined)) {
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: plurnk, result: {} });
            }
            await this.applyLiveMessageUpdate(update, subscriber);
        }
    }
}
