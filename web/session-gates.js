import { isRecord, randomUUID } from "./session-translator.js";

/**
 * @typedef {{
 *   id: string,
 *   method: "session/request_permission",
 *   sessionId?: string,
 *   toolCall?: Record<string, unknown>,
 *   options?: readonly Record<string, unknown>[],
 *   expiresAt?: string,
 *   _meta?: {
 *     plurnk?: {
 *       proposal?: import("@plurnk/plurnk-contracts").ProposalProjection,
 *     },
 *   } | null,
 * }} PermissionGate
 */

/**
 * @typedef {{
 *   id: string,
 *   method: "elicitation/create",
 *   sessionId?: string,
 *   mode?: "form" | "url",
 *   message?: string,
 *   requestedSchema?: Record<string, unknown>,
 *   url?: string,
 *   elicitationId?: string,
 *   expiresAt?: string,
 *   _meta?: {
 *     plurnk?: {
 *       interaction?: import("@plurnk/plurnk-contracts").ClientInteractionProjection,
 *       toolName?: string,
 *       arguments?: unknown,
 *     },
 *   } | null,
 * }} ElicitationGate
 */

/**
 * @typedef {PermissionGate | ElicitationGate} SessionGate
 */

/**
 * @typedef {{
 *   id: string,
 *   method: "session/request_permission",
 *   response: {
 *     outcome: { outcome: "selected", optionId: string } | { outcome: "cancelled" },
 *     _meta?: Record<string, unknown>,
 *   },
 * } | {
 *   id: string,
 *   method: "elicitation/create",
 *   response: {
 *     action: "accept",
 *     content?: Record<string, unknown>,
 *   } | {
 *     action: "decline" | "cancel",
 *   },
 * }} GateResolution
 */

/**
 * @param {SessionGate} entry
 * @returns {string}
 */
export function gateSessionKey(entry) {
    if (entry.method === "session/request_permission") {
        const prop = entry._meta?.plurnk?.proposal;
        if (typeof prop?.session === "string") return prop.session;
        if (typeof prop?.sessionId === "number") return String(prop.sessionId);
        return "";
    }
    const inter = entry._meta?.plurnk?.interaction;
    if (typeof inter?.sessionId === "number") return String(inter.sessionId);
    return "";
}

/**
 * @param {Record<string, unknown>} params
 * @returns {PermissionGate}
 */
