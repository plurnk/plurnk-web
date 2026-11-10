import { $, $$, on, the } from "on_the_money";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import accessHeaders from "./access-headers.js";
import card from "./card.js";
import markdown from "./markdown.js";
import problemFromResponse from "./problem-response.js";
import readBody from "./read-body.js";

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly coordinate: string,
 *   readonly completion: 200 | 499,
 * }} OverviewReply
 */

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly workspaceId: number,
 *   readonly workspaceName: string,
 *   readonly projectRoot: string | null,
 *   readonly name: string,
 *   readonly parentSessionId: number | null,
 *   readonly origin: "model" | "_plurnk",
 *   readonly lifecycle: string,
 *   readonly reply: OverviewReply | null,
 * }} OverviewSession
 */

const NOTIFICATION_EVENTS = [
    "workspace/renamed",
    "workspace/archived",
    "session/created",
    "session/archived",
    "session/deleted",
    "loop/terminated",
    "loop/proposal",
    "loop/interaction",
    "log/entry",
].join(",");

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {OverviewSession} a @param {OverviewSession} b */
const orderSessions = (a, b) => a.reply !== null && b.reply !== null ? b.reply.id - a.reply.id
    : a.reply !== null ? -1 : b.reply !== null ? 1 : 0;

/** {§web-session-directory} Live session dashboard and on-demand reply disclosure on `/` and `/~/<workspace>/`.
 * @param {HTMLElement} main
 */
