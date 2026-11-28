import { overviewExcerptCharsLimit, overviewSessionsLimit } from "./endpoints.js";
import managementAction from "./management-action.js";
import { matchSnippet, truncateSingleLine } from "./session-selection.js";
import {
    asSessionKind,
    asSessionOrigin,
    createWatchState,
    hydrateWatchState,
    isRecord,
    parseWatchReply,
    reduceWatchNotification,
    watchSessionKey,
} from "./watch-store.js";
import { parseWorkspaceList } from "./workspace-records.js";

export { isRecord };

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly at?: number,
 *   readonly excerpt?: string,
 * }} OverviewReply
 */

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly name: string,
 *   readonly projectRoot: string | null,
 *   readonly projectLabel: string | null,
 *   readonly archived: boolean,
 *   readonly order: number,
 * }} OverviewWorkspace
 */

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly workspaceId: number,
 *   readonly workspaceName: string,
 *   readonly projectRoot: string | null,
 *   readonly name: string,
 *   readonly parentSessionId: number | null,
 *   readonly parentName: string | null,
 *   readonly parentOrigin: "model" | "_plurnk" | null,
 *   readonly origin: "model" | "_plurnk",
 *   readonly kind: "root" | "work" | "fork",
 *   readonly lifecycle: string,
 *   readonly gates: number,
 *   readonly archived: boolean,
 *   readonly title?: string,
 *   readonly openingPrompt?: string,
 *   readonly matchedQuery?: string,
 *   readonly matchedExcerpt?: string,
 *   readonly reply: OverviewReply | null,
 * }} OverviewSession
 */

/** @param {OverviewSession} a @param {OverviewSession} b */
export const orderSessions = (a, b) => (a.reply !== null && b.reply !== null
    ? b.reply.id - a.reply.id
    : a.reply !== null
        ? -1
        : b.reply !== null
            ? 1
            : b.id - a.id);

/** @param {OverviewSession} session */
export const isActiveSession = (session) =>
    session.lifecycle === "running" || session.lifecycle === "queued" || session.lifecycle === "parked";

/**
 * {§web-search} {§web-session-directory}
 * @param {OverviewSession} session
 * @param {boolean} hasModelChildren
 */
export function isUntouchedDraftOverviewSession(session, hasModelChildren) {
    return session.parentSessionId === null
        && session.kind === "root"
        && session.lifecycle === "idle"
        && session.reply === null
        && !(typeof session.title === "string" && session.title.trim() !== "")
        && !(typeof session.openingPrompt === "string" && session.openingPrompt.trim() !== "")
        && session.gates === 0
        && !hasModelChildren;
}

/** @param {OverviewSession} session @param {string} queryLower */
export function resolveDisplayedExcerpt(session, queryLower) {
    if (queryLower !== "" && session.matchedQuery === queryLower && session.matchedExcerpt) {
        return session.matchedExcerpt;
    }
    return session.reply?.excerpt ?? "";
}

/**
 * @param {import("./watch-store.js").WatchReply | null} rawReply
 * @param {number} excerptChars
 * @returns {OverviewReply | null}
 */
function formatOverviewReply(rawReply, excerptChars) {
    if (!rawReply) return null;
    const rawExcerpt = typeof rawReply.excerpt === "string" && rawReply.excerpt.trim() !== ""
        ? truncateSingleLine(rawReply.excerpt, excerptChars)
        : "";
    const excerpt = rawExcerpt !== "" && rawReply.continued === true && !rawExcerpt.endsWith("…")
        ? `${rawExcerpt}…`
        : rawExcerpt;
    return {
        id: rawReply.id,
        ...(typeof rawReply.at === "number" ? { at: rawReply.at } : {}),
        ...(excerpt !== "" ? { excerpt } : {}),
    };
}

/**
 * Bound concurrent HTTP/1.1 SSE actions so browser per-origin socket pools (6 sockets) never deadlock.
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, concurrency, worker) {
    /** @type {R[]} */
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            results[idx] = await worker(items[idx]);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * {§web-search} {§web-session-directory} Live overview inventory store backed by Watch state and single-pass `session/list`.
 */
