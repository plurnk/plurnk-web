import { $, $$, on, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import card from "./card.js";
import markdown from "./markdown.js";
import readBody from "./read-body.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly coordinate: string,
 *   readonly completion: 200 | 499,
 *   readonly at?: number,
 *   readonly excerpt?: string,
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
 *   readonly kind: "root" | "work" | "fork",
 *   readonly lifecycle: string,
 *   readonly gates: number,
 *   readonly title?: string,
 *   readonly reply: OverviewReply | null,
 * }} OverviewSession
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** @param {number} timestampMs */
function formatRelativeAge(timestampMs) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - timestampMs) / MS_PER_SECOND));
    if (elapsedSec < SECONDS_PER_MINUTE) return "just now";
    const elapsedMin = Math.floor(elapsedSec / SECONDS_PER_MINUTE);
    if (elapsedMin < MINUTES_PER_HOUR) return `${elapsedMin}m ago`;
    const elapsedHours = Math.floor(elapsedMin / MINUTES_PER_HOUR);
    if (elapsedHours < HOURS_PER_DAY) return `${elapsedHours}h ago`;
    const elapsedDays = Math.floor(elapsedHours / HOURS_PER_DAY);
    return `${elapsedDays}d ago`;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {"root" | "work" | "fork" | null} */
const asSessionKind = (value) => value === "root" || value === "work" || value === "fork" ? value : null;

/** @param {string} raw */
const singleLineExcerpt = (raw) => raw.replaceAll(/\s+/gu, " ").trim();

/** @param {OverviewSession} a @param {OverviewSession} b */
const orderSessions = (a, b) => a.reply !== null && b.reply !== null ? b.reply.id - a.reply.id
    : a.reply !== null ? -1 : b.reply !== null ? 1 : 0;

/** @param {OverviewSession} session */
const isActiveSession = (session) =>
    session.lifecycle === "running" || session.lifecycle === "queued" || session.lifecycle === "parked" || session.gates > 0;

