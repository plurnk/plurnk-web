import { gateSessionKey } from "./session-gates.js";
import { isRecord } from "./session-translator.js";
import { extractTerminalFailure } from "./session-transport.js";

/** @typedef {import("./session-agent-updates.js").SessionSubscriber} SessionSubscriber */
/** @typedef {import("./session-agent-updates.js").SessionUpdateTracker} SessionUpdateTracker */
/** @typedef {import("./session-gates.js").GateResolution} GateResolution */
/** @typedef {import("./session-gates.js").SessionGate} SessionGate */
/** @typedef {import("./session-transport.js").LiveOutcome} LiveOutcome */
/** @typedef {import("./session-transport.js").SessionErrorPayload} SessionErrorPayload */

/**
 * {§web-session-observer} Single-waiter live-outcome queue bridging transport SSE/WebSocket lifecycle events to ACP run promises.
 */
export class SessionOutcomeQueue {
    /** @type {((outcome: LiveOutcome) => void) | undefined} */
    #onLiveOutcome = undefined;
    /** @type {LiveOutcome | undefined} */
    #queuedLiveOutcome = undefined;

    reset() {
        this.#onLiveOutcome = undefined;
        this.#queuedLiveOutcome = undefined;
    }

    clearQueued() {
        this.#queuedLiveOutcome = undefined;
    }

    clearListener() {
        this.#onLiveOutcome = undefined;
    }

    clearQueuedInterrupt() {
        if (this.#queuedLiveOutcome?.stopReason === "interrupt") {
            this.#queuedLiveOutcome = undefined;
        }
    }

    /** @param {LiveOutcome} outcome */
    emit(outcome) {
        if (this.#onLiveOutcome !== undefined) {
            this.#onLiveOutcome(outcome);
        } else {
            this.#queuedLiveOutcome = outcome;
        }
    }

