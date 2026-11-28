import { $, $$ } from "on_the_money";
import managementAction from "./management-action.js";
import { isUntouchedDraftSession, orderByReply } from "./session-selection.js";
import { asSessionKind, asSessionOrigin, isRecord, lifecycleOfLoopStatus } from "./watch-store.js";

export { asSessionKind, isRecord };

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly name: string,
 *   readonly parentSessionId: number | null,
 *   readonly parentName?: string | null,
 *   readonly parentOrigin?: string | null,
 *   readonly kind: "root" | "work" | "fork",
 *   readonly lifecycle: string,
 *   readonly gates: number,
 *   readonly title?: string | null,
 *   readonly replyId: number | null,
 *   readonly archived: boolean,
 * }} WorkbenchSession
 */

/** @param {WorkbenchSession} session @param {boolean} hasModelChildren */
export function isUntouchedDraftWorkbenchSession(session, hasModelChildren) {
    return session.parentSessionId === null
        && session.kind === "root"
        && session.lifecycle === "idle"
        && session.replyId === null
        && !(typeof session.title === "string" && session.title.trim() !== "")
        && session.gates === 0
        && !hasModelChildren;
}

/** @param {WorkbenchSession} session @param {string | null} selectedSession @param {boolean} isDraft */
export function isVisibleInTabStrip(session, selectedSession, isDraft) {
    if (session.name === selectedSession) return true;
    if (session.archived || isDraft) return false;
    if (session.parentSessionId === null || session.kind === "root" || session.kind === "fork") return true;
    return ["queued", "running", "parked", "failed"].includes(session.lifecycle) || session.gates > 0;
}

/**
 * {§web-workspace-tabs} Order unarchived model sessions by creation (`id ASC`) with children grouped immediately after their parent.
 * @param {ReadonlyMap<number, WorkbenchSession>} sessionsById
 * @returns {WorkbenchSession[]}
 */
export function computeOrderedUnarchived(sessionsById) {
    const unarchived = [...sessionsById.values()]
        .filter((entry) => {
            if (entry.archived) return false;
            const visited = new Set([entry.id]);
            let cursor = entry;
            while (cursor.parentSessionId !== null && cursor.parentSessionId !== 0) {
                if (visited.has(cursor.parentSessionId)) return false;
                visited.add(cursor.parentSessionId);
                const parent = sessionsById.get(cursor.parentSessionId);
                if (!parent) break;
                if (parent.archived) return false;
                cursor = parent;
            }
            return true;
        })
        .toSorted((a, b) => a.id - b.id);
    const unarchivedIds = new Set(unarchived.map(({ id }) => id));
    const childrenByParent = Map.groupBy(
        unarchived,
        (entry) => entry.parentSessionId !== null && unarchivedIds.has(entry.parentSessionId) ? entry.parentSessionId : null,
    );
    /** @type {WorkbenchSession[]} */
    const ordered = [];
    /** @param {number | null} parentId */
    const visit = (parentId) => {
        for (const entry of childrenByParent.get(parentId) ?? []) {
            ordered.push(entry);
            visit(entry.id);
        }
    };
    visit(null);
    return ordered;
}

/**
 * {§web-directory-documents} Select the initial session when no `#<session>` fragment is provided.
 * @param {readonly WorkbenchSession[]} allModelSessions
 * @returns {WorkbenchSession | undefined}
 */
