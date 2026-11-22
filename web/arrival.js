import { DEFAULT_SESSION_NAME, directoryPath, nextSequentialName } from "../src/directory-addresses.js";
import renderInPageError from "./error-view.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import { isUntouchedDraftSession, orderByReply } from "./session-selection.js";
import { parseWorkspaceList } from "./workspace-dialogs.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * {§web-arrival} Resolve `/` over `/acp`:
 * 1. Query `session/list` (`archived: "exclude"`) and pick the most recently active unarchived root model session (preferring non-drafts over untouched drafts).
 * 2. When zero unarchived model sessions exist, reuse an unarchived workspace (or allocate one via `workspace.create` `{ projectRoot: null }`), allocate a starter session via `session/new`, and `location.replace(...)` to it.
 *
 * @param {HTMLElement} main
 */
export default async function resolveArrival(main) {
    const controller = new AbortController();
    const { signal } = controller;
    try {
        const overview = await managementAction("session/list", {
            archived: "exclude",
            _meta: { plurnk: { limit: 1000 } },
        }, "", signal, { returnTo: "/" });

        const rawSessions = isRecord(overview) && Array.isArray(overview.sessions) ? overview.sessions : [];
        /**
         * @type {Array<{
         *   id: number,
         *   name: string,
         *   workspaceName: string,
         *   parentSessionId: number | null,
         *   kind: string,
         *   lifecycle: string,
         *   gates: number,
         *   title?: string,
         *   reply: { id: number } | null,
         * }>}
         */
        const candidates = [];
        for (const item of rawSessions) {
            if (!isRecord(item)) continue;
            const meta = isRecord(item._meta) && isRecord(item._meta.plurnk) ? item._meta.plurnk : null;
            if (!meta || typeof meta.id !== "number" || typeof meta.name !== "string" || typeof meta.workspaceName !== "string") continue;
            const reply = isRecord(meta.reply) && typeof meta.reply.id === "number" ? { id: meta.reply.id } : null;
            candidates.push({
                id: meta.id,
                name: meta.name,
                workspaceName: meta.workspaceName,
                parentSessionId: typeof meta.parentSessionId === "number" ? meta.parentSessionId : null,
                kind: typeof meta.kind === "string" ? meta.kind : (typeof meta.parentSessionId === "number" ? "work" : "root"),
                lifecycle: typeof meta.lifecycle === "string" ? meta.lifecycle : "idle",
                gates: typeof meta.gates === "number" ? meta.gates : 0,
                ...(typeof meta.title === "string" ? { title: meta.title } : {}),
                reply,
            });
        }

        if (candidates.length > 0) {
            const childParents = new Set(candidates.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
            const nonDraft = candidates.filter((entry) => !isUntouchedDraftSession(entry, childParents.has(entry.id)));
            const pool = nonDraft.length > 0 ? nonDraft : candidates;
            const roots = pool.filter(({ parentSessionId }) => parentSessionId === null).toSorted(orderByReply);
            const chosen = roots[0] ?? pool.toSorted(orderByReply)[0];
            if (chosen !== undefined) {
                const target = directoryPath({ kind: "session", workspace: chosen.workspaceName, session: chosen.name });
                if (target !== null) {
                    location.replace(target);
                    return;
                }
            }
        }

        const listedWorkspaces = parseWorkspaceList(
            await managementAction("workspace.list", { includeArchived: true }, "", signal, { returnTo: "/" }),
        );
        const existingWs = listedWorkspaces.find(({ archived_at, project_root }) => archived_at === null && project_root === null)
            ?? listedWorkspaces.find(({ archived_at }) => archived_at === null);

        /** @type {string} */
        let wsName;
        /** @type {Set<string>} */
        const seenSessions = new Set();

        if (existingWs !== undefined) {
            wsName = existingWs.name;
            const wsSessionsRes = await managementAction(
                "workspace.sessions",
                { workspaceId: existingWs.id, includeArchived: true },
                "",
                signal,
                { workspaceId: existingWs.id, returnTo: "/" },
            );
            const rawWsSessions = isRecord(wsSessionsRes) && Array.isArray(wsSessionsRes.sessions) ? wsSessionsRes.sessions : [];
            for (const s of rawWsSessions) {
                if (!isRecord(s) || typeof s.name !== "string") continue;
                seenSessions.add(s.name);
                if (s.origin === "model" && (s.archived_at === null || s.archived_at === undefined)) {
                    const existingLoc = directoryPath({ kind: "session", workspace: wsName, session: s.name });
                    if (existingLoc !== null) {
                        location.replace(existingLoc);
                        return;
                    }
                }
            }
        } else {
            const seenWorkspaces = new Set(listedWorkspaces.map(({ name }) => name));
            /** @type {unknown} */
            let createdWs = null;
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const candidate = nextSequentialName("workspace", seenWorkspaces);
                try {
                    createdWs = await managementAction("workspace.create", { name: candidate, projectRoot: null }, "", signal, { returnTo: "/" });
                    break;
                } catch (error) {
                    if (Reflect.get(Object(error), "status") === 409 && attempt < 7) {
                        seenWorkspaces.add(candidate);
                        continue;
                    }
                    throw error;
                }
            }
            wsName = isRecord(createdWs) && typeof createdWs.workspaceName === "string" && createdWs.workspaceName !== ""
                ? createdWs.workspaceName
                : "workspace1";
        }

        /** @type {unknown} */
        let createdSession = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const candidate = seenSessions.size === 0 && attempt === 0
                ? DEFAULT_SESSION_NAME
                : nextSequentialName("session", seenSessions);
            try {
                createdSession = await managementAction("session/new", {
                    _meta: { plurnk: { workspace: wsName, sessionName: candidate } },
                }, "", signal, { returnTo: "/" });
                break;
            } catch (error) {
                if (Reflect.get(Object(error), "status") === 409 && attempt < 7) {
                    seenSessions.add(candidate);
                    continue;
                }
                throw error;
            }
        }

        const rawSessionId = isRecord(createdSession) && typeof createdSession.sessionId === "string"
            ? createdSession.sessionId
            : "";
        const freshName = rawSessionId.includes("#")
            ? (rawSessionId.split("#")[1] || DEFAULT_SESSION_NAME)
            : DEFAULT_SESSION_NAME;
        const loc = directoryPath({ kind: "session", workspace: wsName, session: freshName });
        if (loc === null) throw new Error("Starter session has no representable directory address.");
        location.replace(loc);
    } catch (error) {
        if (signal.aborted || Reflect.get(Object(error), "status") === 401) return;
        const { message, recovery } = await describeFailure(error);
        const status = typeof Reflect.get(Object(error), "status") === "number"
            ? /** @type {number} */ (Reflect.get(Object(error), "status"))
            : 502;
        renderInPageError(main, status, message, recovery);
    }
}