/** {§web-session-directory} Live session dashboard, filtering, and on-demand reply disclosure on `/` and `/~/<workspace>/`.
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
    let filterQuery = "";
    /** @type {"all" | "active" | "roots"} */
    let filterScope = "all";

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

    function applyFilter() {
        const query = filterQuery.trim().toLowerCase();
        /** @param {OverviewSession} session */
        const matchesSelf = (session) => {
            if (filterScope === "active" && !isActiveSession(session)) return false;
            if (filterScope === "roots" && (session.kind !== "root" || session.parentSessionId !== null)) return false;
            if (query === "") return true;
            const haystack = `${session.name} ${session.workspaceName} ${session.title ?? ""} ${session.reply?.excerpt ?? ""}`.toLowerCase();
            return haystack.includes(query);
        };

        /** @param {HTMLLIElement} row @returns {boolean} */
        const filterRow = (row) => {
            const key = row.dataset.sessionKey ?? "";
            const session = sessionsByKey.get(key);
            let childMatch = false;
            const childList = $(row, ":scope > article > details > ul");
            if (childList instanceof HTMLUListElement) {
                if (filterScope === "roots") {
                    childList.hidden = true;
                } else {
                    childList.hidden = false;
                    for (const child of childList.children) {
                        if (child instanceof HTMLLIElement && filterRow(child)) {
                            childMatch = true;
                        }
                    }
                }
            }
            const visible = (session ? matchesSelf(session) : true) || (filterScope !== "roots" && childMatch);
            row.hidden = !visible;
            return visible;
        };

        const rootList = $(main, ":scope > ul");
        if (rootList instanceof HTMLUListElement) {
            for (const item of rootList.children) {
                if (item instanceof HTMLLIElement) filterRow(item);
            }
        }
        const backgroundDetails = $(main, ":scope > details");
        if (backgroundDetails instanceof HTMLDetailsElement) {
            if (filterScope === "roots") {
                backgroundDetails.hidden = true;
            } else {
                let anyBgVisible = false;
                const bgList = $(backgroundDetails, ":scope > ul");
                if (bgList instanceof HTMLUListElement) {
                    for (const item of bgList.children) {
                        if (item instanceof HTMLLIElement && filterRow(item)) {
                            anyBgVisible = true;
                        }
                    }
                }
                backgroundDetails.hidden = !anyBgVisible;
            }
        }
    }

    function ensureControls() {
        let controls = $(main, ":scope > #overview-controls");
        if (sessionsByKey.size === 0) {
            controls?.remove();
            return;
        }
        if (controls instanceof HTMLElement) return;
        const anchor = $(main, ":scope > ul, :scope > details, :scope > p[data-overview-omitted], :scope > dialog");
        controls = anchor
            ? $.clone(anchor, "#overview-controls", { position: "beforebegin" })
            : $.clone(main, "#overview-controls");
        on(controls, "input", "input[data-overview-search], select[data-overview-scope]", (_event, control) => {
            if (control instanceof HTMLInputElement) {
                filterQuery = control.value;
                applyFilter();
            } else if (control instanceof HTMLSelectElement) {
                const nextScope = control.value;
                if (nextScope === "all" || nextScope === "active" || nextScope === "roots") {
                    filterScope = nextScope;
                    applyFilter();
                }
            }
        });
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
            const kind = asSessionKind(row.dataset.sessionKind) ?? (parentSessionId === null ? "root" : "work");

            const article = $(row, ":scope > article");
            const headerOrSummary = article ? $(article, ":scope > header, :scope > details > summary") : null;
            const identity = headerOrSummary ? $(headerOrSummary, "[data-session-identity]") : null;
            const workspaceSpan = headerOrSummary ? $(headerOrSummary, "[data-session-workspace]") : null;
            const name = (identity ? $(identity, ":scope > span:last-of-type")?.textContent : null) ?? String(id);
            const lifecycle = (identity ? $(identity, "[data-lifecycle]")?.getAttribute("data-lifecycle") : null) ?? "idle";
            const titleText = identity ? $(identity, "[data-session-title]")?.textContent ?? undefined : undefined;
            const rawGates = identity ? $(identity, "[data-session-gates]")?.getAttribute("data-session-gates") : null;
            const gates = rawGates && /^\d+$/u.test(rawGates) ? Number(rawGates) : 0;
            const workspaceName = (workspaceSpan ? $(workspaceSpan, '[data-text="name"]')?.textContent : null)
                ?? workspacesById.get(wsId)?.name ?? String(wsId);
            const hasFolder = workspaceSpan ? $(workspaceSpan, "[data-folder]")?.getAttribute("data-folder") === "true" : false;
            const projectRoot = hasFolder ? (workspacesById.get(wsId)?.projectRoot ?? "/") : null;
            if (!workspacesById.has(wsId)) {
                workspacesById.set(wsId, { name: workspaceName, projectRoot, projectLabel: projectRoot });
            }

            const timeEl = workspaceSpan ? $(workspaceSpan, "time[data-session-time]") : null;
            const rawDatetime = timeEl?.getAttribute("datetime") ?? null;
            const parsedTime = rawDatetime ? Date.parse(rawDatetime) : NaN;
            if (timeEl && Number.isFinite(parsedTime)) {
                timeEl.textContent = formatRelativeAge(parsedTime);
            }
            const excerptEl = headerOrSummary ? $(headerOrSummary, "[data-session-excerpt]") : null;
            const excerptText = excerptEl?.textContent ?? undefined;

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
                    reply = {
                        id: replyId,
                        coordinate,
                        completion: 200,
                        ...(Number.isFinite(parsedTime) ? { at: parsedTime } : {}),
                        ...(excerptText ? { excerpt: excerptText } : {}),
                    };
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
                kind,
                lifecycle,
                gates,
                ...(titleText ? { title: titleText } : {}),
                reply,
            });
        }
        ensureControls();
    }

    function syncWorkspaceHeader() {
        if (workspaceId === undefined) return;
        const currentWs = workspacesById.get(workspaceId);
        if (!currentWs) return;
        for (const input of $$(main, 'dialog form input[name="workspace"]')) {
            if (input instanceof HTMLInputElement) input.value = currentWs.name;
        }
        if (!main.isConnected) return;
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
    }

    function reconcileDom() {
        syncWorkspaceHeader();
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
                    kind: "root",
                    lifecycle: "idle",
                    gates: 0,
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
            row.dataset.sessionKind = session.kind;
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
                const nameSpan = $(identity, ":scope > span:last-of-type");
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
                let titleBadge = $(identity, "[data-session-title]");
                if (session.title) {
                    titleBadge ??= $.clone(identity, "#session-title-badge");
                    if (titleBadge.textContent !== session.title) titleBadge.textContent = session.title;
                } else {
                    titleBadge?.remove();
                }
                let gatesBadge = $(identity, "[data-session-gates]");
                if (session.gates > 0) {
                    gatesBadge ??= $.clone(identity, "#session-gates-badge");
                    const label = `${session.gates} awaiting input`;
                    gatesBadge.setAttribute("data-session-gates", String(session.gates));
                    gatesBadge.setAttribute("aria-label", label);
                    gatesBadge.setAttribute("title", label);
                    if (gatesBadge.textContent !== String(session.gates)) gatesBadge.textContent = String(session.gates);
                } else {
                    gatesBadge?.remove();
                }
                let childrenBadge = $(identity, "[data-session-children]");
                if (descendants.length > 0) {
                    childrenBadge ??= $.clone(identity, "#session-children-badge");
                    const countText = String(descendants.length);
                    const label = `${descendants.length} ${descendants.length === 1 ? "child" : "children"}`;
                    childrenBadge.setAttribute("data-session-children", countText);
                    childrenBadge.setAttribute("aria-label", label);
                    childrenBadge.setAttribute("title", label);
                    if (childrenBadge.textContent !== countText) childrenBadge.textContent = countText;
                } else {
                    childrenBadge?.remove();
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
                let timeBadge = $(workspaceSpan, "time[data-session-time]");
                if (typeof session.reply?.at === "number" && Number.isFinite(session.reply.at)) {
                    timeBadge ??= $.clone(workspaceSpan, "#session-time-badge");
                    const iso = new Date(session.reply.at).toISOString();
                    if (timeBadge.getAttribute("datetime") !== iso) timeBadge.setAttribute("datetime", iso);
                    if (timeBadge.getAttribute("title") !== iso) timeBadge.setAttribute("title", iso);
                    const relative = formatRelativeAge(session.reply.at);
                    if (timeBadge.textContent !== relative) timeBadge.textContent = relative;
                } else {
                    timeBadge?.remove();
                }
            }
            let excerptEl = $(header, "[data-session-excerpt]");
            if (session.reply?.excerpt) {
                excerptEl ??= $.clone(header, "#session-excerpt-line");
                if (excerptEl.textContent !== session.reply.excerpt) excerptEl.textContent = session.reply.excerpt;
            } else {
                excerptEl?.remove();
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
        const omittedEl = $(main, ":scope > p[data-overview-omitted]");
        const emptyEl = $(main, ':scope > p[data-i18n="no-sessions"]');
        let rootList = $(main, ":scope > ul");
        let backgroundDetails = $(main, ":scope > details");
        ensureControls();
        if (models.length === 0) {
            rootList?.remove();
            backgroundDetails?.remove();
            omittedEl?.remove();
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
                const anchor = backgroundDetails ?? omittedEl ?? firstDialog;
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
                const anchor = omittedEl ?? firstDialog;
                backgroundDetails = anchor
                    ? $.clone(anchor, "#overview-background", { position: "beforebegin" })
                    : $.clone(main, "#overview-background");
            }
            const bgList = $(backgroundDetails, ":scope > ul");
            if (bgList) reconcileList(bgList, background);
        } else {
            backgroundDetails?.remove();
        }
        applyFilter();
    }

    /** @param {unknown} raw */
    function applyNotification(raw) {
        if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) return;
        const { event, data } = raw;
        const notifWorkspaceId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
        const notifSessionId = typeof raw.sessionId === "number" ? raw.sessionId : null;
        const notifTimestamp = typeof raw.timestamp === "number" ? raw.timestamp : Date.now();

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
                const parentSessionId = typeof data.parentSessionId === "number" ? data.parentSessionId : null;
                const kind = asSessionKind(data.kind) ?? (parentSessionId === null ? "root" : "work");
                sessionsByKey.set(`${wsId}:${id}`, {
                    id,
                    workspaceId: wsId,
                    workspaceName: wsName,
                    projectRoot: projRoot,
                    name: data.name,
                    parentSessionId,
                    origin: "model",
                    kind,
                    lifecycle: typeof data.lifecycle === "string" ? data.lifecycle : "idle",
                    gates: 0,
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
                if (!cur) return;
                sessionsByKey.set(key, { ...cur, lifecycle: "running", gates: cur.gates + 1 });
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
                let nextGates = cur.gates;
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
                        const tx = isRecord(entry.tx) ? entry.tx : null;
                        const rawWords = typeof tx?.body === "string" ? tx.body
                            : isRecord(tx?.body) && typeof tx.body.raw === "string" ? tx.body.raw : undefined;
                        const excerpt = rawWords ? singleLineExcerpt(rawWords) : cur.reply?.excerpt;
                        nextReply = {
                            id: entry.id,
                            coordinate,
                            completion: rxCompletion,
                            at: notifTimestamp,
                            ...(excerpt ? { excerpt } : {}),
                        };
                    }
                }
                if (entry.state !== "proposed" && entry.op !== "done" && entry.op !== "fail" && entry.op !== "wait") {
                    nextLifecycle = "running";
                    if (entry.state === "resolved" && nextGates > 0) nextGates = 0;
                }
                if (nextReply !== cur.reply || nextLifecycle !== cur.lifecycle || nextGates !== cur.gates) {
                    sessionsByKey.set(key, { ...cur, reply: nextReply, lifecycle: nextLifecycle, gates: nextGates });
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
                if (cur.lifecycle !== lifecycle || cur.gates !== 0) {
                    sessionsByKey.set(key, { ...cur, lifecycle, gates: 0 });
                    reconcileDom();
                }
                return;
            }
            default:
                return;
        }
    }

    hydrateFromDom();

    let savedScrollTop = main.scrollTop;
    let disposed = false;

    const notifications = subscribeWorkspaceNotifications({
        auth,
        workspaceId,
        onStateChange: (state) => {
            if (!disposed) the(main, "connection", state);
        },
        onNotification: (payload) => {
            if (!disposed) applyNotification(payload);
        },
    });

    const offPageHide = on.target(window, "pagehide", () => {
        if (disposed) return;
        resources.abort();
    });
    const offPageShow = on.target(window, "pageshow", (event) => {
        if (disposed) return;
        if (event instanceof PageTransitionEvent && event.persisted) {
            resources = new AbortController();
        }
    });

    return {
        main,
        footer: null,
        deactivate() {
            if (disposed) return;
            savedScrollTop = main.scrollTop;
        },
        activate() {
            if (disposed) return;
            syncWorkspaceHeader();
            main.scrollTop = savedScrollTop;
        },
        canEvict() {
            return false;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            offPageHide();
            offPageShow();
            notifications.unsubscribe();
            resources.abort();
        },
    };
}