export function selectInitialWorkbenchSession(allModelSessions) {
    const unarchivedModel = allModelSessions.filter(({ archived }) => !archived);
    const childParents = new Set(unarchivedModel.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
    const withReplyShape = (/** @type {WorkbenchSession} */ entry) => ({
        ...entry,
        reply: entry.replyId !== null ? { id: entry.replyId } : null,
    });
    const unarchivedRoots = unarchivedModel
        .filter(({ parentSessionId }) => parentSessionId === null)
        .toSorted((a, b) => orderByReply(withReplyShape(a), withReplyShape(b)) || a.id - b.id);
    const nonDraftRoots = unarchivedRoots.filter((entry) => !isUntouchedDraftSession(withReplyShape(entry), childParents.has(entry.id)));
    const candidateRoots = nonDraftRoots.length > 0 ? nonDraftRoots : unarchivedRoots;
    return candidateRoots.find(({ replyId }) => replyId !== null)
        ?? candidateRoots.find(({ name }) => name === "session1")
        ?? candidateRoots[0]
        ?? unarchivedModel.toSorted((a, b) => orderByReply(withReplyShape(a), withReplyShape(b)) || a.id - b.id)[0]
        ?? allModelSessions[0];
}

/**
 * @param {ParentNode} listRoot
 * @param {Map<number, WorkbenchSession>} sessionsById
 */
export function hydrateSessionsFromTabList(listRoot, sessionsById) {
    for (const item of $$(listRoot, ":scope > li[data-tab-id]")) {
        if (!(item instanceof HTMLLIElement)) continue;
        const idMatch = /^(\d+):(\d+)$/u.exec(item.dataset.tabId ?? "");
        if (!idMatch) continue;
        const id = Number(idMatch[2]);
        const link = $(item, "a[data-tab-session]");
        const name = link instanceof HTMLElement ? (link.dataset.tabSession ?? String(id)) : String(id);
        const rawParent = item.dataset.parentId;
        const parentSessionId = rawParent && /^\d+$/u.test(rawParent) ? Number(rawParent) : null;
        const parentName = item.dataset.parentName ?? null;
        const parentOrigin = item.dataset.parentOrigin ?? null;
        const kind = asSessionKind(item.dataset.sessionKind) ?? (parentSessionId === null ? "root" : "work");
        const lifecycle = $(item, "[data-lifecycle]")?.getAttribute("data-lifecycle") ?? "idle";
        const rawGates = $(item, "[data-session-gates]")?.getAttribute("data-session-gates");
        const gates = rawGates && /^\d+$/u.test(rawGates) ? Number(rawGates) : 0;
        const title = item.dataset.sessionTitle ?? null;
        const rawReply = item.dataset.replyId;
        const replyId = rawReply && /^\d+$/u.test(rawReply) ? Number(rawReply) : null;
        const archived = item.dataset.archived === "true";
        sessionsById.set(id, { id, name, parentSessionId, parentName, parentOrigin, kind, lifecycle, gates, title, replyId, archived });
    }
}

/**
 * @param {string | undefined} rawFolded
 * @param {Map<number, WorkbenchSession>} sessionsById
 */
export function hydrateFoldedSessions(rawFolded, sessionsById) {
    if (!rawFolded) return;
    try {
        const parsed = JSON.parse(rawFolded);
        if (Array.isArray(parsed)) {
            for (const raw of parsed) {
                if (!isRecord(raw) || typeof raw.id !== "number" || typeof raw.name !== "string") continue;
                const parentSessionId = typeof raw.parentSessionId === "number" ? raw.parentSessionId : null;
                sessionsById.set(raw.id, {
                    id: raw.id,
                    name: raw.name,
                    parentSessionId,
                    parentName: typeof raw.parentName === "string" ? raw.parentName : null,
                    parentOrigin: typeof raw.parentOrigin === "string" ? raw.parentOrigin : null,
                    kind: asSessionKind(raw.kind) ?? (parentSessionId === null ? "root" : "work"),
                    lifecycle: typeof raw.lifecycle === "string" ? raw.lifecycle : "idle",
                    gates: typeof raw.gates === "number" ? raw.gates : 0,
                    title: typeof raw.title === "string" ? raw.title : null,
                    replyId: typeof raw.replyId === "number" ? raw.replyId : null,
                    archived: raw.archived === true,
                });
            }
        }
    } catch { /* ignore malformed metadata */ }
}

/**
 * {§web-directory-documents} Hydrate `sessionsById` from a single `/acp` `session/list` (`archived: "include"`) call for `workspaceName`.
 * @param {string} workspaceName
 * @param {AbortSignal} signal
 * @param {Map<number, WorkbenchSession>} sessionsById
 */
export async function loadWorkbenchSessionsFromAcp(workspaceName, signal, sessionsById) {
    const overviewRes = await managementAction("session/list", {
        archived: "include",
        _meta: { plurnk: { workspaceName, limit: 1000 } },
    }, "", signal);

    const rawOverviewSessions = isRecord(overviewRes) && Array.isArray(overviewRes.sessions) ? overviewRes.sessions : [];
    sessionsById.clear();
    for (const item of rawOverviewSessions) {
        if (!isRecord(item)) continue;
        const meta = isRecord(item._meta) && isRecord(item._meta.plurnk) ? item._meta.plurnk : null;
        if (!meta || typeof meta.id !== "number" || typeof meta.name !== "string") continue;
        const parentSessionId = typeof meta.parentSessionId === "number" ? meta.parentSessionId : null;
        const resolvedTitle = typeof meta.title === "string" && meta.title.trim() !== ""
            ? meta.title.trim()
            : null;
        const replyId = isRecord(meta.reply) && typeof meta.reply.id === "number" ? meta.reply.id : null;
        sessionsById.set(meta.id, {
            id: meta.id,
            name: meta.name,
            parentSessionId,
            parentName: typeof meta.parentName === "string" ? meta.parentName : null,
            parentOrigin: asSessionOrigin(meta.parentOrigin),
            kind: asSessionKind(meta.kind) ?? (parentSessionId === null ? "root" : "work"),
            lifecycle: typeof meta.lifecycle === "string" ? meta.lifecycle : "idle",
            gates: typeof meta.gates === "number" ? meta.gates : 0,
            title: resolvedTitle,
            replyId,
            archived: item.archived === true || meta.archived === true,
        });
    }
}

/**
 * {§web-workspace-tabs} Apply a live `/notifications/<workspace>` Watch SSE event to `sessionsById` and workspace metadata.
 * @param {unknown} raw
 * @param {{
 *   readonly workspaceId: number,
 *   readonly sessionsById: Map<number, WorkbenchSession>,
 *   readonly onWorkspaceRenamed: (name: string) => void,
 *   readonly onWorkspaceMetaFromSession: (meta: { workspaceName?: string, projectRoot?: string | null, projectLabel?: string | null }) => void,
 *   readonly onSessionDeleted: (id: number, existing: WorkbenchSession | undefined) => void,
 *   readonly onReconcileTabs: () => void,
 *   readonly onSyncHeaderPlace: () => void,
 *   readonly onResync: () => void,
 * }} ctx
 */
export function applyWorkbenchNotification(raw, ctx) {
    if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) return;
    const { event, data } = raw;
    const notifWorkspaceId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
    const notifSessionId = typeof raw.sessionId === "number" ? raw.sessionId : null;
    const { workspaceId, sessionsById } = ctx;

    switch (event) {
        case "notifications/snapshot": {
            if (typeof data.reason === "string" && data.reason !== "initial") {
                ctx.onResync();
                return;
            }
            const rawWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
            const wsMeta = rawWorkspaces.find((ws) => isRecord(ws) && ws.id === workspaceId);
            if (isRecord(wsMeta)) {
                ctx.onWorkspaceMetaFromSession({
                    ...(typeof wsMeta.name === "string" ? { workspaceName: wsMeta.name } : {}),
                    ...(typeof wsMeta.projectRoot === "string" || wsMeta.projectRoot === null
                        ? { projectRoot: wsMeta.projectRoot }
                        : {}),
                    ...(typeof wsMeta.projectLabel === "string" || wsMeta.projectLabel === null
                        ? { projectLabel: wsMeta.projectLabel }
                        : {}),
                });
            }
            const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
            let changed = false;
            for (const s of rawSessions) {
                if (!isRecord(s) || s.workspaceId !== workspaceId || typeof s.id !== "number" || typeof s.name !== "string") {
                    continue;
                }
                const prev = sessionsById.get(s.id);
                const parentSessionId = typeof s.parentSessionId === "number" ? s.parentSessionId : null;
                const title = typeof s.title === "string" && s.title.trim() !== "" ? s.title.trim() : (prev?.title ?? null);
                const replyId = isRecord(s.reply) && typeof s.reply.id === "number" ? s.reply.id : (prev?.replyId ?? null);
                const lifecycle = typeof s.lifecycle === "string" ? s.lifecycle : (prev?.lifecycle ?? "idle");
                const gates = typeof s.gates === "number" ? s.gates : (prev?.gates ?? 0);
                sessionsById.set(s.id, {
                    id: s.id,
                    name: s.name,
                    parentSessionId,
                    parentName: typeof s.parentName === "string" ? s.parentName : (prev?.parentName ?? null),
                    parentOrigin: asSessionOrigin(s.parentOrigin) ?? prev?.parentOrigin ?? null,
                    kind: asSessionKind(s.kind) ?? prev?.kind ?? (parentSessionId === null ? "root" : "work"),
                    lifecycle,
                    gates,
                    title,
                    replyId,
                    archived: false,
                });
                changed = true;
            }
            if (changed) {
                ctx.onReconcileTabs();
                ctx.onSyncHeaderPlace();
            }
            return;
        }
        case "notifications/resync": {
            ctx.onResync();
            return;
        }
        case "workspace/renamed": {
            const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
            const name = typeof data.name === "string" ? data.name : null;
            if (id !== workspaceId || name === null) return;
            ctx.onWorkspaceRenamed(name);
            ctx.onReconcileTabs();
            return;
        }
        case "session/created": {
            const id = typeof data.id === "number" ? data.id : notifSessionId;
            const wsId = typeof data.workspaceId === "number" ? data.workspaceId : notifWorkspaceId;
            if (id === null || wsId !== workspaceId || typeof data.name !== "string") return;
            ctx.onWorkspaceMetaFromSession({
                ...(typeof data.workspaceName === "string" ? { workspaceName: data.workspaceName } : {}),
                ...(typeof data.projectRoot === "string" || data.projectRoot === null ? { projectRoot: data.projectRoot } : {}),
                ...(typeof data.projectLabel === "string" || data.projectLabel === null ? { projectLabel: data.projectLabel } : {}),
            });
            if (data.origin !== "model") return;
            const parentSessionId = typeof data.parentSessionId === "number" ? data.parentSessionId : null;
            const parentEntry = parentSessionId !== null ? sessionsById.get(parentSessionId) : undefined;
            const kind = asSessionKind(data.kind) ?? (parentSessionId === null ? "root" : "work");
            const lifecycle = typeof data.lifecycle === "string" ? data.lifecycle : "idle";
            const title = typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim() : null;
            const prev = sessionsById.get(id);
            sessionsById.set(id, {
                id,
                name: data.name,
                parentSessionId,
                parentName: parentSessionId === null ? null : (parentEntry?.name ?? prev?.parentName ?? "_plurnk"),
                parentOrigin: parentSessionId === null ? null : (parentEntry !== undefined ? "model" : (prev?.parentOrigin ?? "_plurnk")),
                kind,
                lifecycle: prev?.lifecycle && prev.lifecycle !== "idle" ? prev.lifecycle : lifecycle,
                gates: prev?.gates ?? 0,
                title: title ?? prev?.title ?? null,
                replyId: prev?.replyId ?? null,
                archived: false,
            });
            ctx.onReconcileTabs();
            return;
        }
        case "session/titled": {
            if (notifWorkspaceId !== workspaceId) return;
            const sid = typeof data.id === "number" ? data.id : notifSessionId;
            if (sid === null) return;
            const cur = sessionsById.get(sid);
            if (!cur) return;
            const nextTitle = typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim() : null;
            if ((cur.title ?? null) === nextTitle) return;
            sessionsById.set(sid, { ...cur, title: nextTitle });
            ctx.onReconcileTabs();
            ctx.onSyncHeaderPlace();
            return;
        }
        case "session/archived": {
            if (notifWorkspaceId !== workspaceId) return;
            const isArchived = data.archivedAt !== null && data.archivedAt !== undefined;
            const ids = Array.isArray(data.sessionIds) ? data.sessionIds : (typeof data.id === "number" ? [data.id] : []);
            let changed = false;
            for (const sid of ids) {
                if (typeof sid !== "number") continue;
                const cur = sessionsById.get(sid);
                if (cur && cur.archived !== isArchived) {
                    sessionsById.set(sid, { ...cur, archived: isArchived });
                    changed = true;
                }
            }
            if (changed) ctx.onReconcileTabs();
            return;
        }
        case "session/deleted": {
            if (notifWorkspaceId !== workspaceId) return;
            const ids = Array.isArray(data.sessionIds) ? data.sessionIds : (typeof data.id === "number" ? [data.id] : []);
            let changed = false;
            for (const sid of ids) {
                if (typeof sid !== "number") continue;
                const existing = sessionsById.get(sid);
                ctx.onSessionDeleted(sid, existing);
                if (sessionsById.delete(sid)) {
                    changed = true;
                }
            }
            if (changed) ctx.onReconcileTabs();
            return;
        }
        case "session/replied": {
            if (notifWorkspaceId !== workspaceId) return;
            const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
            const replyId = isRecord(data.reply) && typeof data.reply.id === "number" ? data.reply.id : null;
            if (sid === null || replyId === null) return;
            const cur = sessionsById.get(sid);
            if (!cur || (cur.replyId !== null && cur.replyId >= replyId)) return;
            sessionsById.set(sid, { ...cur, replyId });
            ctx.onReconcileTabs();
            return;
        }
        case "loop/proposal":
        case "loop/interaction": {
            if (notifWorkspaceId !== workspaceId || notifSessionId === null) return;
            if (event === "loop/proposal" && isRecord(data.disposition) && data.disposition.decision !== "review") return;
            const cur = sessionsById.get(notifSessionId);
            if (!cur) return;
            sessionsById.set(notifSessionId, { ...cur, lifecycle: "running", gates: cur.gates + 1 });
            ctx.onReconcileTabs();
            return;
        }
        case "loop/gate-settled": {
            if (notifWorkspaceId !== workspaceId) return;
            const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
            if (sid === null) return;
            const cur = sessionsById.get(sid);
            if (!cur || cur.gates <= 0) return;
            sessionsById.set(sid, { ...cur, gates: Math.max(0, cur.gates - 1) });
            ctx.onReconcileTabs();
            return;
        }
        case "loop/started":
        case "loop/parked": {
            if (notifWorkspaceId !== workspaceId) return;
            const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
            if (sid === null) return;
            const cur = sessionsById.get(sid);
            if (!cur) return;
            const lifecycle = event === "loop/parked" ? "parked" : "running";
            if (cur.lifecycle !== lifecycle) {
                sessionsById.set(sid, { ...cur, lifecycle });
                ctx.onReconcileTabs();
            }
            return;
        }
        case "loop/terminated": {
            if (notifWorkspaceId !== workspaceId) return;
            const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
            if (sid === null) return;
            const cur = sessionsById.get(sid);
            if (!cur) return;
            const status = isRecord(data.result) && typeof data.result.status === "number" ? data.result.status : 200;
            const lifecycle = lifecycleOfLoopStatus(status);
            if (cur.lifecycle !== lifecycle || cur.gates !== 0) {
                sessionsById.set(sid, { ...cur, lifecycle, gates: 0 });
                ctx.onReconcileTabs();
            }
            return;
        }
        default:
            return;
    }
}