export function buildPermissionGate(params) {
    const metaPlurnk = isRecord(params._meta) && isRecord(params._meta.plurnk)
        ? params._meta.plurnk
        : undefined;
    const proposal = isRecord(metaPlurnk?.proposal) ? metaPlurnk.proposal : undefined;
    const logEntryId = typeof proposal?.logEntryId === "number" ? proposal.logEntryId : randomUUID();
    const gateId = `proposal:${logEntryId}:${randomUUID().slice(0, 8)}`;
    const rawExpires = proposal?.expiresAt;
    const expiresAt = typeof rawExpires === "number"
        ? new Date(rawExpires).toISOString()
        : typeof rawExpires === "string"
            ? rawExpires
            : undefined;
    return {
        id: gateId,
        method: "session/request_permission",
        ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
        ...(isRecord(params.toolCall) ? { toolCall: structuredClone(params.toolCall) } : {}),
        ...(Array.isArray(params.options) ? { options: structuredClone(params.options) } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(proposal !== undefined
            ? {
                _meta: {
                    plurnk: {
                        proposal: /** @type {import("@plurnk/plurnk-contracts").ProposalProjection} */ (
                            /** @type {unknown} */ (structuredClone(proposal))
                        ),
                    },
                },
            }
            : {}),
    };
}

/**
 * @param {Record<string, unknown>} params
 * @returns {ElicitationGate}
 */
export function buildElicitationGate(params) {
    const metaPlurnk = isRecord(params._meta) && isRecord(params._meta.plurnk)
        ? params._meta.plurnk
        : undefined;
    const interaction = isRecord(metaPlurnk?.interaction) ? metaPlurnk.interaction : undefined;
    const interactionId = typeof interaction?.interactionId === "number"
        ? interaction.interactionId
        : randomUUID();
    const gateId = `int:${interactionId}:${randomUUID().slice(0, 8)}`;
    const reqRecord = isRecord(interaction?.request) ? interaction.request : {};
    const message = typeof params.message === "string"
        ? params.message
        : typeof reqRecord.message === "string"
            ? reqRecord.message
            : undefined;
    const requestedSchema = isRecord(params.requestedSchema)
        ? params.requestedSchema
        : isRecord(reqRecord.requestedSchema)
            ? reqRecord.requestedSchema
            : undefined;
    const mode = params.mode === "url" ? "url" : "form";
    const rawExpires = interaction?.expiresAt;
    const expiresAt = typeof rawExpires === "number"
        ? new Date(rawExpires).toISOString()
        : typeof rawExpires === "string"
            ? rawExpires
            : undefined;

    return {
        id: gateId,
        method: "elicitation/create",
        ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
        mode,
        ...(message !== undefined ? { message } : {}),
        ...(requestedSchema !== undefined ? { requestedSchema: structuredClone(requestedSchema) } : {}),
        ...(typeof params.url === "string" ? { url: params.url } : {}),
        ...(typeof params.elicitationId === "string" ? { elicitationId: params.elicitationId } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(interaction !== undefined
            ? {
                _meta: {
                    plurnk: {
                        interaction: /** @type {import("@plurnk/plurnk-contracts").ClientInteractionProjection} */ (
                            /** @type {unknown} */ (structuredClone(interaction))
                        ),
                    },
                },
            }
            : {}),
    };
}

/**
 * @param {Record<string, unknown>} state
 * @param {readonly SessionGate[]} allPendingGates
 * @returns {{ changed: boolean, state: Record<string, unknown> }}
 */
export function syncDescendantGatesInState(state, allPendingGates) {
    const plurnk = isRecord(state.plurnk) ? state.plurnk : undefined;
    const status = isRecord(plurnk?.status) ? plurnk.status : undefined;
    if (!Array.isArray(status?.descendants)) return { changed: false, state };
    let changed = false;
    const nextDescendants = status.descendants.map((d) => {
        if (!isRecord(d)) return d;
        const matchingGates = [];
        for (const item of allPendingGates) {
            const prop = item.method === "session/request_permission"
                ? item._meta?.plurnk?.proposal
                : undefined;
            const inter = item.method === "elicitation/create"
                ? item._meta?.plurnk?.interaction
                : undefined;
            const matchesProp = isRecord(prop)
                && ((typeof d.id === "number" && prop.sessionId === d.id)
                    || (typeof d.name === "string" && prop.session === d.name));
            const matchesInter = isRecord(inter)
                && typeof d.id === "number" && inter.sessionId === d.id;
            if (matchesProp && prop !== undefined) {
                matchingGates.push(structuredClone(prop));
            } else if (matchesInter && inter !== undefined) {
                matchingGates.push(structuredClone(inter));
            }
        }
        const prevLen = Array.isArray(d.gates) ? d.gates.length : 0;
        if (prevLen !== matchingGates.length) {
            changed = true;
            return { ...d, gates: matchingGates };
        }
        return d;
    });
    if (!changed) return { changed: false, state };
    return {
        changed: true,
        state: {
            ...state,
            plurnk: {
                ...plurnk,
                status: {
                    ...status,
                    descendants: nextDescendants,
                },
            },
        },
    };
}

export class SessionGateBook {
    /**
     * @type {Map<string, {
     *   method: "session/request_permission" | "elicitation/create",
     *   resolve: (value: Record<string, unknown>) => void,
     *   reject: (reason?: unknown) => void,
     * }>}
     */
    resolvers = new Map();
    /** @type {Set<string>} */
    cancelledSubmitted = new Set();
    /** @type {Set<string>} */
    submittedIds = new Set();
    /** @type {SessionGate[]} */
    allPending = [];
    /** @type {SessionGate[]} */
    pending = [];
    /** @type {readonly string[] | undefined} */
    heldIds = undefined;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    coalesceTimer = undefined;
    /** @type {(() => void) | undefined} */
    onSettled = undefined;

    reset() {
        if (this.coalesceTimer !== undefined) {
            clearTimeout(this.coalesceTimer);
            this.coalesceTimer = undefined;
        }
        this.onSettled = undefined;
        this.heldIds = undefined;
        for (const [, entry] of this.resolvers) {
            entry.reject(new DOMException("The operation was aborted.", "AbortError"));
        }
        this.resolvers.clear();
        this.allPending = [];
        this.pending = [];
        this.submittedIds.clear();
        this.cancelledSubmitted.clear();
    }

    retainActive() {
        this.allPending = this.allPending.filter((item) => this.resolvers.has(item.id));
    }

    /**
     * @param {Record<string, unknown>} state
     * @returns {{ changed: boolean, state: Record<string, unknown>, pending: SessionGate[] }}
     */
    sync(state) {
        if (this.allPending.length === 0) {
            this.pending = [];
        } else if (
            this.heldIds !== undefined
            && this.heldIds.length > 0
            && this.heldIds.every((id) => this.allPending.some((item) => item.id === id))
        ) {
            this.pending = this.allPending.filter((item) => this.heldIds?.includes(item.id));
        } else {
            const firstSession = gateSessionKey(this.allPending[0]);
            this.pending = this.allPending.filter((item) => gateSessionKey(item) === firstSession);
        }
        const synced = syncDescendantGatesInState(state, this.allPending);
        return { ...synced, pending: this.pending };
    }

    /**
     * @param {readonly unknown[]} descendants
     * @param {(gateId: string) => void} cancelById
     */
    pruneFromDescendants(descendants, cancelById) {
        for (const item of [...this.allPending]) {
            const prop = item.method === "session/request_permission"
                ? item._meta?.plurnk?.proposal
                : undefined;
            const inter = item.method === "elicitation/create"
                ? item._meta?.plurnk?.interaction
                : undefined;
            const desc = descendants.find((d) => {
                if (!isRecord(d)) return false;
                if (typeof d.id === "number" && (prop?.sessionId === d.id || inter?.sessionId === d.id)) {
                    return true;
                }
                if (typeof d.name === "string" && prop?.session === d.name) {
                    return true;
                }
                return false;
            });
            if (isRecord(desc) && Array.isArray(desc.gates)) {
                const stillPending = desc.gates.some((g) => {
                    if (!isRecord(g)) return false;
                    if (typeof prop?.logEntryId === "number" && g.logEntryId === prop.logEntryId) return true;
                    if (typeof inter?.interactionId === "number" && g.interactionId === inter.interactionId) return true;
                    return false;
                });
                if (!stillPending) {
                    cancelById(item.id);
                }
            }
        }
    }

    /**
     * @param {string} elicitationId
     * @param {(gateId: string) => void} cancelById
     */
    completeElicitation(elicitationId, cancelById) {
        if (!elicitationId) return;
        for (const item of [...this.allPending]) {
            if (item.method === "elicitation/create" && item.elicitationId === elicitationId) {
                const resolver = this.resolvers.get(item.id);
                cancelById(item.id);
                resolver?.resolve({ action: "accept" });
            }
        }
    }

    /**
     * @param {number} childId
     * @param {string} childName
     * @param {unknown} stateName
     * @param {string | undefined} coord
     * @param {(gateId: string) => void} cancelById
     */
    cancelForSubagent(childId, childName, stateName, coord, cancelById) {
        if (stateName === "idle") {
            for (const item of [...this.allPending]) {
                const key = gateSessionKey(item);
                if (key === childName || key === String(childId)) {
                    cancelById(item.id);
                }
            }
        } else if (stateName === "running") {
            for (const item of [...this.allPending]) {
                const key = gateSessionKey(item);
                if (key !== childName && key !== String(childId)) continue;
                if (item.method === "session/request_permission") {
                    const prop = item._meta?.plurnk?.proposal;
                    if (coord !== undefined && prop?.coordinate === coord) {
                        cancelById(item.id);
                    }
                } else if (item.method === "elicitation/create") {
                    cancelById(item.id);
                }
            }
        }
    }

    /**
     * @param {Record<string, unknown>} state
     * @param {string | null} sessionId
     * @param {boolean} bufferingReplay
     * @param {number} inFlightPostCount
     * @param {(gateId: string) => void} cancelById
     */
    cancelForBoundSession(state, sessionId, bufferingReplay, inFlightPostCount, cancelById) {
        if (inFlightPostCount > 0 && this.submittedIds.size > 0) {
            for (const id of this.submittedIds) {
                this.cancelledSubmitted.add(id);
            }
        }
        if (bufferingReplay) {
            for (const item of [...this.allPending]) {
                cancelById(item.id);
            }
            return;
        }
        const plurnkState = isRecord(state.plurnk) ? state.plurnk : undefined;
        const statusState = isRecord(plurnkState?.status) ? plurnkState.status : undefined;
        const rawParts = typeof sessionId === "string" ? sessionId.split("#") : [];
        const boundName = typeof statusState?.name === "string" ? statusState.name : (rawParts[1] || "user");
        const boundId = typeof statusState?.id === "number" ? String(statusState.id) : "";
        for (const item of [...this.allPending]) {
            const key = gateSessionKey(item);
            if (!key || key === boundName || key === boundId) {
                cancelById(item.id);
            }
        }
    }

    /**
     * @param {Record<string, unknown>} update
     * @param {(gateId: string) => void} cancelById
     */
    cancelForToolUpdate(update, cancelById) {
        if (
            typeof update.toolCallId !== "string"
            || typeof update.status !== "string"
            || update.status === "pending"
        ) {
            return;
        }
        for (const item of [...this.allPending]) {
            if (item.method === "session/request_permission") {
                const prop = item._meta?.plurnk?.proposal;
                if (
                    prop?.coordinate === update.toolCallId
                    || (isRecord(item.toolCall) && item.toolCall.toolCallId === update.toolCallId)
                ) {
                    cancelById(item.id);
                }
            } else if (
                item.method === "elicitation/create"
                && (update.status === "completed" || update.status === "failed")
            ) {
                const inter = item._meta?.plurnk?.interaction;
                if (typeof inter?.interactionId === "number" && `int:${inter.interactionId}` === update.toolCallId) {
                    cancelById(item.id);
                }
            }
        }
    }
}
