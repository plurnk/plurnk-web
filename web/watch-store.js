// {§web-search} {§web-session-directory} {§web-workspace-tabs}
// Pure, DOM-free homomorphic Watch state and idempotent reducer over `GET /notifications` envelopes.

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly coordinate?: string,
 *   readonly completion?: 200 | 499,
 *   readonly at?: number,
 *   readonly excerpt?: string,
 *   readonly continued?: boolean,
 * }} WatchReply
 */

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly name: string,
 *   readonly projectRoot: string | null,
 *   readonly projectLabel: string | null,
 *   readonly archived: boolean,
 *   readonly order: number,
 * }} WatchWorkspace
 */

/**
 * @typedef {{
 *   readonly workspaceId: number,
 *   readonly workspaceName: string,
 *   readonly projectRoot: string | null,
 *   readonly projectLabel: string | null,
 *   readonly id: number,
 *   readonly name: string,
 *   readonly parentSessionId: number | null,
 *   readonly parentName: string | null,
 *   readonly parentOrigin: "model" | "_plurnk" | null,
 *   readonly kind: "root" | "work" | "fork",
 *   readonly lifecycle: string,
 *   readonly gates: number,
 *   readonly archived: boolean,
 *   readonly opening?: string,
 *   readonly title?: string,
 *   readonly persona?: string,
 *   readonly reply: WatchReply | null,
 * }} WatchSession
 */

/**
 * @typedef {{
 *   readonly workspaceId: number,
 *   readonly sessionId: number,
 *   readonly logEntryId: number,
 * }} WatchProposalGate
 */

/**
 * @typedef {{
 *   readonly workspaceId: number,
 *   readonly sessionId: number,
 *   readonly interactionId: number,
 * }} WatchInteractionGate
 */

/**
 * @typedef {{
 *   readonly epoch: string | null,
 *   readonly lastEventId: number,
 *   readonly hydrated: boolean,
 *   readonly omitted: number,
 *   readonly nextWorkspaceOrder: number,
 *   readonly workspaces: ReadonlyMap<number, WatchWorkspace>,
 *   readonly sessions: ReadonlyMap<string, WatchSession>,
 *   readonly proposals: ReadonlyMap<string, WatchProposalGate>,
 *   readonly interactions: ReadonlyMap<string, WatchInteractionGate>,
 * }} WatchState
 */

/**
 * @typedef {{
 *   readonly state: WatchState,
 *   readonly changed: boolean,
 *   readonly resyncRequired: boolean,
 *   readonly snapshotReason: string | null,
 * }} WatchReduceOutcome
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {"root" | "work" | "fork" | null} */
export const asSessionKind = (value) => (value === "root" || value === "work" || value === "fork" ? value : null);

/** @param {unknown} value @returns {"model" | "_plurnk" | null} */
export const asSessionOrigin = (value) => (value === "model" || value === "_plurnk" ? value : null);

/** @param {number} workspaceId @param {number} sessionId */
export const watchSessionKey = (workspaceId, sessionId) => `${workspaceId}:${sessionId}`;

/** @param {number} workspaceId @param {number} itemId */
const gateKey = (workspaceId, itemId) => `${workspaceId}:${itemId}`;

/** @param {number} status */
export function lifecycleOfLoopStatus(status) {
    if (status === 100) return "queued";
    if (status === 102) return "running";
    if (status === 202) return "parked";
    if (status === 499) return "cancelled";
    if (status >= 400) return "failed";
    return "completed";
}

/** @param {string} lifecycle */
export function isActiveLoopLifecycle(lifecycle) {
    return lifecycle === "running" || lifecycle === "parked" || lifecycle === "queued";
}

/** @param {unknown} raw @returns {WatchReply | null} */
export function parseWatchReply(raw) {
    if (!isRecord(raw) || typeof raw.id !== "number") return null;
    const completion = raw.completion === 200 || raw.completion === 499 ? raw.completion : undefined;
    return {
        id: raw.id,
        ...(typeof raw.coordinate === "string" ? { coordinate: raw.coordinate } : {}),
        ...(completion !== undefined ? { completion } : {}),
        ...(typeof raw.at === "number" ? { at: raw.at } : {}),
        ...(typeof raw.excerpt === "string" ? { excerpt: raw.excerpt } : {}),
        ...(typeof raw.continued === "boolean" ? { continued: raw.continued } : {}),
    };
}

