import { $, $$, on, the } from "on_the_money";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import accessHeaders from "./access-headers.js";
import card from "./card.js";
import markdown from "./markdown.js";
import problemFromResponse from "./problem-response.js";
import readBody from "./read-body.js";
import { PROTOCOL_VERSION, client, createHttpStream, methods } from "./session-agent.js";

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

    for (const details of $$(main, 'li[data-directory-entry="session"] > article > details')) {
        if (details instanceof HTMLDetailsElement) bindDisclosure(details);
    }

    /** @param {unknown} payload */
    function presentOverview(payload) {
        if (!isRecord(payload) || !Array.isArray(payload.sessions)) return;
        const meta = isRecord(payload._meta) && isRecord(payload._meta.plurnk) ? payload._meta.plurnk : null;
        /** @type {Map<number, { name: string, projectRoot: string | null, projectLabel: string | null }>} */
        const workspacesById = new Map();
        if (Array.isArray(meta?.workspaces)) {
            for (const ws of meta.workspaces) {
                if (isRecord(ws) && typeof ws.id === "number" && typeof ws.name === "string") {
                    workspacesById.set(ws.id, {
                        name: ws.name,
                        projectRoot: typeof ws.projectRoot === "string" ? ws.projectRoot : null,
                        projectLabel: typeof ws.projectLabel === "string" ? ws.projectLabel : null,
                    });
                }
            }
        }
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
        /** @type {OverviewSession[]} */
        const rawModels = [];
        for (const entry of payload.sessions) {
            if (!isRecord(entry) || entry.archived === true) continue;
            const p = isRecord(entry._meta) && isRecord(entry._meta.plurnk) ? entry._meta.plurnk : null;
            if (!p || p.archived === true || typeof p.id !== "number" || typeof p.workspaceId !== "number" || typeof p.name !== "string") continue;
            const ws = workspacesById.get(p.workspaceId);
            const workspaceName = typeof p.workspaceName === "string" ? p.workspaceName : ws?.name ?? String(p.workspaceId);
            const projectRoot = typeof p.projectRoot === "string" ? p.projectRoot : p.projectRoot === null ? null : ws?.projectRoot ?? null;
            const rawReply = isRecord(p.reply) ? p.reply : null;
            /** @type {OverviewReply | null} */
            const reply = rawReply && typeof rawReply.id === "number" && typeof rawReply.coordinate === "string"
                && (rawReply.completion === 200 || rawReply.completion === 499)
                ? { id: rawReply.id, coordinate: rawReply.coordinate, completion: rawReply.completion }
                : null;
            rawModels.push({
                id: p.id,
                workspaceId: p.workspaceId,
                workspaceName,
                projectRoot,
                name: p.name,
                parentSessionId: typeof p.parentSessionId === "number" ? p.parentSessionId : null,
                origin: "model",
                lifecycle: typeof p.lifecycle === "string" ? p.lifecycle : "idle",
                reply,
            });
        }
        const models = rawModels.toSorted(orderSessions);
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
                const path = directoryPath({ kind: "session", workspace: session.workspaceName, session: session.name });
                if (path !== null) {
                    const link = $(main, `li[data-directory-entry="session"] a[data-session-link][href="${CSS.escape(path)}"]`);
                    const existing = link?.closest('li[data-directory-entry="session"]');
                    if (existing instanceof HTMLLIElement && !claimedRows.has(existing)) {
                        row = existing;
                    }
                }
                row ??= /** @type {HTMLLIElement} */ ($.clone(list, "#session-card"));
                rowsByKey.set(key, row);
            }
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

    /** @param {AbortSignal} signal */
    async function subscribe(signal) {
        the(main, "connection", "connecting");
        const headers = await accessHeaders(auth, signal);
        signal.throwIfAborted();
        const connController = new AbortController();
        signal.onabort = () => connController.abort(signal.reason);
        /** @type {{ message: string, status?: number } | undefined} */
        let streamProblem;
        const sseReady = Promise.withResolvers();
        const streamEnded = Promise.withResolvers();

        /** @type {typeof globalThis.fetch} */
        const acpFetch = async (input, init) => {
            if (init?.method === "DELETE") return new Response(null, { status: 204 });
            const mergedHeaders = new Headers(init?.headers);
            for (const [key, value] of Object.entries(headers)) mergedHeaders.set(key, value);
            const fetchSignal = init?.signal
                ? AbortSignal.any([init.signal, connController.signal])
                : connController.signal;
            let response;
            try {
                response = await fetch(input, { ...init, headers: mergedHeaders, signal: fetchSignal });
            } catch (error) {
                if (init?.method === "GET") sseReady.resolve(undefined);
                if (!fetchSignal.aborted) streamEnded.reject(error);
                throw error;
            }
            if (!response.ok && streamProblem === undefined) {
                const refusalError = await problemFromResponse(response.clone());
                streamProblem = refusalError
                    ? { message: refusalError.message, status: refusalError.status }
                    : { message: response.statusText || `HTTP ${response.status}`, status: response.status };
            }
            if (init?.method !== "GET") return response;
            sseReady.resolve(undefined);
            if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
                if (!fetchSignal.aborted) {
                    streamEnded.reject(Object.assign(new Error(streamProblem?.message ?? "Overview stream closed."), { status: streamProblem?.status ?? response.status }));
                }
                return response;
            }
            const reader = response.body.getReader();
            const wrapped = new ReadableStream({
                async pull(controller) {
                    try {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            if (!fetchSignal.aborted) {
                                streamEnded.reject(Object.assign(new Error(streamProblem?.message ?? "Overview stream ended."), { status: streamProblem?.status }));
                            }
                            return;
                        }
                        controller.enqueue(value);
                    } catch (error) {
                        if (!fetchSignal.aborted) streamEnded.reject(error);
                        controller.error(error);
                    }
                },
                cancel: (reason) => reader.cancel(reason),
            });
            return new Response(wrapped, { status: response.status, statusText: response.statusText, headers: response.headers });
        };

        const resolvedUrl = new URL("/acp", location.origin).href;
        const stream = createHttpStream(resolvedUrl, { fetch: acpFetch, headers, cookies: "omit" });
        const app = client({ name: "@plurnk/plurnk-web" });
        app.onNotification("_plurnk/overview", (raw) => raw, ({ params }) => {
            if (!connController.signal.aborted) presentOverview(params);
        });
        const conn = app.connect(stream);
        try {
            await conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-web", version: "1.0.0" },
                capabilities: {},
            });
            await sseReady.promise;
            const initial = await conn.agent.request(methods.agent.session.list, {
                _meta: {
                    plurnk: {
                        subscribe: true,
                        ...(workspaceId !== undefined ? { workspaceId } : {}),
                    },
                },
            });
            if (connController.signal.aborted) return;
            presentOverview(initial);
            the(main, "connection", "connected");
            await streamEnded.promise;
        } catch (error) {
            if (streamProblem !== undefined && !signal.aborted) {
                throw Object.assign(new Error(streamProblem.message), { status: streamProblem.status });
            }
            throw error;
        } finally {
            connController.abort();
            conn.close();
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