export default function observeOverview(main) {
    const { auth: rawAuth, workspaceId: rawWorkspaceId } = main.dataset;
    if (rawAuth !== "session" && rawAuth !== "none") throw new Error("Overview document metadata is incomplete.");
    const auth = rawAuth;
    const workspaceId = rawWorkspaceId && /^[1-9]\d*$/u.test(rawWorkspaceId) ? Number(rawWorkspaceId) : undefined;
    let resources = new AbortController();
    /** @type {Map<string, HTMLLIElement>} */
    const rowsByKey = new Map();
    /** @type {Map<number, { name: string, projectRoot: string | null, projectLabel: string | null }>} */
    const workspacesById = new Map();
    /** @type {Map<string, OverviewSession>} */
    const sessionsByKey = new Map();
    /** @type {WeakMap<Element, symbol>} */
    const activeTokens = new WeakMap();
    /** @type {WeakMap<Element, string>} */
    const inFlight = new WeakMap();
    let replyCounter = 0;

    /** @param {HTMLElement} outlet */
    async function loadReply(outlet) {
        const address = outlet.getAttribute("data-session-reply");
        if (!address || outlet.dataset.replyLoaded === address || inFlight.get(outlet) === address) return;
        const token = Symbol("reply-read");
        activeTokens.set(outlet, token);
        inFlight.set(outlet, address);
        the(outlet, "bodyState", "loading");
        outlet.setAttribute("aria-busy", "true");
        outlet.removeAttribute("role");
        outlet.replaceChildren();
        try {
            const source = await readBody(address, auth, resources.signal);
            if (!outlet.isConnected || activeTokens.get(outlet) !== token || outlet.getAttribute("data-session-reply") !== address) return;
            outlet.replaceChildren(markdown(source, `reply-${++replyCounter}`));
            outlet.dataset.replyLoaded = address;
            the(outlet, "bodyState", "loaded");
        } catch (error) {
            if (!outlet.isConnected || activeTokens.get(outlet) !== token || outlet.getAttribute("data-session-reply") !== address) return;
            if (error instanceof DOMException && error.name === "AbortError") return;
            const message = $.clone(outlet, "#conversation-literal");
            message.textContent = error instanceof Error ? error.message : String(error);
            message.setAttribute("role", "alert");
            the(outlet, "bodyState", "error");
            const retry = $.clone(outlet, "#conversation-body-retry");
            on(retry, "submit", "form", (event) => {
                event.preventDefault();
                void loadReply(outlet);
            });
        } finally {
            if (activeTokens.get(outlet) === token) {
                inFlight.delete(outlet);
                if (outlet.isConnected) outlet.removeAttribute("aria-busy");
            }
        }
    }

    /** @param {HTMLDetailsElement} details */
    function bindDisclosure(details) {
        details.ontoggle = () => {
            if (!details.open) return;
            const outlet = $(details, ":scope > [data-session-reply]");
            if (outlet instanceof HTMLElement) void loadReply(outlet);
        };
        if (details.open) {
            const outlet = $(details, ":scope > [data-session-reply]");
            if (outlet instanceof HTMLElement) void loadReply(outlet);
        }
    }

    function hydrateFromDom() {
        if (workspaceId !== undefined) {
            const crumbName = $('header nav[aria-label="breadcrumb"] [aria-current="page"][data-text="name"]');
            const marker = crumbName?.previousElementSibling;
            const labelEl = $(main, '[data-text="project-label"]');
            const name = crumbName?.textContent ?? String(workspaceId);
            const projectLabel = labelEl?.textContent ?? (marker?.getAttribute("aria-label") === "Project workspace" ? name : null);
            workspacesById.set(workspaceId, { name, projectRoot: projectLabel, projectLabel });
        }
        for (const row of $$(main, 'li[data-directory-entry="session"]')) {
            if (!(row instanceof HTMLLIElement)) continue;
            const details = $(row, ":scope > article > details");
            if (details instanceof HTMLDetailsElement) bindDisclosure(details);
            const rawKey = row.dataset.sessionKey ?? "";
            const keyMatch = /^(\d+):(\d+)$/u.exec(rawKey);
            if (!keyMatch) continue;
            const wsId = Number(keyMatch[1]);
            const id = Number(keyMatch[2]);
            const key = `${wsId}:${id}`;
            rowsByKey.set(key, row);

            const parentRow = row.parentElement?.closest('li[data-directory-entry="session"]');
            const parentKeyMatch = parentRow instanceof HTMLLIElement && parentRow.dataset.sessionKey
                ? /^(\d+):(\d+)$/u.exec(parentRow.dataset.sessionKey)
                : null;
            const enclosingDetails = row.closest("details");
            const isBackground = parentKeyMatch === null && enclosingDetails instanceof HTMLDetailsElement
                && $(enclosingDetails, ':scope > summary[data-i18n="background-work"]') !== null;
            const parentSessionId = parentKeyMatch ? Number(parentKeyMatch[2]) : isBackground ? 0 : null;

            const article = $(row, ":scope > article");
            const headerOrSummary = article ? $(article, ":scope > header, :scope > details > summary") : null;
            const identity = headerOrSummary ? $(headerOrSummary, "[data-session-identity]") : null;
            const workspaceSpan = headerOrSummary ? $(headerOrSummary, "[data-session-workspace]") : null;
            const name = (identity ? $(identity, ":scope > span:last-child")?.textContent : null) ?? String(id);
            const lifecycle = (identity ? $(identity, "[data-lifecycle]")?.getAttribute("data-lifecycle") : null) ?? "idle";
            const workspaceName = (workspaceSpan ? $(workspaceSpan, '[data-text="name"]')?.textContent : null)
                ?? workspacesById.get(wsId)?.name ?? String(wsId);
            const hasFolder = workspaceSpan ? $(workspaceSpan, "[data-folder]")?.getAttribute("data-folder") === "true" : false;
            const projectRoot = hasFolder ? (workspacesById.get(wsId)?.projectRoot ?? "/") : null;
            if (!workspacesById.has(wsId)) {
                workspacesById.set(wsId, { name: workspaceName, projectRoot, projectLabel: projectRoot });
            }

            const replyEl = article ? $(article, ":scope > details > [data-session-reply]") : null;
            const replyAttr = replyEl?.getAttribute("data-session-reply") ?? null;
            const rawReplyId = row.dataset.replyId;
            /** @type {OverviewReply | null} */
            let reply = null;
            if (replyAttr) {
                const targetParam = new URL(replyAttr, location.origin).searchParams.get("target");
                const coordinate = targetParam?.startsWith("log:///") ? targetParam.slice("log:///".length) : null;
                const replyId = rawReplyId && /^\d+$/u.test(rawReplyId)
                    ? Number(rawReplyId)
                    : coordinate && /:(\d+)$/u.test(coordinate) ? Number(coordinate.split(":").at(-1)) : null;
                if (coordinate !== null && replyId !== null) {
                    reply = { id: replyId, coordinate, completion: 200 };
                }
            }

            sessionsByKey.set(key, {
                id,
                workspaceId: wsId,
                workspaceName,
                projectRoot,
                name,
                parentSessionId,
                origin: "model",
                lifecycle,
                reply,
            });
        }
    }

    function reconcileDom() {
        if (workspaceId !== undefined) {
            const currentWs = workspacesById.get(workspaceId);
            if (currentWs) {
                the("page-title", `${currentWs.name} — Plurnk`);
                const crumbName = $('header nav[aria-label="breadcrumb"] [aria-current="page"][data-text="name"]');
                if (crumbName) {
                    if (crumbName.textContent !== currentWs.name) crumbName.textContent = currentWs.name;
                    const marker = crumbName.previousElementSibling;
                    if (marker) {
                        const separateFolder = currentWs.projectLabel !== null && currentWs.projectLabel !== currentWs.name;
                        const icon = separateFolder ? "☁️" : currentWs.projectRoot !== null ? "🗂️" : "☁️";
                        const label = separateFolder ? "Workspace" : currentWs.projectRoot !== null ? "Project workspace" : "Folderless workspace";
                        if (marker.textContent !== icon) marker.textContent = icon;
                        if (marker.getAttribute("aria-label") !== label) marker.setAttribute("aria-label", label);
                    }
                }
                for (const input of $$(main, 'dialog form input[name="workspace"]')) {
                    if (input instanceof HTMLInputElement) input.value = currentWs.name;
                }
            }
        }
        const models = [...sessionsByKey.values()].toSorted(orderSessions);
        /** @type {Map<number, OverviewSession>} */
        const byId = new Map(models.map((session) => [session.id, session]));
        for (const session of models) {
            if (session.parentSessionId !== null && !byId.has(session.parentSessionId)) {
                byId.set(session.parentSessionId, {
                    id: session.parentSessionId,
                    workspaceId: session.workspaceId,
                    workspaceName: session.workspaceName,
                    projectRoot: session.projectRoot,
                    name: "_plurnk",
                    parentSessionId: null,
                    origin: "_plurnk",
                    lifecycle: "idle",
                    reply: null,
                });
            }
        }
        const children = Map.groupBy(models, ({ parentSessionId }) => parentSessionId);
        const background = models.filter((session) => {
            if (session.parentSessionId === null) return false;
            const parent = byId.get(session.parentSessionId);
            return parent !== undefined && parent.origin !== "model";
        });
        /** @type {Set<HTMLLIElement>} */
        const claimedRows = new Set();

        /** @param {Element} list @param {OverviewSession} session */
        const findOrCloneRow = (list, session) => {
            const key = `${session.workspaceId}:${session.id}`;
            let row = rowsByKey.get(key);
            if (!row || !row.isConnected) {
                const byKey = $(main, `li[data-directory-entry="session"][data-session-key="${CSS.escape(key)}"]`);
                if (byKey instanceof HTMLLIElement && !claimedRows.has(byKey)) {
                    row = byKey;
                } else {
                    const path = directoryPath({ kind: "session", workspace: session.workspaceName, session: session.name });
                    if (path !== null) {
                        const link = $(main, `li[data-directory-entry="session"] a[data-session-link][href="${CSS.escape(path)}"]`);
                        const existing = link?.closest('li[data-directory-entry="session"]');
                        if (existing instanceof HTMLLIElement && !claimedRows.has(existing)) {
                            row = existing;
                        }
                    }
                }
                row ??= /** @type {HTMLLIElement} */ ($.clone(list, "#session-card"));
                rowsByKey.set(key, row);
            }
            row.dataset.sessionKey = key;
            if (session.reply !== null) row.dataset.replyId = String(session.reply.id);
            else delete row.dataset.replyId;
            claimedRows.add(row);
            return row;
        };

        /** @param {HTMLLIElement} row @param {OverviewSession} session */
        const reconcileCard = (row, session) => {
            const descendants = children.get(session.id) ?? [];
            const parent = session.parentSessionId === null ? null : byId.get(session.parentSessionId) ?? null;
            const hasBody = descendants.length > 0 || session.reply !== null;
            const { header, body } = card(row, hasBody);
            const identity = $(header, "[data-session-identity]");
            const workspaceSpan = $(header, "[data-session-workspace]");
            if (identity) {
                const link = $(identity, "[data-session-link]");
                const sessionPath = directoryPath({ kind: "session", workspace: session.workspaceName, session: session.name });
                if (link && sessionPath !== null) {
                    if (link.getAttribute("href") !== sessionPath) link.setAttribute("href", sessionPath);
                    if (link.getAttribute("aria-label") !== session.name) link.setAttribute("aria-label", session.name);
                    const title = `Open session ${session.name}`;
                    if (link.getAttribute("title") !== title) link.setAttribute("title", title);
                }
                const lifecycleEl = $(identity, "[data-lifecycle]");
                if (lifecycleEl && lifecycleEl.getAttribute("data-lifecycle") !== session.lifecycle) {
                    lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
                    lifecycleEl.setAttribute("aria-label", session.lifecycle);
                    lifecycleEl.setAttribute("title", session.lifecycle);
                }
                const nameSpan = $(identity, ":scope > span:last-child");
                if (nameSpan && nameSpan.textContent !== session.name) {
                    nameSpan.textContent = session.name;
                }
                let parentSpan = $(identity, "[data-session-parent]");
                if (parent === null) {
                    parentSpan?.remove();
                } else if (nameSpan) {
                    const parentPath = parent.origin === "model"
                        ? directoryPath({ kind: "session", workspace: session.workspaceName, session: parent.name })
                        : null;
                    if (parentPath !== null) {
                        let parentLink = parentSpan ? $(parentSpan, "a") : null;
                        if (!parentSpan || !parentLink) {
                            parentSpan?.remove();
                            parentSpan = $.clone(nameSpan, "#session-parent-link", { position: "beforebegin" });
                            parentLink = $(parentSpan, "a");
                        }
                        if (parentLink) {
                            if (parentLink.getAttribute("href") !== parentPath) parentLink.setAttribute("href", parentPath);
                            if (parentLink.getAttribute("data-session-name") !== parent.name) parentLink.setAttribute("data-session-name", parent.name);
                            if (parentLink.textContent !== parent.name) parentLink.textContent = parent.name;
                        }
                    } else {
                        let parentText = parentSpan && !$(parentSpan, "a") ? $(parentSpan, "span") : null;
                        if (!parentSpan || !parentText) {
                            parentSpan?.remove();
                            parentSpan = $.clone(nameSpan, "#session-parent-text", { position: "beforebegin" });
                            parentText = $(parentSpan, "span");
                        }
                        if (parentText && parentText.textContent !== parent.name) {
                            parentText.textContent = parent.name;
                        }
                    }
                }
            }
            if (workspaceSpan) {
                const folderEl = $(workspaceSpan, "[data-folder]");
                const folder = String(session.projectRoot !== null);
                const folderLabel = session.projectRoot !== null ? "Project workspace" : "Folderless workspace";
                if (folderEl) {
                    if (folderEl.getAttribute("data-folder") !== folder) folderEl.setAttribute("data-folder", folder);
                    if (folderEl.getAttribute("aria-label") !== folderLabel) folderEl.setAttribute("aria-label", folderLabel);
                }
                const wsLink = $(workspaceSpan, '[data-text="name"]');
                const wsPath = directoryPath({ kind: "workspace", workspace: session.workspaceName });
                if (wsLink) {
                    if (wsLink.textContent !== session.workspaceName) wsLink.textContent = session.workspaceName;
                    if (wsPath !== null && wsLink.getAttribute("href") !== wsPath) wsLink.setAttribute("href", wsPath);
                }
            }
            if (!(body instanceof HTMLDetailsElement)) return;
            let childList = $(body, ":scope > ul");
            const replyOutlet = $(body, ":scope > [data-session-reply]");
            if (descendants.length > 0) {
                if (!childList) {
                    childList = replyOutlet
                        ? $.clone(replyOutlet, "#overview-list", { position: "beforebegin" })
                        : $.clone(body, "#overview-list");
                }
                reconcileList(childList, descendants);
            } else {
                childList?.remove();
            }
            if (session.reply !== null) {
                const replyUrl = `/acp/${session.workspaceId}/${session.id}/entry?target=${encodeURIComponent(`log:///${session.reply.coordinate}`)}`;
                const replyElement = replyOutlet instanceof HTMLElement
                    ? replyOutlet
                    : /** @type {HTMLElement} */ ($.clone(body, "#session-reply"));
                if (replyElement.getAttribute("data-session-reply") !== replyUrl) {
                    replyElement.setAttribute("data-session-reply", replyUrl);
                    delete replyElement.dataset.replyLoaded;
                    activeTokens.delete(replyElement);
                    inFlight.delete(replyElement);
                    replyElement.removeAttribute("aria-busy");
                    replyElement.replaceChildren();
                }
                if (body.open) void loadReply(replyElement);
            } else {
                replyOutlet?.remove();
            }
            bindDisclosure(body);
        };

        /** @param {Element} list @param {readonly OverviewSession[]} entries */
        function reconcileList(list, entries) {
            for (const [index, session] of entries.entries()) {
                const row = findOrCloneRow(list, session);
                if (list.children[index] !== row) {
                    list.insertBefore(row, list.children[index] ?? null);
                }
                reconcileCard(row, session);
            }
            while (list.children.length > entries.length) {
                list.lastElementChild?.remove();
            }
        }

        const firstDialog = $(main, ":scope > dialog");
        const emptyEl = $(main, ':scope > p[data-i18n="no-sessions"]');
        let rootList = $(main, ":scope > ul");
        let backgroundDetails = $(main, ":scope > details");
        if (models.length === 0) {
            rootList?.remove();
            backgroundDetails?.remove();
            if (!emptyEl) {
                if (firstDialog) $.clone(firstDialog, "#overview-empty", { position: "beforebegin" });
                else $.clone(main, "#overview-empty");
            }
            return;
        }
        emptyEl?.remove();
        const roots = children.get(null) ?? [];
        if (roots.length > 0) {
            if (!rootList) {
                const anchor = backgroundDetails ?? firstDialog;
                rootList = anchor
                    ? $.clone(anchor, "#overview-list", { position: "beforebegin" })
                    : $.clone(main, "#overview-list");
            }
            reconcileList(rootList, roots);
        } else {
            rootList?.remove();
        }
        if (background.length > 0) {
            if (!backgroundDetails) {
                backgroundDetails = firstDialog
                    ? $.clone(firstDialog, "#overview-background", { position: "beforebegin" })
                    : $.clone(main, "#overview-background");
            }
            const bgList = $(backgroundDetails, ":scope > ul");
            if (bgList) reconcileList(bgList, background);
        } else {
            backgroundDetails?.remove();
        }
    }

    /** @param {unknown} raw */
    function applyNotification(raw) {
        if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) return;
        const { event, data } = raw;
        const notifWorkspaceId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
        const notifSessionId = typeof raw.sessionId === "number" ? raw.sessionId : null;

        switch (event) {
            case "workspace/renamed": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                const name = typeof data.name === "string" ? data.name : null;
                if (id === null || name === null) return;
                const prev = workspacesById.get(id);
                workspacesById.set(id, {
                    name,
                    projectRoot: prev?.projectRoot ?? null,
                    projectLabel: prev?.projectLabel ?? null,
                });
                for (const [key, session] of sessionsByKey.entries()) {
                    if (session.workspaceId === id) {
                        sessionsByKey.set(key, { ...session, workspaceName: name });
                    }
                }
                reconcileDom();
                return;
            }
            case "workspace/archived": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                if (id === null || data.archived_at === null || data.archived_at === undefined) return;
                let removed = false;
                for (const [key, session] of sessionsByKey.entries()) {
                    if (session.workspaceId === id) {
                        sessionsByKey.delete(key);
                        removed = true;
                    }
                }
                if (removed) reconcileDom();
                return;
            }
            case "session/created": {
                const id = typeof data.id === "number" ? data.id : notifSessionId;
                const wsId = typeof data.workspaceId === "number" ? data.workspaceId : notifWorkspaceId;
                if (id === null || wsId === null || typeof data.name !== "string") return;
                if (workspaceId !== undefined && wsId !== workspaceId) return;
                const prevWs = workspacesById.get(wsId);
                const wsName = typeof data.workspaceName === "string" ? data.workspaceName : prevWs?.name ?? String(wsId);
                const projRoot = typeof data.projectRoot === "string" ? data.projectRoot : data.projectRoot === null ? null : prevWs?.projectRoot ?? null;
                const projLabel = typeof data.projectLabel === "string" ? data.projectLabel : data.projectLabel === null ? null : prevWs?.projectLabel ?? projRoot;
                workspacesById.set(wsId, { name: wsName, projectRoot: projRoot, projectLabel: projLabel });
                if (data.origin !== "model") return;
                sessionsByKey.set(`${wsId}:${id}`, {
                    id,
                    workspaceId: wsId,
                    workspaceName: wsName,
                    projectRoot: projRoot,
                    name: data.name,
                    parentSessionId: typeof data.parentSessionId === "number" ? data.parentSessionId : null,
                    origin: "model",
                    lifecycle: typeof data.lifecycle === "string" ? data.lifecycle : "idle",
                    reply: null,
                });
                reconcileDom();
                return;
            }
            case "session/archived":
            case "session/deleted": {
                if (event === "session/archived" && (data.archived_at === null || data.archived_at === undefined)) return;
                const wsId = notifWorkspaceId;
                const ids = Array.isArray(data.sessionIds) ? data.sessionIds : (typeof data.id === "number" ? [data.id] : []);
                if (wsId === null || ids.length === 0) return;
                let removed = false;
                for (const sid of ids) {
                    if (typeof sid === "number" && sessionsByKey.delete(`${wsId}:${sid}`)) {
                        removed = true;
                    }
                }
                if (removed) reconcileDom();
                return;
            }
            case "loop/proposal":
            case "loop/interaction": {
                if (notifWorkspaceId === null || notifSessionId === null) return;
                if (event === "loop/proposal" && isRecord(data.disposition) && data.disposition.decision !== "review") return;
                const key = `${notifWorkspaceId}:${notifSessionId}`;
                const cur = sessionsByKey.get(key);
                if (!cur || cur.lifecycle === "running") return;
                sessionsByKey.set(key, { ...cur, lifecycle: "running" });
                reconcileDom();
                return;
            }
            case "log/entry": {
                const entry = isRecord(data.entry) ? data.entry : null;
                if (!entry) return;
                const wsId = notifWorkspaceId;
                const sid = typeof entry.session_id === "number" ? entry.session_id : notifSessionId;
                if (wsId === null || sid === null) return;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return;
                let nextReply = cur.reply;
                let nextLifecycle = cur.lifecycle;
                if (
                    entry.origin === "model"
                    && entry.state === "resolved"
                    && (typeof entry.status_rx !== "number" || entry.status_rx < 400)
                    && (entry.op === "send" || entry.op === "done" || entry.op === "fail")
                    && typeof entry.id === "number"
                ) {
                    const rxCompletion = isRecord(entry.rx) && (entry.rx.completion === 200 || entry.rx.completion === 499)
                        ? entry.rx.completion
                        : (Array.isArray(entry.replied_to_sources) && entry.replied_to_sources.length > 0 ? 200 : null);
                    if (rxCompletion !== null) {
                        const coordinate = typeof entry.coordinate === "string"
                            ? entry.coordinate
                            : `${entry.loop_seq}/${entry.turn_seq}/${entry.sequence}`;
                        nextReply = { id: entry.id, coordinate, completion: rxCompletion };
                    }
                }
                if (entry.state !== "proposed" && entry.op !== "done" && entry.op !== "fail" && entry.op !== "wait") {
                    nextLifecycle = "running";
                }
                if (nextReply !== cur.reply || nextLifecycle !== cur.lifecycle) {
                    sessionsByKey.set(key, { ...cur, reply: nextReply, lifecycle: nextLifecycle });
                    reconcileDom();
                }
                return;
            }
            case "loop/terminated": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
                if (wsId === null || sid === null) return;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return;
                const status = isRecord(data.result) && typeof data.result.status === "number" ? data.result.status : 200;
                const lifecycle = status === 200 ? "completed"
                    : status === 202 ? "parked"
                        : status === 499 ? "cancelled"
                            : status >= 400 ? "failed" : "completed";
                if (cur.lifecycle !== lifecycle) {
                    sessionsByKey.set(key, { ...cur, lifecycle });
                    reconcileDom();
                }
                return;
            }
            default:
                return;
        }
    }

    hydrateFromDom();

    /** @param {AbortSignal} signal */
    async function subscribe(signal) {
        the(main, "connection", "connecting");
        const headers = await accessHeaders(auth, signal);
        signal.throwIfAborted();
        const query = new URLSearchParams({ event: NOTIFICATION_EVENTS });
        if (workspaceId !== undefined) query.set("workspace", String(workspaceId));
        const response = await fetch(`/notifications?${query.toString()}`, {
            headers: { accept: "text/event-stream", ...headers },
            signal,
        });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
            const refusalError = await problemFromResponse(response.clone());
            throw Object.assign(
                new Error(refusalError?.message ?? (response.statusText || `HTTP ${response.status}`)),
                { status: refusalError?.status ?? response.status },
            );
        }
        the(main, "connection", "connected");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += value.replaceAll("\r\n", "\n");
                for (;;) {
                    const boundary = buffer.indexOf("\n\n");
                    if (boundary === -1) break;
                    const rawFrame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const dataLines = [];
                    for (const line of rawFrame.split("\n")) {
                        if (line.startsWith("data:")) {
                            dataLines.push(line.slice(5).replace(/^ /u, ""));
                        }
                    }
                    if (dataLines.length > 0 && !signal.aborted) {
                        applyNotification(JSON.parse(dataLines.join("\n")));
                    }
                }
            }
            if (!signal.aborted) {
                throw new Error("Notifications stream ended.");
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
    }

    const connect = () => {
        void subscribe(resources.signal).catch((error) => {
            if (resources.signal.aborted) return;
            const signedOut = Reflect.get(Object(error), "status") === 401;
            the(main, "connection", signedOut ? "signed-out" : "disconnected");
        });
    };

    window.onpagehide = () => {
        resources.abort();
        the(main, "connection", "closed");
    };
    window.onpageshow = (event) => {
        if (event.persisted) {
            resources = new AbortController();
            connect();
        }
    };
    connect();
}