/**
 * @param {number} workspaceId
 * @param {number} sessionId
 * @param {ReadonlyMap<string, WatchProposalGate>} proposals
 * @param {ReadonlyMap<string, WatchInteractionGate>} interactions
 */
function countSessionGates(workspaceId, sessionId, proposals, interactions) {
    let count = 0;
    for (const proposal of proposals.values()) {
        if (proposal.workspaceId === workspaceId && proposal.sessionId === sessionId) count += 1;
    }
    for (const interaction of interactions.values()) {
        if (interaction.workspaceId === workspaceId && interaction.sessionId === sessionId) count += 1;
    }
    return count;
}

/**
 * @param {number} workspaceId
 * @param {ReadonlySet<number>} sessionIds
 * @param {ReadonlyMap<string, WatchProposalGate>} proposals
 * @param {ReadonlyMap<string, WatchInteractionGate>} interactions
 */
function removeSessionGates(workspaceId, sessionIds, proposals, interactions) {
    let removedAny = false;
    const nextProposals = new Map(proposals);
    for (const [key, item] of proposals) {
        if (item.workspaceId === workspaceId && sessionIds.has(item.sessionId)) {
            nextProposals.delete(key);
            removedAny = true;
        }
    }
    const nextInteractions = new Map(interactions);
    for (const [key, item] of interactions) {
        if (item.workspaceId === workspaceId && sessionIds.has(item.sessionId)) {
            nextInteractions.delete(key);
            removedAny = true;
        }
    }
    return { nextProposals, nextInteractions, removedAny };
}

/** @returns {WatchState} */
export function createWatchState() {
    return {
        epoch: null,
        lastEventId: 0,
        hydrated: false,
        omitted: 0,
        nextWorkspaceOrder: 0,
        workspaces: new Map(),
        sessions: new Map(),
        proposals: new Map(),
        interactions: new Map(),
    };
}

/**
 * @param {Record<string, unknown>} data
 * @param {number | null} [defaultWorkspaceId]
 * @returns {WatchState}
 */