export function createOverviewStore() {
    /** @type {Map<number, OverviewWorkspace>} */
    const workspacesById = new Map();
    /** @type {Map<string, OverviewSession>} */
    const sessionsByKey = new Map();
    /** @type {Map<string, readonly string[]>} */
    const loopPromptsCache = new Map();
    let watchState = createWatchState();
    let omittedCount = 0;
    let initialLoadDone = false;

    /**
     * Project active unarchived `watchState` into `workspacesById`, `sessionsByKey`, and `omittedCount`.
     * @param {{ readonly applyOverviewLimit: boolean }} options
     */
    function syncActiveStoreFromWatch({ applyOverviewLimit }) {
        const overviewLimit = overviewSessionsLimit();
        const excerptChars = overviewExcerptCharsLimit();
        /** @type {Map<string, { matchedQuery?: string, matchedExcerpt?: string }>} */
        const priorMatches = new Map();
        for (const [key, prev] of sessionsByKey) {
            if (prev.matchedQuery !== undefined || prev.matchedExcerpt !== undefined) {
                priorMatches.set(key, {
                    ...(prev.matchedQuery !== undefined ? { matchedQuery: prev.matchedQuery } : {}),
                    ...(prev.matchedExcerpt !== undefined ? { matchedExcerpt: prev.matchedExcerpt } : {}),
                });
            }
        }

        workspacesById.clear();
        for (const [id, ws] of watchState.workspaces) {
            workspacesById.set(id, { ...ws });
        }

        const activeSessions = [...watchState.sessions.values()]
            .filter((s) => !s.archived && !(workspacesById.get(s.workspaceId)?.archived ?? false))
            .toSorted((a, b) =>
                a.reply !== null && b.reply !== null
                    ? b.reply.id - a.reply.id
                    : a.reply !== null
                        ? -1
                        : b.reply !== null
                            ? 1
                            : b.id - a.id,
            );

        const held = applyOverviewLimit
            ? activeSessions.filter((s, index) => index < overviewLimit || s.gates > 0)
            : activeSessions;
        omittedCount = watchState.omitted + (activeSessions.length - held.length);

        sessionsByKey.clear();
        for (const s of held) {
            const key = watchSessionKey(s.workspaceId, s.id);
            const match = priorMatches.get(key);
            const openingPrompt = s.opening !== undefined ? truncateSingleLine(s.opening, excerptChars) : undefined;
            sessionsByKey.set(key, {
                id: s.id,
                workspaceId: s.workspaceId,
                workspaceName: s.workspaceName,
                projectRoot: s.projectRoot,
                name: s.name,
                parentSessionId: s.parentSessionId,
                parentName: s.parentName,
                parentOrigin: s.parentOrigin,
                origin: "model",
                kind: s.kind,
                lifecycle: s.lifecycle,
                gates: s.gates,
                archived: false,
                ...(s.title !== undefined ? { title: s.title } : {}),
                ...(openingPrompt ? { openingPrompt } : {}),
                ...(match?.matchedQuery !== undefined ? { matchedQuery: match.matchedQuery } : {}),
                ...(match?.matchedExcerpt !== undefined ? { matchedExcerpt: match.matchedExcerpt } : {}),
                reply: formatOverviewReply(s.reply, excerptChars),
            });
        }
    }

    /**
     * @param {number} wsId
     * @param {string} sessName
     * @param {number | null} replyId
     * @param {AbortSignal} signal
     * @returns {Promise<readonly string[]>}
     */
    async function loadSessionLoopPrompts(wsId, sessName, replyId, signal) {
        const cacheKey = `${wsId}:${sessName}:${replyId ?? "none"}`;
        const cached = loopPromptsCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const loopsRes = await managementAction(
            "session.loops",
            { workspaceId: wsId, session: sessName },
            `${wsId}#${sessName}`,
            signal,
            { workspaceId: wsId },
        ).catch(() => null);
        const items = isRecord(loopsRes) && Array.isArray(loopsRes.items) ? loopsRes.items : [];
        /** @type {string[]} */
        const prompts = [];
        for (const item of items) {
            if (!isRecord(item)) continue;
            if (typeof item.opening === "string" && item.opening.trim() !== "") {
                prompts.push(item.opening.trim());
            }
        }
        loopPromptsCache.set(cacheKey, prompts);
        return prompts;
    }

    /** @param {boolean} showArchived @returns {string[]} */
    function collectSuggestionTerms(showArchived) {
        /** @type {Set<string>} */
        const terms = new Set();
        for (const ws of workspacesById.values()) {
            if (showArchived ? ws.archived : !ws.archived) terms.add(ws.name);
        }
        const childParents = new Set();
        for (const s of sessionsByKey.values()) {
            if (s.origin !== "model" || s.parentSessionId === null) continue;
            const ws = workspacesById.get(s.workspaceId);
            const isArchived = s.archived || Boolean(ws?.archived);
            if (showArchived ? !isArchived : isArchived) continue;
            childParents.add(`${s.workspaceId}:${s.parentSessionId}`);
        }
        for (const s of sessionsByKey.values()) {
            if (s.origin !== "model") continue;
            const ws = workspacesById.get(s.workspaceId);
            const isArchived = s.archived || Boolean(ws?.archived);
            if (showArchived ? !isArchived : isArchived) continue;
            if (isUntouchedDraftOverviewSession(s, childParents.has(`${s.workspaceId}:${s.id}`))) continue;
            terms.add(s.name);
            if (typeof s.title === "string" && s.title !== "") terms.add(s.title);
        }
        return [...terms];
    }

    /**
     * @param {unknown} raw
     * @param {{
     *   readonly filterStatus: string,
     *   readonly isNarrowing?: boolean,
     *   readonly onResync: () => void,
     *   readonly onSnapshotHydrated?: () => void,
     * }} context
     * @returns {boolean}
     */
    function applyNotification(raw, { filterStatus, isNarrowing = false, onResync, onSnapshotHydrated }) {
        if (filterStatus === "archived") return false;
        const outcome = reduceWatchNotification(watchState, raw);
        watchState = outcome.state;
        if (outcome.resyncRequired) {
            onResync();
            return false;
        }
        if (outcome.snapshotReason !== null) {
            initialLoadDone = true;
            syncActiveStoreFromWatch({ applyOverviewLimit: !isNarrowing });
            onSnapshotHydrated?.();
            if (isNarrowing && watchState.omitted > 0) {
                onResync();
            }
            return true;
        }
        if (!outcome.changed) return false;
        syncActiveStoreFromWatch({ applyOverviewLimit: !isNarrowing });
        return true;
    }

    /**
     * @param {{
     *   readonly filterQuery: string,
     *   readonly filterWorkspace: string,
     *   readonly filterStatus: string,
     *   readonly filterKind: string,
     *   readonly signal: AbortSignal,
     *   readonly isDisposed: () => boolean,
     *   readonly takeBufferedNotifications: () => unknown[],
     *   readonly onResync: () => void,
     * }} params
     * @returns {Promise<boolean>}
     */
    async function fetchSnapshot({
        filterQuery,
        filterWorkspace,
        filterStatus,
        filterKind,
        signal,
        isDisposed,
        takeBufferedNotifications,
        onResync,
    }) {
        const qTrim = filterQuery.trim();
        const qLower = qTrim.toLowerCase();
        const showArchived = filterStatus === "archived";
        const isNarrowing = Boolean(
            qTrim
            || filterWorkspace
            || (filterStatus !== "all" && filterStatus !== "archived")
            || filterKind !== "all",
        );
        const overviewLimit = overviewSessionsLimit();
        const excerptChars = overviewExcerptCharsLimit();

        if (!showArchived) {
            // Single-pass unarchived overview via `session/list` (zero `workspace.list` or `N × workspace.sessions` waterfall).
            const overviewRes = await managementAction("session/list", {
                archived: "exclude",
                _meta: {
                    plurnk: {
                        limit: isNarrowing ? 10_000 : overviewLimit,
                        excerptChars,
                        ...(filterWorkspace ? { workspaceName: filterWorkspace } : {}),
                    },
                },
            }, "", signal);
            if (signal.aborted || isDisposed()) return false;

            const overviewMeta = isRecord(overviewRes) && isRecord(overviewRes._meta) && isRecord(overviewRes._meta.plurnk)
                ? overviewRes._meta.plurnk
                : null;
            const rawMetaWorkspaces = Array.isArray(overviewMeta?.workspaces) ? overviewMeta.workspaces : [];
            const rawSessions = isRecord(overviewRes) && Array.isArray(overviewRes.sessions) ? overviewRes.sessions : [];

            /** @type {Array<Record<string, unknown>>} */
            const normalizedSessions = [];
            /** @type {Map<number, Record<string, unknown>>} */
            const fallbackWorkspaces = new Map();
            for (const item of rawSessions) {
                if (!isRecord(item)) continue;
                const meta = isRecord(item._meta) && isRecord(item._meta.plurnk) ? item._meta.plurnk : null;
                if (!meta || typeof meta.id !== "number" || typeof meta.workspaceId !== "number" || typeof meta.name !== "string") {
                    continue;
                }
                if (!fallbackWorkspaces.has(meta.workspaceId)) {
                    const projRoot = typeof meta.projectRoot === "string" ? meta.projectRoot : null;
                    fallbackWorkspaces.set(meta.workspaceId, {
                        id: meta.workspaceId,
                        name: typeof meta.workspaceName === "string" ? meta.workspaceName : String(meta.workspaceId),
                        projectRoot: projRoot,
                        projectLabel: typeof meta.projectLabel === "string" ? meta.projectLabel : projRoot,
                    });
                }
                normalizedSessions.push(meta);
            }

            const workspacesList = rawMetaWorkspaces.length > 0 ? rawMetaWorkspaces : [...fallbackWorkspaces.values()];
            watchState = hydrateWatchState({
                workspaces: workspacesList,
                sessions: normalizedSessions,
                proposals: Array.isArray(overviewMeta?.proposals) ? overviewMeta.proposals : [],
                interactions: Array.isArray(overviewMeta?.interactions) ? overviewMeta.interactions : [],
                omitted: typeof overviewMeta?.omitted === "number" ? overviewMeta.omitted : 0,
            });
            syncActiveStoreFromWatch({ applyOverviewLimit: !isNarrowing });

            if (qLower !== "") {
                const candidates = [...sessionsByKey.values()];
                await mapWithConcurrency(candidates, 2, async (s) => {
                    const prompts = await loadSessionLoopPrompts(s.workspaceId, s.name, s.reply?.id ?? null, signal);
                    if (prompts.length === 0) return;
                    const key = `${s.workspaceId}:${s.id}`;
                    const cur = sessionsByKey.get(key);
                    if (!cur) return;
                    const opening = cur.openingPrompt ?? truncateSingleLine(prompts[0], excerptChars);
                    const hit = prompts.find((p) => p.toLowerCase().includes(qLower));
                    if (!hit && opening === cur.openingPrompt) return;
                    /** @type {string | undefined} */
                    let matchedExcerpt;
                    if (hit && !(cur.reply?.excerpt ?? "").toLowerCase().includes(qLower)) {
                        matchedExcerpt = matchSnippet(hit, qLower, excerptChars);
                    }
                    sessionsByKey.set(key, {
                        ...cur,
                        ...(opening ? { openingPrompt: opening } : {}),
                        ...(hit ? { matchedQuery: qLower } : {}),
                        ...(matchedExcerpt ? { matchedExcerpt } : {}),
                    });
                });
                if (signal.aborted || isDisposed()) return false;
            }

            initialLoadDone = true;
            for (const payload of takeBufferedNotifications()) {
                applyNotification(payload, { filterStatus, isNarrowing, onResync });
            }
            return true;
        }

        // Archived posture (`?status=archived`): inspect archived workspaces and archived sessions.
        const rawWsList = await managementAction("workspace.list", { includeArchived: true }, "", signal);
        if (signal.aborted || isDisposed()) return false;

        const listedWorkspaces = parseWorkspaceList(rawWsList);
        /** @type {Map<number, OverviewWorkspace>} */
        const nextWorkspaces = new Map();
        let nextOrder = 0;
        for (const ws of listedWorkspaces) {
            nextWorkspaces.set(ws.id, {
                id: ws.id,
                name: ws.name,
                projectRoot: ws.projectRoot,
                projectLabel: ws.projectLabel,
                archived: ws.archivedAt !== null,
                order: nextOrder++,
            });
        }

        const targetWorkspaces = listedWorkspaces.filter((ws) => !filterWorkspace || ws.name === filterWorkspace);
        const perWsSessions = await mapWithConcurrency(
            targetWorkspaces,
            2,
            async (ws) => {
                const res = await managementAction(
                    "workspace.sessions",
                    { workspaceId: ws.id, includeArchived: true },
                    "",
                    signal,
                    { workspaceId: ws.id },
                ).catch(() => null);
                const rows = isRecord(res) && Array.isArray(res.sessions) ? res.sessions : [];
                return { ws, rows };
            },
        );
        if (signal.aborted || isDisposed()) return false;

        /** @type {Map<string, OverviewSession>} */
        const nextSessions = new Map();
        for (const { ws, rows } of perWsSessions) {
            /** @type {Map<number, Record<string, unknown>>} */
            const rowById = new Map();
            for (const row of rows) {
                if (isRecord(row) && typeof row.id === "number") rowById.set(row.id, row);
            }
            for (const row of rows) {
                if (!isRecord(row) || typeof row.id !== "number" || typeof row.name !== "string") continue;
                if (row.origin !== "model") continue;
                const isRowArchived = (row.archivedAt !== null && row.archivedAt !== undefined) || ws.archivedAt !== null;
                if (!isRowArchived) continue;
                const key = `${ws.id}:${row.id}`;
                const parentSessionId = typeof row.parentSessionId === "number" ? row.parentSessionId : null;
                const parentRow = parentSessionId !== null ? rowById.get(parentSessionId) : undefined;
                const parentOrigin = asSessionOrigin(parentRow?.origin) ?? (parentSessionId !== null ? "_plurnk" : null);
                const parentName = typeof parentRow?.name === "string"
                    ? parentRow.name
                    : parentSessionId !== null
                        ? "_plurnk"
                        : null;
                const resolvedTitle = typeof row.title === "string" && row.title.trim() !== ""
                    ? row.title.trim()
                    : undefined;
                nextSessions.set(key, {
                    id: row.id,
                    workspaceId: ws.id,
                    workspaceName: ws.name,
                    projectRoot: ws.projectRoot,
                    name: row.name,
                    parentSessionId,
                    parentName,
                    parentOrigin,
                    origin: "model",
                    kind: asSessionKind(row.kind) ?? (parentSessionId === null ? "root" : "work"),
                    lifecycle: typeof row.lifecycle === "string" ? row.lifecycle : "idle",
                    gates: 0,
                    archived: true,
                    ...(resolvedTitle ? { title: resolvedTitle } : {}),
                    reply: formatOverviewReply(parseWatchReply(row.reply), excerptChars),
                });
            }
        }

        if (qLower !== "" && nextSessions.size > 0) {
            await mapWithConcurrency([...nextSessions.values()], 2, async (s) => {
                const prompts = await loadSessionLoopPrompts(s.workspaceId, s.name, s.reply?.id ?? null, signal);
                if (prompts.length === 0) return;
                const key = `${s.workspaceId}:${s.id}`;
                const cur = nextSessions.get(key);
                if (!cur) return;
                const opening = truncateSingleLine(prompts[0], excerptChars);
                const hit = prompts.find((p) => p.toLowerCase().includes(qLower));
                /** @type {string | undefined} */
                let matchedExcerpt;
                if (hit && !(cur.reply?.excerpt ?? "").toLowerCase().includes(qLower)) {
                    matchedExcerpt = matchSnippet(hit, qLower, excerptChars);
                }
                nextSessions.set(key, {
                    ...cur,
                    ...(opening ? { openingPrompt: opening } : {}),
                    ...(hit ? { matchedQuery: qLower } : {}),
                    ...(matchedExcerpt ? { matchedExcerpt } : {}),
                });
            });
            if (signal.aborted || isDisposed()) return false;
        }

        omittedCount = 0;
        workspacesById.clear();
        for (const [id, ws] of nextWorkspaces) workspacesById.set(id, ws);
        sessionsByKey.clear();
        for (const [k, v] of nextSessions) sessionsByKey.set(k, v);
        initialLoadDone = true;
        takeBufferedNotifications();
        return true;
    }

    return {
        workspacesById,
        sessionsByKey,
        getOmittedCount: () => omittedCount,
        isInitialLoadDone: () => initialLoadDone,
        isWatchHydrated: () => watchState.hydrated,
        collectSuggestionTerms,
        applyNotification,
        fetchSnapshot,
    };
}