    /**
     * @param {AbortSignal} signal
     * @returns {Promise<{ stopReason: string, meta?: Record<string, unknown>, error?: SessionErrorPayload }>}
     */
    waitForLiveOutcome(signal) {
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
}

/**
 * {§web-session-observer} {§web-session-approval} {§web-session-questions}
 * Race an in-flight ACP prompt request against live transport interrupts/outcomes and reconcile state + terminal status.
 * @param {{
 *   readonly requestPromise: Promise<{ result: unknown, meta?: Record<string, unknown> }>,
 *   readonly signal: AbortSignal,
 *   readonly subscriber: SessionSubscriber,
 *   readonly outcomes: SessionOutcomeQueue,
 *   readonly updates: SessionUpdateTracker,
 *   readonly drainNotifications: () => Promise<void>,
 *   readonly getState: () => Record<string, unknown>,
 *   readonly getPendingGates: () => readonly SessionGate[],
 *   readonly close: () => void,
 * }} ctx
 */
export async function awaitRequestOrInterrupt({
    requestPromise,
    signal,
    subscriber,
    outcomes,
    updates,
    drainNotifications,
    getState,
    getPendingGates,
    close,
}) {
    const outcomePromise = outcomes.waitForLiveOutcome(signal);
    const raced = await Promise.race([
        requestPromise.then((res) => ({ kind: /** @type {const} */ ("response"), ...res })),
        outcomePromise.then((out) => ({ kind: /** @type {const} */ ("outcome"), ...out })),
    ]);

    if (raced.kind === "outcome") {
        void requestPromise.catch(() => undefined);
        outcomes.clearListener();
        if (raced.error) {
            close();
            await subscriber.onError?.(raced.error);
            return { result: undefined, stopReason: "error", meta: raced.meta };
        }
        if (raced.stopReason === "interrupt") {
            outcomes.clearQueuedInterrupt();
            await subscriber.onSettled?.({ stopReason: "interrupt", meta: raced.meta, result: {} });
            return { result: {}, stopReason: "interrupt", meta: raced.meta };
        }
        if (raced.stopReason === "eof") {
            close();
            return { result: undefined, stopReason: "end_turn", meta: raced.meta };
        }
    }

    const { result, meta: initialMeta } = raced.kind === "response"
        ? raced
        : await requestPromise;
    await drainNotifications();
    const rawResult = isRecord(result) ? result : {};
    let metaPlurnk = initialMeta;
    updates.applyResponseState(rawResult, metaPlurnk);
    if (Object.keys(getState()).length > 0) {
        await subscriber.onStateChanged?.({ state: getState() });
    }

    await updates.awaitGateCoalesce();

    /** @type {Awaited<typeof outcomePromise> | undefined} */
    let liveOutcome = raced.kind === "outcome" ? raced : undefined;
    const hasImmediateOutcome = typeof rawResult.stopReason === "string"
        || typeof metaPlurnk?.stopReason === "string"
        || metaPlurnk?.terminal !== undefined
        || getPendingGates().length > 0;
    if (liveOutcome === undefined && !hasImmediateOutcome) {
        liveOutcome = await outcomePromise;
    }
    outcomes.clearListener();

    if (liveOutcome !== undefined) {
        if (liveOutcome.error) {
            close();
            await subscriber.onError?.(liveOutcome.error);
            return { result: undefined, stopReason: "error", meta: liveOutcome.meta };
        }
        if (liveOutcome.meta) {
            metaPlurnk = metaPlurnk ? { ...metaPlurnk, ...liveOutcome.meta } : liveOutcome.meta;
            updates.applyResponseState(rawResult, metaPlurnk);
            if (Object.keys(getState()).length > 0) {
                await subscriber.onStateChanged?.({ state: getState() });
            }
        }
    }

    if (updates.gates.cancelledSubmitted.size > 0) {
        await subscriber.onError?.({
            message: "Request is no longer pending.",
            settled: true,
        });
    }

    if (liveOutcome?.stopReason === "eof" && !hasImmediateOutcome) {
        close();
        return { result: rawResult, stopReason: "end_turn", meta: metaPlurnk };
    }
    const rawStopReason = getPendingGates().length > 0
        ? "interrupt"
        : typeof liveOutcome?.stopReason === "string"
            ? liveOutcome.stopReason
            : typeof metaPlurnk?.stopReason === "string"
                ? metaPlurnk.stopReason
                : typeof rawResult.stopReason === "string"
                    ? rawResult.stopReason
                    : "end_turn";
    const stopReason = rawStopReason === "eof" ? "end_turn" : rawStopReason;
    if (stopReason === "interrupt") {
        outcomes.clearQueuedInterrupt();
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
 * {§web-session-approval} {§web-session-questions}
 * Submit pending gate resolutions over an active ACP connection and await turn completion or next interrupt.
 * @param {{
 *   readonly resolutions: readonly GateResolution[],
 *   readonly signal: AbortSignal,
 *   readonly subscriber: SessionSubscriber,
 *   readonly sessionId: string | null,
 *   readonly outcomes: SessionOutcomeQueue,
 *   readonly updates: SessionUpdateTracker,
 *   readonly getState: () => Record<string, unknown>,
 *   readonly getPendingGates: () => readonly SessionGate[],
 *   readonly getInFlightRequest: () => Promise<{ result: unknown, meta?: Record<string, unknown> }> | undefined,
 *   readonly getOutboundPostChain: () => Promise<void>,
 *   readonly drainNotifications: () => Promise<void>,
 *   readonly close: () => void,
 * }} ctx
 */
export async function executeGateResolutions({
    resolutions,
    signal,
    subscriber,
    sessionId,
    outcomes,
    updates,
    getState,
    getPendingGates,
    getInFlightRequest,
    getOutboundPostChain,
    drainNotifications,
    close,
}) {
    let missingGate = false;
    const state = getState();
    const plurnkState = isRecord(state.plurnk) ? state.plurnk : undefined;
    const statusState = isRecord(plurnkState?.status) ? plurnkState.status : undefined;
    const rawParts = typeof sessionId === "string" ? sessionId.split("#") : [];
    const boundName = typeof statusState?.name === "string" ? statusState.name : (rawParts[1] || "session1");
    const boundId = typeof statusState?.id === "number" ? String(statusState.id) : "";
    let resolvedDescendantOnly = resolutions.length > 0;
    for (const res of resolutions) {
        const existing = updates.gates.allPending.find((item) => item.id === res.id);
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
        const gate = updates.gates.resolvers.get(res.id);
        updates.gates.allPending = updates.gates.allPending.filter((item) => item.id !== res.id);
        if (!gate) {
            missingGate = true;
            continue;
        }
        updates.gates.resolvers.delete(res.id);
        updates.gates.submittedIds.add(res.id);
        gate.resolve(/** @type {Record<string, unknown>} */ (res.response));
    }

    const gatesChanged = updates.syncPendingGates();

    if (missingGate) {
        await subscriber.onError?.({
            message: "Request is no longer pending.",
            settled: true,
        });
    }

    const inFlightRequest = getInFlightRequest();
    if (getPendingGates().length === 0 && inFlightRequest !== undefined) {
        return await awaitRequestOrInterrupt({
            requestPromise: inFlightRequest,
            signal,
            subscriber,
            outcomes,
            updates,
            drainNotifications,
            getState,
            getPendingGates,
            close,
        });
    }

    const boundLifecycle = typeof statusState?.lifecycle === "string" ? statusState.lifecycle : "idle";
    if (
        (resolvedDescendantOnly && !["queued", "running", "parked"].includes(boundLifecycle))
        || getPendingGates().length > 0
    ) {
        await new Promise((r) => setTimeout(r));
        await getOutboundPostChain();
        await drainNotifications();
        if (gatesChanged && !updates.resuming) {
            await subscriber.onStateChanged?.({ state: getState() });
        }
        if (updates.gates.cancelledSubmitted.size > 0 && !missingGate) {
            await subscriber.onError?.({
                message: "Request is no longer pending.",
                settled: true,
            });
        }
        const nextStop = getPendingGates().length > 0 ? "interrupt" : "end_turn";
        if (nextStop === "interrupt") {
            outcomes.clearQueued();
        }
        await subscriber.onSettled?.({ stopReason: nextStop, result: {} });
        return { result: {}, stopReason: nextStop };
    }

    const outcome = await outcomes.waitForLiveOutcome(signal);
    await getOutboundPostChain();
    await drainNotifications();
    if (outcome.error) {
        close();
        await subscriber.onError?.(outcome.error);
        return { result: undefined, stopReason: "error", meta: outcome.meta };
    }
    if (outcome.stopReason === "eof") {
        close();
        return { result: {}, stopReason: "end_turn", meta: outcome.meta };
    }
    if (updates.gates.cancelledSubmitted.size > 0 && !missingGate) {
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
}