export function hydrateWatchState(data, defaultWorkspaceId = null) {
    /** @type {Map<number, WatchWorkspace>} */
    const workspaces = new Map();
    let order = 0;
    const rawWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    for (const ws of rawWorkspaces) {
        if (!isRecord(ws) || typeof ws.id !== "number" || typeof ws.name !== "string") continue;
        const projRoot = typeof ws.projectRoot === "string" ? ws.projectRoot : null;
        const projLabel = typeof ws.projectLabel === "string" ? ws.projectLabel : projRoot;
        workspaces.set(ws.id, {
            id: ws.id,
            name: ws.name,
            projectRoot: projRoot,
            projectLabel: projLabel,
            archived: false,
            order: order++,
        });
    }

    /** @type {Map<number, number>} */
    const sessionWorkspaceById = new Map();
    const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
    for (const s of rawSessions) {
        if (isRecord(s) && typeof s.id === "number" && typeof s.workspaceId === "number") {
            sessionWorkspaceById.set(s.id, s.workspaceId);
        }
    }

    /** @type {Map<string, WatchProposalGate>} */
    const proposals = new Map();
    const rawProposals = Array.isArray(data.proposals) ? data.proposals : [];
    for (const item of rawProposals) {
        if (!isRecord(item) || typeof item.logEntryId !== "number" || typeof item.sessionId !== "number") continue;
        if (isRecord(item.disposition) && item.disposition.decision !== "review") continue;
        const wsId = sessionWorkspaceById.get(item.sessionId) ?? defaultWorkspaceId;
        if (wsId === null) continue;
        proposals.set(gateKey(wsId, item.logEntryId), {
            workspaceId: wsId,
            sessionId: item.sessionId,
            logEntryId: item.logEntryId,
        });
    }

    /** @type {Map<string, WatchInteractionGate>} */
    const interactions = new Map();
    const rawInteractions = Array.isArray(data.interactions) ? data.interactions : [];
    for (const item of rawInteractions) {
        if (!isRecord(item) || typeof item.interactionId !== "number" || typeof item.sessionId !== "number") continue;
        const wsId = sessionWorkspaceById.get(item.sessionId) ?? defaultWorkspaceId;
        if (wsId === null) continue;
        interactions.set(gateKey(wsId, item.interactionId), {
            workspaceId: wsId,
            sessionId: item.sessionId,
            interactionId: item.interactionId,
        });
    }

    /** @type {Map<string, WatchSession>} */
    const sessions = new Map();
    for (const s of rawSessions) {
        if (!isRecord(s) || typeof s.id !== "number" || typeof s.workspaceId !== "number" || typeof s.name !== "string") {
            continue;
        }
        const ws = workspaces.get(s.workspaceId);
        const wsName = typeof s.workspaceName === "string" ? s.workspaceName : (ws?.name ?? String(s.workspaceId));
        const projRoot = ws?.projectRoot ?? (typeof s.projectRoot === "string" ? s.projectRoot : null);
        const projLabel = ws?.projectLabel ?? (typeof s.projectLabel === "string" ? s.projectLabel : projRoot);
        const parentSessionId = typeof s.parentSessionId === "number" ? s.parentSessionId : null;
        const parentName = parentSessionId === null
            ? null
            : (typeof s.parentName === "string" ? s.parentName : "_plurnk");
        const parentOrigin = parentSessionId === null
            ? null
            : (asSessionOrigin(s.parentOrigin) ?? "_plurnk");
        const countedGates = countSessionGates(s.workspaceId, s.id, proposals, interactions);
        const reportedGates = typeof s.gates === "number" ? s.gates : 0;
        const title = typeof s.title === "string" && s.title.trim() !== "" ? s.title.trim() : undefined;
        const opening = typeof s.opening === "string" && s.opening.trim() !== "" ? s.opening.trim() : undefined;
        const persona = typeof s.persona === "string" ? s.persona : undefined;
        sessions.set(watchSessionKey(s.workspaceId, s.id), {
            workspaceId: s.workspaceId,
            workspaceName: wsName,
            projectRoot: projRoot,
            projectLabel: projLabel,
            id: s.id,
            name: s.name,
            parentSessionId,
            parentName,
            parentOrigin,
            kind: asSessionKind(s.kind) ?? (parentSessionId === null ? "root" : "work"),
            lifecycle: typeof s.lifecycle === "string" ? s.lifecycle : "idle",
            gates: Math.max(reportedGates, countedGates),
            archived: false,
            ...(opening !== undefined ? { opening } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(persona !== undefined ? { persona } : {}),
            reply: parseWatchReply(s.reply),
        });
    }

    return {
        epoch: typeof data.epoch === "string" ? data.epoch : null,
        lastEventId: typeof data.latestId === "number" ? data.latestId : 0,
        hydrated: true,
        omitted: typeof data.omitted === "number" ? data.omitted : 0,
        nextWorkspaceOrder: order,
        workspaces,
        sessions,
        proposals,
        interactions,
    };
}

/**
 * @param {WatchState} state
 * @param {unknown} raw
 * @returns {WatchReduceOutcome}
 */
export function reduceWatchNotification(state, raw) {
    if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) {
        return { state, changed: false, resyncRequired: false, snapshotReason: null };
    }
    const { event, data } = raw;
    const notifId = typeof raw.id === "number" ? raw.id : state.lastEventId;
    const wsId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
    const sessId = typeof raw.sessionId === "number" ? raw.sessionId : null;

    if (event === "notifications/snapshot") {
        const snapshotReason = typeof data.reason === "string" ? data.reason : "initial";
        return {
            state: hydrateWatchState(data, wsId),
            changed: true,
            resyncRequired: false,
            snapshotReason,
        };
    }
    if (event === "notifications/resync") {
        return {
            state: {
                ...state,
                epoch: typeof data.epoch === "string" ? data.epoch : state.epoch,
                lastEventId: typeof data.latestId === "number" ? data.latestId : notifId,
            },
            changed: false,
            resyncRequired: true,
            snapshotReason: null,
        };
    }

    const nextLastId = Math.max(state.lastEventId, notifId);

    switch (event) {
        case "workspace/created": {
            const id = typeof data.id === "number" ? data.id : wsId;
            const name = typeof data.name === "string" ? data.name : null;
            if (id === null || name === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const prev = state.workspaces.get(id);
            const projRoot = typeof data.projectRoot === "string" ? data.projectRoot : null;
            const projLabel = typeof data.projectLabel === "string" ? data.projectLabel : projRoot;
            const workspaces = new Map(state.workspaces);
            workspaces.set(id, {
                id,
                name,
                projectRoot: projRoot,
                projectLabel: projLabel,
                archived: false,
                order: prev?.order ?? state.nextWorkspaceOrder,
            });
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    nextWorkspaceOrder: prev ? state.nextWorkspaceOrder : state.nextWorkspaceOrder + 1,
                    workspaces,
                },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "workspace/renamed": {
            const id = typeof data.id === "number" ? data.id : wsId;
            const name = typeof data.name === "string" ? data.name : null;
            if (id === null || name === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const prev = state.workspaces.get(id);
            const workspaces = new Map(state.workspaces);
            workspaces.set(id, {
                id,
                name,
                projectRoot: prev?.projectRoot ?? null,
                projectLabel: prev?.projectLabel ?? null,
                archived: prev?.archived ?? false,
                order: prev?.order ?? state.nextWorkspaceOrder,
            });
            const sessions = new Map(state.sessions);
            for (const [key, sess] of sessions) {
                if (sess.workspaceId === id && sess.workspaceName !== name) {
                    sessions.set(key, { ...sess, workspaceName: name });
                }
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    nextWorkspaceOrder: prev ? state.nextWorkspaceOrder : state.nextWorkspaceOrder + 1,
                    workspaces,
                    sessions,
                },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "workspace/archived": {
            const id = typeof data.id === "number" ? data.id : wsId;
            if (id === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const isArchived = data.archivedAt !== null && data.archivedAt !== undefined;
            const prev = state.workspaces.get(id);
            const workspaces = new Map(state.workspaces);
            if (prev) {
                workspaces.set(id, { ...prev, archived: isArchived });
            }
            if (!isArchived) {
                return {
                    state: { ...state, lastEventId: nextLastId, workspaces },
                    changed: Boolean(prev && prev.archived),
                    resyncRequired: true,
                    snapshotReason: null,
                };
            }
            let sessions = state.sessions;
            let proposals = state.proposals;
            let interactions = state.interactions;
            const nextSessions = new Map(state.sessions);
            /** @type {Set<number>} */
            const removedIds = new Set();
            for (const [key, sess] of state.sessions) {
                if (sess.workspaceId === id) {
                    nextSessions.delete(key);
                    removedIds.add(sess.id);
                }
            }
            if (removedIds.size > 0) {
                sessions = nextSessions;
                const cleaned = removeSessionGates(id, removedIds, proposals, interactions);
                proposals = cleaned.nextProposals;
                interactions = cleaned.nextInteractions;
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    workspaces,
                    sessions,
                    proposals,
                    interactions,
                },
                changed: Boolean(prev && !prev.archived) || sessions !== state.sessions,
                resyncRequired: state.omitted > 0,
                snapshotReason: null,
            };
        }
        case "session/created": {
            const id = typeof data.id === "number" ? data.id : sessId;
            const targetWsId = typeof data.workspaceId === "number" ? data.workspaceId : wsId;
            if (id === null || targetWsId === null || typeof data.name !== "string") {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const prevWs = state.workspaces.get(targetWsId);
            const wsName = typeof data.workspaceName === "string" ? data.workspaceName : (prevWs?.name ?? String(targetWsId));
            const projRoot = typeof data.projectRoot === "string"
                ? data.projectRoot
                : data.projectRoot === null
                    ? null
                    : (prevWs?.projectRoot ?? null);
            const projLabel = typeof data.projectLabel === "string"
                ? data.projectLabel
                : data.projectLabel === null
                    ? null
                    : (prevWs?.projectLabel ?? projRoot);
            const workspaces = new Map(state.workspaces);
            workspaces.set(targetWsId, {
                id: targetWsId,
                name: wsName,
                projectRoot: projRoot,
                projectLabel: projLabel,
                archived: false,
                order: prevWs?.order ?? state.nextWorkspaceOrder,
            });
            const nextOrder = prevWs ? state.nextWorkspaceOrder : state.nextWorkspaceOrder + 1;
            if (data.origin !== "model") {
                return {
                    state: { ...state, lastEventId: nextLastId, nextWorkspaceOrder: nextOrder, workspaces },
                    changed: !prevWs,
                    resyncRequired: false,
                    snapshotReason: null,
                };
            }
            const key = watchSessionKey(targetWsId, id);
            const prevSess = state.sessions.get(key);
            const parentSessionId = typeof data.parentSessionId === "number" ? data.parentSessionId : null;
            const parentEntry = parentSessionId !== null
                ? state.sessions.get(watchSessionKey(targetWsId, parentSessionId))
                : undefined;
            const parentName = parentSessionId === null
                ? null
                : (parentEntry?.name ?? prevSess?.parentName ?? "_plurnk");
            const parentOrigin = parentSessionId === null
                ? null
                : (parentEntry !== undefined ? "model" : (prevSess?.parentOrigin ?? "_plurnk"));
            const kind = asSessionKind(data.kind) ?? (parentSessionId === null ? "root" : "work");
            const gates = countSessionGates(targetWsId, id, state.proposals, state.interactions);
            const inheritedOpening = prevSess?.opening ?? (kind === "fork" ? parentEntry?.opening : undefined);
            const title = typeof data.title === "string" && data.title.trim() !== ""
                ? data.title.trim()
                : prevSess?.title;
            const persona = typeof data.persona === "string" ? data.persona : prevSess?.persona;
            const incomingLifecycle = typeof data.lifecycle === "string" ? data.lifecycle : "idle";
            const sessions = new Map(state.sessions);
            sessions.set(key, {
                workspaceId: targetWsId,
                workspaceName: wsName,
                projectRoot: projRoot,
                projectLabel: projLabel,
                id,
                name: data.name,
                parentSessionId,
                parentName,
                parentOrigin,
                kind,
                lifecycle: prevSess?.lifecycle && prevSess.lifecycle !== "idle" ? prevSess.lifecycle : incomingLifecycle,
                gates,
                archived: false,
                ...(inheritedOpening !== undefined ? { opening: inheritedOpening } : {}),
                ...(title !== undefined ? { title } : {}),
                ...(persona !== undefined ? { persona } : {}),
                reply: prevSess?.reply ?? null,
            });
            for (const [childKey, child] of sessions) {
                if (child.workspaceId === targetWsId && child.parentSessionId === id) {
                    if (child.parentName !== data.name || child.parentOrigin !== "model") {
                        sessions.set(childKey, { ...child, parentName: data.name, parentOrigin: "model" });
                    }
                }
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    nextWorkspaceOrder: nextOrder,
                    workspaces,
                    sessions,
                },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "session/archived":
        case "session/deleted": {
            if (wsId === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const rawIds = Array.isArray(data.sessionIds) ? data.sessionIds : (typeof data.id === "number" ? [data.id] : []);
            /** @type {Set<number>} */
            const removedSet = new Set(rawIds.filter((item) => typeof item === "number"));
            if (event === "session/archived" && (data.archivedAt === null || data.archivedAt === undefined)) {
                return {
                    state: { ...state, lastEventId: nextLastId },
                    changed: false,
                    resyncRequired: removedSet.size > 0,
                    snapshotReason: null,
                };
            }
            if (removedSet.size === 0) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const sessions = new Map(state.sessions);
            let changed = false;
            for (const sid of removedSet) {
                if (sessions.delete(watchSessionKey(wsId, sid))) changed = true;
            }
            const cleaned = removeSessionGates(wsId, removedSet, state.proposals, state.interactions);
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    sessions,
                    proposals: cleaned.nextProposals,
                    interactions: cleaned.nextInteractions,
                },
                changed: changed || cleaned.removedAny,
                resyncRequired: state.omitted > 0 && removedSet.size > 0,
                snapshotReason: null,
            };
        }
        case "session/titled": {
            const sid = typeof data.id === "number" ? data.id : sessId;
            if (wsId === null || sid === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const key = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(key);
            if (!cur) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const nextTitle = typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim() : undefined;
            if (cur.title === nextTitle) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const sessions = new Map(state.sessions);
            const { title: _prevTitle, ...rest } = cur;
            sessions.set(key, nextTitle !== undefined ? { ...rest, title: nextTitle } : rest);
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "session/policy": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            if (wsId === null || sid === null || !("persona" in data)) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const key = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(key);
            if (!cur) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const nextPersona = typeof data.persona === "string" ? data.persona : undefined;
            if (cur.persona === nextPersona) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const sessions = new Map(state.sessions);
            const { persona: _prevPersona, ...rest } = cur;
            sessions.set(key, nextPersona !== undefined ? { ...rest, persona: nextPersona } : rest);
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "session/replied": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            const reply = parseWatchReply(data.reply);
            if (wsId === null || sid === null || reply === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const key = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(key);
            if (!cur) {
                return {
                    state: { ...state, lastEventId: nextLastId },
                    changed: false,
                    resyncRequired: state.omitted > 0,
                    snapshotReason: null,
                };
            }
            if (cur.reply !== null && cur.reply.id > reply.id) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const sessions = new Map(state.sessions);
            sessions.set(key, { ...cur, reply });
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "loop/started": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            if (wsId === null || sid === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const key = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(key);
            const rawOpening = typeof data.opening === "string" && data.opening.trim() !== ""
                ? data.opening.trim()
                : undefined;
            if (isRecord(data.session) && typeof data.session.id === "number" && typeof data.session.name === "string") {
                const snap = data.session;
                const snapId = data.session.id;
                const snapName = data.session.name;
                const ws = state.workspaces.get(wsId);
                const wsName = ws?.name ?? cur?.workspaceName ?? String(wsId);
                const projRoot = ws?.projectRoot ?? cur?.projectRoot ?? null;
                const projLabel = ws?.projectLabel ?? cur?.projectLabel ?? projRoot;
                const parentSessionId = typeof snap.parentSessionId === "number" ? snap.parentSessionId : null;
                const parentName = parentSessionId === null
                    ? null
                    : (typeof snap.parentName === "string" ? snap.parentName : "_plurnk");
                const parentOrigin = parentSessionId === null
                    ? null
                    : (asSessionOrigin(snap.parentOrigin) ?? "_plurnk");
                const kind = asSessionKind(snap.kind) ?? (parentSessionId === null ? "root" : "work");
                const snapGates = typeof snap.gates === "number" ? snap.gates : 0;
                const gates = Math.max(snapGates, countSessionGates(wsId, snapId, state.proposals, state.interactions));
                const snapOpening = typeof snap.opening === "string" && snap.opening.trim() !== ""
                    ? snap.opening.trim()
                    : undefined;
                const nextOpening = cur?.opening ?? snapOpening ?? rawOpening;
                const snapReply = parseWatchReply(snap.reply);
                const nextReply = cur?.reply !== null && cur?.reply !== undefined && (snapReply === null || cur.reply.id > snapReply.id)
                    ? cur.reply
                    : snapReply;
                const nextTitle = typeof snap.title === "string" && snap.title.trim() !== ""
                    ? snap.title.trim()
                    : cur?.title;
                const nextPersona = typeof snap.persona === "string"
                    ? snap.persona
                    : snap.persona === null
                        ? undefined
                        : cur?.persona;
                const sessions = new Map(state.sessions);
                sessions.set(key, {
                    workspaceId: wsId,
                    workspaceName: wsName,
                    projectRoot: projRoot,
                    projectLabel: projLabel,
                    id: snapId,
                    name: snapName,
                    parentSessionId,
                    parentName,
                    parentOrigin,
                    kind,
                    lifecycle: "running",
                    gates,
                    archived: false,
                    ...(nextOpening !== undefined ? { opening: nextOpening } : {}),
                    ...(nextTitle !== undefined ? { title: nextTitle } : {}),
                    ...(nextPersona !== undefined ? { persona: nextPersona } : {}),
                    reply: nextReply,
                });
                const nextOmitted = !cur && state.omitted > 0 ? state.omitted - 1 : state.omitted;
                return {
                    state: { ...state, lastEventId: nextLastId, omitted: nextOmitted, sessions },
                    changed: true,
                    resyncRequired: false,
                    snapshotReason: null,
                };
            }
            if (!cur) {
                return {
                    state: { ...state, lastEventId: nextLastId },
                    changed: false,
                    resyncRequired: state.omitted > 0,
                    snapshotReason: null,
                };
            }
            const nextOpening = cur.opening ?? rawOpening;
            if (cur.lifecycle === "running" && cur.opening === nextOpening) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const sessions = new Map(state.sessions);
            sessions.set(key, {
                ...cur,
                lifecycle: "running",
                ...(nextOpening !== undefined ? { opening: nextOpening } : {}),
            });
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "loop/parked": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            if (wsId === null || sid === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const key = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(key);
            if (!cur) {
                return {
                    state: { ...state, lastEventId: nextLastId },
                    changed: false,
                    resyncRequired: state.omitted > 0,
                    snapshotReason: null,
                };
            }
            if (cur.lifecycle === "parked") {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const sessions = new Map(state.sessions);
            sessions.set(key, { ...cur, lifecycle: "parked" });
            return {
                state: { ...state, lastEventId: nextLastId, sessions },
                changed: true,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "loop/proposal": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            if (wsId === null || sid === null || typeof data.logEntryId !== "number") {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            if (isRecord(data.disposition) && data.disposition.decision !== "review") {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const proposals = new Map(state.proposals);
            proposals.set(gateKey(wsId, data.logEntryId), {
                workspaceId: wsId,
                sessionId: sid,
                logEntryId: data.logEntryId,
            });
            const sKey = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(sKey);
            let sessions = state.sessions;
            if (cur) {
                const gates = countSessionGates(wsId, sid, proposals, state.interactions);
                const nextSessions = new Map(state.sessions);
                nextSessions.set(sKey, { ...cur, lifecycle: "running", gates });
                sessions = nextSessions;
            }
            return {
                state: { ...state, lastEventId: nextLastId, proposals, sessions },
                changed: Boolean(cur),
                resyncRequired: !cur && state.omitted > 0,
                snapshotReason: null,
            };
        }
        case "loop/interaction": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            if (wsId === null || sid === null || typeof data.interactionId !== "number") {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const interactions = new Map(state.interactions);
            interactions.set(gateKey(wsId, data.interactionId), {
                workspaceId: wsId,
                sessionId: sid,
                interactionId: data.interactionId,
            });
            const sKey = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(sKey);
            let sessions = state.sessions;
            if (cur) {
                const gates = countSessionGates(wsId, sid, state.proposals, interactions);
                const nextSessions = new Map(state.sessions);
                nextSessions.set(sKey, { ...cur, lifecycle: "running", gates });
                sessions = nextSessions;
            }
            return {
                state: { ...state, lastEventId: nextLastId, interactions, sessions },
                changed: Boolean(cur),
                resyncRequired: !cur && state.omitted > 0,
                snapshotReason: null,
            };
        }
        case "loop/gate-settled": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            if (wsId === null || sid === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            let proposals = state.proposals;
            let interactions = state.interactions;
            let changed = false;
            if (data.kind === "proposal" && typeof data.logEntryId === "number") {
                const pKey = gateKey(wsId, data.logEntryId);
                if (proposals.has(pKey)) {
                    const next = new Map(proposals);
                    next.delete(pKey);
                    proposals = next;
                    changed = true;
                }
            } else if (data.kind === "interaction" && typeof data.interactionId === "number") {
                const iKey = gateKey(wsId, data.interactionId);
                if (interactions.has(iKey)) {
                    const next = new Map(interactions);
                    next.delete(iKey);
                    interactions = next;
                    changed = true;
                }
            }
            const sKey = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(sKey);
            let sessions = state.sessions;
            if (cur) {
                const gates = countSessionGates(wsId, sid, proposals, interactions);
                if (cur.gates !== gates) {
                    const nextSessions = new Map(state.sessions);
                    nextSessions.set(sKey, { ...cur, gates });
                    sessions = nextSessions;
                    changed = true;
                }
            }
            return {
                state: { ...state, lastEventId: nextLastId, proposals, interactions, sessions },
                changed,
                resyncRequired: false,
                snapshotReason: null,
            };
        }
        case "loop/terminated": {
            const sid = typeof data.sessionId === "number" ? data.sessionId : sessId;
            if (wsId === null || sid === null) {
                return { state: { ...state, lastEventId: nextLastId }, changed: false, resyncRequired: false, snapshotReason: null };
            }
            const cleaned = removeSessionGates(wsId, new Set([sid]), state.proposals, state.interactions);
            const sKey = watchSessionKey(wsId, sid);
            const cur = state.sessions.get(sKey);
            let sessions = state.sessions;
            let changed = cleaned.removedAny;
            if (cur) {
                const status = isRecord(data.result) && typeof data.result.status === "number" ? data.result.status : 200;
                const lifecycle = lifecycleOfLoopStatus(status);
                if (cur.lifecycle !== lifecycle || cur.gates !== 0) {
                    const nextSessions = new Map(state.sessions);
                    nextSessions.set(sKey, { ...cur, lifecycle, gates: 0 });
                    sessions = nextSessions;
                    changed = true;
                }
            }
            return {
                state: {
                    ...state,
                    lastEventId: nextLastId,
                    proposals: cleaned.nextProposals,
                    interactions: cleaned.nextInteractions,
                    sessions,
                },
                changed,
                resyncRequired: !cur && state.omitted > 0,
                snapshotReason: null,
            };
        }
        default:
            return {
                state: { ...state, lastEventId: nextLastId },
                changed: false,
                resyncRequired: false,
                snapshotReason: null,
            };
    }
}
