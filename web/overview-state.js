import { overviewExcerptCharsLimit, overviewSessionsLimit } from "./endpoints.js";
import managementAction from "./management-action.js";
import { matchSnippet, truncateSingleLine } from "./session-selection.js";
import { parseWorkspaceList } from "./workspace-records.js";

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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {"root" | "work" | "fork" | null} */
const asSessionKind = (value) => value === "root" || value === "work" || value === "fork" ? value : null;

/** @param {string} raw */
const singleLineExcerpt = (raw) => raw.replaceAll(/\s+/gu, " ").trim();

/** @param {OverviewSession} a @param {OverviewSession} b */
export const orderSessions = (a, b) => a.reply !== null && b.reply !== null ? b.reply.id - a.reply.id
    : a.reply !== null ? -1 : b.reply !== null ? 1 : 0;

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
 * {§web-search} {§web-session-directory} Live overview inventory store, `/acp` fetcher, and `/notifications` reducer.
 */
export function createOverviewStore() {
    /** @type {Map<number, OverviewWorkspace>} */
    const workspacesById = new Map();
    /** @type {Map<string, OverviewSession>} */
    const sessionsByKey = new Map();
    /** @type {Map<string, readonly string[]>} */
    const loopPromptsCache = new Map();
    let nextWorkspaceOrder = 0;
    let omittedCount = 0;
    let initialLoadDone = false;

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
     * @param {{ readonly filterStatus: string, readonly onResync: () => void }} context
     * @returns {boolean}
     */
    function applyNotification(raw, { filterStatus, onResync }) {
        if (filterStatus === "archived") return false;
        if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) return false;
        const { event, data } = raw;
        const notifWorkspaceId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
        const notifSessionId = typeof raw.sessionId === "number" ? raw.sessionId : null;
        const notifTimestamp = typeof raw.timestamp === "number" ? raw.timestamp : Date.now();

        switch (event) {
            case "workspace/created": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                const name = typeof data.name === "string" ? data.name : null;
                if (id === null || name === null) return false;
                const prev = workspacesById.get(id);
                const projRoot = typeof data.projectRoot === "string" ? data.projectRoot : null;
                const projLabel = typeof data.projectLabel === "string" ? data.projectLabel : projRoot;
                workspacesById.set(id, {
                    id,
                    name,
                    projectRoot: projRoot,
                    projectLabel: projLabel,
                    archived: false,
                    order: prev?.order ?? nextWorkspaceOrder++,
                });
                return true;
            }
            case "workspace/renamed": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                const name = typeof data.name === "string" ? data.name : null;
                if (id === null || name === null) return false;
                const prev = workspacesById.get(id);
                workspacesById.set(id, {
                    id,
                    name,
                    projectRoot: prev?.projectRoot ?? null,
                    projectLabel: prev?.projectLabel ?? null,
                    archived: prev?.archived ?? false,
                    order: prev?.order ?? nextWorkspaceOrder++,
                });
                for (const [key, session] of sessionsByKey.entries()) {
                    if (session.workspaceId === id) {
                        sessionsByKey.set(key, { ...session, workspaceName: name });
                    }
                }
                return true;
            }
            case "workspace/archived": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                if (id === null) return false;
                const isArchived = data.archivedAt !== null && data.archivedAt !== undefined;
                const prev = workspacesById.get(id);
                if (prev) {
                    workspacesById.set(id, { ...prev, archived: isArchived });
                }
                if (isArchived) {
                    for (const [key, session] of sessionsByKey.entries()) {
                        if (session.workspaceId === id) {
                            sessionsByKey.delete(key);
                        }
                    }
                }
                return true;
            }
            case "session/created": {
                const id = typeof data.id === "number" ? data.id : notifSessionId;
                const wsId = typeof data.workspaceId === "number" ? data.workspaceId : notifWorkspaceId;
                if (id === null || wsId === null || typeof data.name !== "string") return false;
                const prevWs = workspacesById.get(wsId);
                const wsName = typeof data.workspaceName === "string" ? data.workspaceName : prevWs?.name ?? String(wsId);
                const projRoot = typeof data.projectRoot === "string" ? data.projectRoot : data.projectRoot === null ? null : prevWs?.projectRoot ?? null;
                const projLabel = typeof data.projectLabel === "string" ? data.projectLabel : data.projectLabel === null ? null : prevWs?.projectLabel ?? projRoot;
                workspacesById.set(wsId, {
                    id: wsId,
                    name: wsName,
                    projectRoot: projRoot,
                    projectLabel: projLabel,
                    archived: false,
                    order: prevWs?.order ?? nextWorkspaceOrder++,
                });
                if (data.origin !== "model") return true;
                const parentSessionId = typeof data.parentSessionId === "number" ? data.parentSessionId : null;
                const parentEntry = parentSessionId !== null ? sessionsByKey.get(`${wsId}:${parentSessionId}`) ?? null : null;
                const kind = asSessionKind(data.kind) ?? (parentSessionId === null ? "root" : "work");
                const title = typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim() : undefined;
                sessionsByKey.set(`${wsId}:${id}`, {
                    id,
                    workspaceId: wsId,
                    workspaceName: wsName,
                    projectRoot: projRoot,
                    name: data.name,
                    parentSessionId,
                    parentName: parentEntry?.name ?? (parentSessionId !== null ? "_plurnk" : null),
                    parentOrigin: parentEntry?.origin ?? (parentSessionId !== null ? "_plurnk" : null),
                    origin: "model",
                    kind,
                    lifecycle: typeof data.lifecycle === "string" ? data.lifecycle : "idle",
                    gates: 0,
                    archived: false,
                    ...(title ? { title } : {}),
                    reply: null,
                });
                return true;
            }
            case "session/archived":
            case "session/deleted": {
                if (event === "session/archived" && (data.archivedAt === null || data.archivedAt === undefined)) return false;
                const wsId = notifWorkspaceId;
                const ids = Array.isArray(data.sessionIds) ? data.sessionIds : (typeof data.id === "number" ? [data.id] : []);
                if (wsId === null || ids.length === 0) return false;
                let removed = false;
                for (const sid of ids) {
                    if (typeof sid === "number" && sessionsByKey.delete(`${wsId}:${sid}`)) {
                        removed = true;
                    }
                }
                return removed;
            }
            case "session/titled": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.id === "number" ? data.id : notifSessionId;
                if (wsId === null || sid === null) return false;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return false;
                const nextTitle = typeof data.title === "string" && data.title.trim().length > 0 ? data.title.trim() : undefined;
                if (cur.title === nextTitle) return false;
                const next = { ...cur };
                if (nextTitle !== undefined) next.title = nextTitle;
                else delete next.title;
                sessionsByKey.set(key, next);
                return true;
            }
            case "loop/proposal":
            case "loop/interaction": {
                if (notifWorkspaceId === null || notifSessionId === null) return false;
                if (event === "loop/proposal" && isRecord(data.disposition) && data.disposition.decision !== "review") return false;
                const key = `${notifWorkspaceId}:${notifSessionId}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return false;
                sessionsByKey.set(key, { ...cur, lifecycle: "running", gates: cur.gates + 1 });
                return true;
            }
            case "loop/gate-settled": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
                if (wsId === null || sid === null) return false;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur || cur.gates <= 0) return false;
                sessionsByKey.set(key, { ...cur, gates: Math.max(0, cur.gates - 1) });
                return true;
            }
            case "log/entry": {
                const entry = isRecord(data.entry) ? data.entry : null;
                if (!entry) return false;
                const wsId = notifWorkspaceId;
                const sid = typeof entry.sessionId === "number" ? entry.sessionId : notifSessionId;
                if (wsId === null || sid === null) return false;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return false;
                let nextReply = cur.reply;
                let nextLifecycle = cur.lifecycle;
                let nextOpeningPrompt = cur.openingPrompt;
                if (entry.origin === "client" && entry.op === "send" && !nextOpeningPrompt) {
                    const tx = isRecord(entry.tx) ? entry.tx : null;
                    const rawPrompt = typeof tx?.body === "string" ? tx.body
                        : isRecord(tx?.body) && typeof tx.body.raw === "string" ? tx.body.raw : undefined;
                    if (rawPrompt) {
                        const cleaned = singleLineExcerpt(rawPrompt);
                        if (cleaned !== "") nextOpeningPrompt = cleaned;
                    }
                }
                if (
                    entry.origin === "model"
                    && entry.state === "resolved"
                    && (typeof entry.statusRx !== "number" || entry.statusRx < 400)
                    && (entry.op === "send" || entry.op === "done" || entry.op === "fail")
                    && typeof entry.id === "number"
                ) {
                    const rxCompletion = isRecord(entry.rx) && (entry.rx.completion === 200 || entry.rx.completion === 499)
                        ? entry.rx.completion
                        : (Array.isArray(entry.repliedToSources) && entry.repliedToSources.length > 0 ? 200 : null);
                    if (rxCompletion !== null) {
                        const tx = isRecord(entry.tx) ? entry.tx : null;
                        const rawWords = typeof tx?.body === "string" ? tx.body
                            : isRecord(tx?.body) && typeof tx.body.raw === "string" ? tx.body.raw : undefined;
                        const excerpt = rawWords ? singleLineExcerpt(rawWords) : cur.reply?.excerpt;
                        nextReply = {
                            id: entry.id,
                            at: notifTimestamp,
                            ...(excerpt ? { excerpt } : {}),
                        };
                    }
                }
                if (entry.state !== "proposed" && entry.op !== "done" && entry.op !== "fail" && entry.op !== "wait") {
                    nextLifecycle = "running";
                }
                if (nextReply !== cur.reply || nextLifecycle !== cur.lifecycle || nextOpeningPrompt !== cur.openingPrompt) {
                    sessionsByKey.set(key, {
                        ...cur,
                        reply: nextReply,
                        lifecycle: nextLifecycle,
                        ...(nextOpeningPrompt ? { openingPrompt: nextOpeningPrompt } : {}),
                    });
                    return true;
                }
                return false;
            }
            case "loop/started":
            case "loop/parked": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
                if (wsId === null || sid === null) return false;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return false;
                const lifecycle = event === "loop/parked" ? "parked" : "running";
                const rawPrompt = typeof data.prompt === "string" ? singleLineExcerpt(data.prompt) : "";
                const nextOpeningPrompt = cur.openingPrompt ?? (rawPrompt !== "" ? rawPrompt : undefined);
                if (cur.lifecycle !== lifecycle || nextOpeningPrompt !== cur.openingPrompt) {
                    sessionsByKey.set(key, {
                        ...cur,
                        lifecycle,
                        ...(nextOpeningPrompt ? { openingPrompt: nextOpeningPrompt } : {}),
                    });
                    return true;
                }
                return false;
            }
            case "loop/terminated": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
                if (wsId === null || sid === null) return false;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return false;
                const status = isRecord(data.result) && typeof data.result.status === "number" ? data.result.status : 200;
                const lifecycle = status === 200 ? "completed"
                    : status === 202 ? "parked"
                        : status === 499 ? "cancelled"
                            : status >= 400 ? "failed" : "completed";
                if (cur.lifecycle !== lifecycle || cur.gates !== 0) {
                    sessionsByKey.set(key, { ...cur, lifecycle, gates: 0 });
                    return true;
                }
                return false;
            }
            case "notifications/resync": {
                onResync();
                return false;
            }
            default:
                return false;
        }
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

        const [rawWsList, overviewRes] = await Promise.all([
            managementAction("workspace.list", { includeArchived: true }, "", signal),
            managementAction("session/list", {
                archived: showArchived ? "only" : "exclude",
                _meta: {
                    plurnk: {
                        limit: isNarrowing ? 10_000 : overviewLimit,
                        excerptChars,
                        ...(filterWorkspace ? { workspaceName: filterWorkspace } : {}),
                    },
                },
            }, "", signal).catch(() => null),
        ]);
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

        const overviewMeta = isRecord(overviewRes) && isRecord(overviewRes._meta) && isRecord(overviewRes._meta.plurnk)
            ? overviewRes._meta.plurnk
            : null;
        omittedCount = typeof overviewMeta?.omitted === "number" ? overviewMeta.omitted : 0;

        /** @type {Map<string, { kind?: string, gates: number, title?: string, reply: OverviewReply | null }>} */
        const overviewByKey = new Map();
        /** @type {Set<string>} */
        const overviewOrderedKeys = new Set();
        const rawOverviewSessions = isRecord(overviewRes) && Array.isArray(overviewRes.sessions) ? overviewRes.sessions : [];
        for (const item of rawOverviewSessions) {
            if (!isRecord(item)) continue;
            const meta = isRecord(item._meta) && isRecord(item._meta.plurnk) ? item._meta.plurnk : null;
            if (!meta || typeof meta.workspaceId !== "number" || typeof meta.id !== "number") continue;
            const key = `${meta.workspaceId}:${meta.id}`;
            overviewOrderedKeys.add(key);
            const rawReply = isRecord(meta.reply) ? meta.reply : null;
            const rawExcerpt = typeof rawReply?.excerpt === "string" && rawReply.excerpt.trim() !== ""
                ? truncateSingleLine(rawReply.excerpt, excerptChars)
                : "";
            const excerpt = rawExcerpt !== "" && rawReply?.continued === true && !rawExcerpt.endsWith("…")
                ? `${rawExcerpt}…`
                : rawExcerpt;
            /** @type {OverviewReply | null} */
            const reply = rawReply && typeof rawReply.id === "number"
                ? {
                    id: rawReply.id,
                    ...(typeof rawReply.at === "number" ? { at: rawReply.at } : {}),
                    ...(excerpt !== "" ? { excerpt } : {}),
                }
                : null;
            overviewByKey.set(key, {
                ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
                gates: typeof meta.gates === "number" ? meta.gates : 0,
                ...(typeof meta.title === "string" ? { title: meta.title } : {}),
                reply,
            });
        }

        const targetWorkspaces = listedWorkspaces.filter((ws) => {
            if (filterWorkspace && ws.name !== filterWorkspace) return false;
            return showArchived ? true : ws.archivedAt === null;
        });

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
                const key = `${ws.id}:${row.id}`;
                const isRowArchived = (row.archivedAt !== null && row.archivedAt !== undefined) || ws.archivedAt !== null;
                if (showArchived ? !isRowArchived : isRowArchived) continue;
                if (!showArchived && !isNarrowing && omittedCount > 0 && !overviewOrderedKeys.has(key)) continue;

                const info = overviewByKey.get(key);
                const prev = sessionsByKey.get(key);
                const parentSessionId = typeof row.parentSessionId === "number" ? row.parentSessionId : null;
                const parentRow = parentSessionId !== null ? rowById.get(parentSessionId) : undefined;
                const parentOrigin = parentRow?.origin === "model"
                    ? "model"
                    : parentRow?.origin === "_plurnk" || parentSessionId !== null
                        ? "_plurnk"
                        : null;
                const parentName = typeof parentRow?.name === "string"
                    ? parentRow.name
                    : parentSessionId !== null
                        ? "_plurnk"
                        : null;
                const resolvedTitle = typeof info?.title === "string" && info.title.trim() !== ""
                    ? info.title.trim()
                    : typeof row.title === "string" && row.title.trim() !== ""
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
                    kind: asSessionKind(info?.kind ?? row.kind) ?? (parentSessionId === null ? "root" : "work"),
                    lifecycle: typeof row.lifecycle === "string" ? row.lifecycle : "idle",
                    gates: info?.gates ?? 0,
                    archived: isRowArchived,
                    ...(resolvedTitle ? { title: resolvedTitle } : {}),
                    ...(prev?.openingPrompt ? { openingPrompt: prev.openingPrompt } : {}),
                    reply: info?.reply ?? null,
                });
            }
        }

        const needLoopInspection = [...nextSessions.values()].filter((s) =>
            qLower !== "" || (!s.title && !s.openingPrompt && (s.reply !== null || s.lifecycle !== "idle")),
        );
        if (needLoopInspection.length > 0) {
            await mapWithConcurrency(
                needLoopInspection,
                2,
                async (s) => {
                    const prompts = await loadSessionLoopPrompts(s.workspaceId, s.name, s.reply?.id ?? null, signal);
                    if (prompts.length === 0) return;
                    const opening = truncateSingleLine(prompts[0], excerptChars);
                    const key = `${s.workspaceId}:${s.id}`;
                    const cur = nextSessions.get(key);
                    if (!cur) return;
                    /** @type {string | undefined} */
                    let matchedExcerpt;
                    let matchedQuery;
                    if (qLower !== "") {
                        const hit = prompts.find((p) => p.toLowerCase().includes(qLower));
                        if (hit) {
                            matchedQuery = qLower;
                            if (!(cur.reply?.excerpt ?? "").toLowerCase().includes(qLower)) {
                                matchedExcerpt = matchSnippet(hit, qLower, excerptChars);
                            }
                        }
                    }
                    nextSessions.set(key, {
                        ...cur,
                        ...(opening ? { openingPrompt: opening } : {}),
                        ...(matchedQuery ? { matchedQuery } : {}),
                        ...(matchedExcerpt ? { matchedExcerpt } : {}),
                    });
                },
            );
        }
        if (signal.aborted || isDisposed()) return false;

        workspacesById.clear();
        for (const [id, ws] of nextWorkspaces) workspacesById.set(id, ws);
        nextWorkspaceOrder = nextOrder;
        sessionsByKey.clear();
        for (const [k, v] of nextSessions) sessionsByKey.set(k, v);
        initialLoadDone = true;

        for (const payload of takeBufferedNotifications()) {
            applyNotification(payload, { filterStatus, onResync });
        }
        return true;
    }

    return {
        workspacesById,
        sessionsByKey,
        getOmittedCount: () => omittedCount,
        isInitialLoadDone: () => initialLoadDone,
        collectSuggestionTerms,
        applyNotification,
        fetchSnapshot,
    };
}
