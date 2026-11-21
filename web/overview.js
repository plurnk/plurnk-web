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
 *   readonly archived: boolean,
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
    session.lifecycle === "running" || session.lifecycle === "queued" || session.lifecycle === "parked";

/** {§web-search} {§web-session-directory} Live Search & Directory page (`/search/`), instant filtering, and on-demand reply disclosure.
 * @param {HTMLElement} main
 */
export default function observeOverview(main) {
    const { auth: rawAuth } = main.dataset;
    if (rawAuth !== "session" && rawAuth !== "none") throw new Error("Search document metadata is incomplete.");
    const auth = rawAuth;
    const sessionsOutlet = $(main, "#search-sessions") ?? main;
    const workspacesOutlet = $(main, "#search-workspaces");
    const controlsForm = $(main, "#search-controls");
    const searchInput = controlsForm ? $(controlsForm, "input[data-overview-search]") : null;
    const wsSelect = controlsForm ? $(controlsForm, "select[data-search-workspace]") : null;
    const statusSelect = controlsForm ? $(controlsForm, "select[data-overview-scope]") : null;
    const kindSelect = controlsForm ? $(controlsForm, "select[data-search-kind]") : null;

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

    let filterQuery = searchInput instanceof HTMLInputElement ? searchInput.value : "";
    let filterWorkspace = wsSelect instanceof HTMLSelectElement ? wsSelect.value : "";
    let filterStatus = statusSelect instanceof HTMLSelectElement ? statusSelect.value : "all";
    let filterKind = kindSelect instanceof HTMLSelectElement ? kindSelect.value : "all";
    const initialArchivedMode = filterStatus === "archived";

    if (main.dataset.needsOnboarding === "true" && !$(main, "#session-onboarding-banner")) {
        const anchor = controlsForm ?? main.firstElementChild;
        if (anchor) $.clone(anchor, "#session-onboarding-banner", { position: "beforebegin" });
        else $.clone(main, "#session-onboarding-banner");
    }

    /** @type {Promise<{ open: () => Promise<void> }> | null} */
    let onboardingPromise = null;
    on(main, "click", "[data-open-onboarding]", () => {
        onboardingPromise ??= import("./onboarding.js").then(({ createOnboardingController }) =>
            createOnboardingController(() => ({
                auth,
                signal: resources.signal,
                onConfigured: () => {
                    delete main.dataset.needsOnboarding;
                    $(main, "#session-onboarding-banner")?.remove();
                },
            })),
        );
        void onboardingPromise.then((ctrl) => ctrl.open());
    });
    on(main, "click", "[data-dismiss-onboarding]", (_event, button) => {
        delete main.dataset.needsOnboarding;
        button.closest("#session-onboarding-banner")?.remove();
    });

    function syncUrlQuery() {
        if (!location.pathname.startsWith("/search")) return;
        const params = new URLSearchParams();
        if (filterQuery.trim()) params.set("q", filterQuery.trim());
        if (filterWorkspace) params.set("workspace", filterWorkspace);
        if (filterStatus && filterStatus !== "all") params.set("status", filterStatus);
        if (filterKind && filterKind !== "all") params.set("kind", filterKind);
        const query = params.toString();
        const nextUrl = `${location.pathname}${query ? `?${query}` : ""}`;
        if (`${location.pathname}${location.search}` !== nextUrl) {
            history.replaceState(null, "", nextUrl);
        }
    }

    /** @param {HTMLElement} outlet */
    async function loadReply(outlet) {
        const address = outlet.getAttribute("data-session-reply");
        if (!address || outlet.dataset.replyLoaded === address || inFlight.get(outlet) === address) return;
        const token = Symbol("reply-read");
        activeTokens.set(outlet, token);
        inFlight.set(outlet, address);
        the(outlet, "body-state", "loading");
        outlet.setAttribute("aria-busy", "true");
        outlet.removeAttribute("role");
        outlet.replaceChildren();
        try {
            const source = await readBody(address, auth, resources.signal);
            if (!outlet.isConnected || activeTokens.get(outlet) !== token || outlet.getAttribute("data-session-reply") !== address) return;
            outlet.replaceChildren(markdown(source, `reply-${++replyCounter}`));
            outlet.dataset.replyLoaded = address;
            the(outlet, "body-state", "loaded");
        } catch (error) {
            if (!outlet.isConnected || activeTokens.get(outlet) !== token || outlet.getAttribute("data-session-reply") !== address) return;
            if (error instanceof DOMException && error.name === "AbortError") return;
            const message = $.clone(outlet, "#conversation-literal");
            message.textContent = error instanceof Error ? error.message : String(error);
            message.setAttribute("role", "alert");
            the(outlet, "body-state", "error");
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

        if (workspacesOutlet instanceof HTMLElement) {
            const wsList = $(workspacesOutlet, ":scope > ul");
            let visibleWsCount = 0;
            if (wsList instanceof HTMLUListElement) {
                for (const item of wsList.children) {
                    if (!(item instanceof HTMLLIElement)) continue;
                    const wsName = item.dataset.workspaceName ?? "";
                    const text = (item.textContent ?? "").toLowerCase();
                    const matchWs = (!filterWorkspace || wsName === filterWorkspace)
                        && (!query || text.includes(query));
                    item.hidden = !matchWs;
                    if (matchWs) visibleWsCount++;
                }
                wsList.hidden = visibleWsCount === 0;
            }
            const emptyWs = $(workspacesOutlet, ':scope > p[data-i18n="no-workspaces"]');
            if (visibleWsCount === 0 && wsList) {
                if (!emptyWs) $.clone(workspacesOutlet, "#workspaces-empty");
            } else if (visibleWsCount > 0) {
                emptyWs?.remove();
            }
        }

        /** @param {OverviewSession} session */
        const matchesSelf = (session) => {
            if (filterWorkspace && session.workspaceName !== filterWorkspace) return false;
            if (filterStatus === "active" && !isActiveSession(session)) return false;
            if (filterStatus === "gated" && session.gates <= 0) return false;
            if (filterStatus === "failed" && session.lifecycle !== "failed") return false;
            if (filterKind === "chats" && session.kind === "work") return false;
            if (filterKind === "work" && session.kind !== "work") return false;
            if (query === "") return true;
            const haystack = `${session.name} #${session.name} ${session.workspaceName} ${session.title ?? ""} ${session.reply?.excerpt ?? ""}`.toLowerCase();
            return haystack.includes(query);
        };

        /** @param {HTMLLIElement} row @returns {boolean} */
        const filterRow = (row) => {
            const key = row.dataset.sessionKey ?? "";
            const session = sessionsByKey.get(key);
            let childMatch = false;
            const childList = $(row, ":scope > article > details > ul");
            if (childList instanceof HTMLUListElement) {
                if (filterKind === "chats") {
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
            const visible = (session ? matchesSelf(session) : true) || (filterKind !== "chats" && childMatch);
            row.hidden = !visible;
            return visible;
        };

        let visibleSessions = 0;
        const rootList = $(sessionsOutlet, ":scope > ul");
        if (rootList instanceof HTMLUListElement) {
            for (const item of rootList.children) {
                if (item instanceof HTMLLIElement && filterRow(item)) {
                    visibleSessions++;
                }
            }
            rootList.hidden = visibleSessions === 0;
        }
        const backgroundDetails = $(sessionsOutlet, ":scope > details");
        let anyBgVisible = false;
        if (backgroundDetails instanceof HTMLDetailsElement) {
            if (filterKind === "chats") {
                backgroundDetails.hidden = true;
            } else {
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
        const emptySess = $(sessionsOutlet, ':scope > p[data-i18n="no-sessions"]');
        if (visibleSessions === 0 && !anyBgVisible) {
            if (!emptySess) {
                const omitted = $(sessionsOutlet, ":scope > p[data-overview-omitted]");
                if (omitted) $.clone(omitted, "#overview-empty", { position: "beforebegin" });
                else $.clone(sessionsOutlet, "#overview-empty");
            }
        } else if (sessionsByKey.size > 0) {
            emptySess?.remove();
        }
    }

    if (controlsForm instanceof HTMLFormElement) {
        on(controlsForm, "submit", "form", (event) => {
            const nextStatus = statusSelect instanceof HTMLSelectElement ? statusSelect.value : "all";
            const switchingArchived = (nextStatus === "archived") !== initialArchivedMode;
            const hasOmitted = $(sessionsOutlet, "[data-overview-omitted]") !== null;
            const nextWs = wsSelect instanceof HTMLSelectElement ? wsSelect.value : "";
            if (switchingArchived || (hasOmitted && nextWs !== "")) {
                return;
            }
            event.preventDefault();
            filterQuery = searchInput instanceof HTMLInputElement ? searchInput.value : "";
            filterWorkspace = nextWs;
            filterStatus = nextStatus;
            filterKind = kindSelect instanceof HTMLSelectElement ? kindSelect.value : "all";
            syncUrlQuery();
            applyFilter();
        });
        on(controlsForm, "input", "input[data-overview-search]", (_event, input) => {
            if (input instanceof HTMLInputElement) {
                filterQuery = input.value;
                syncUrlQuery();
                applyFilter();
            }
        });
        on(controlsForm, "change", "select", (_event, select) => {
            if (!(select instanceof HTMLSelectElement)) return;
            const nextStatus = statusSelect instanceof HTMLSelectElement ? statusSelect.value : "all";
            const nextWs = wsSelect instanceof HTMLSelectElement ? wsSelect.value : "";
            if ((nextStatus === "archived") !== initialArchivedMode
                || (select === wsSelect && nextWs !== "" && $(sessionsOutlet, "[data-overview-omitted]") !== null)) {
                controlsForm.requestSubmit();
                return;
            }
            filterWorkspace = nextWs;
            filterStatus = nextStatus;
            filterKind = kindSelect instanceof HTMLSelectElement ? kindSelect.value : "all";
            syncUrlQuery();
            applyFilter();
        });
    }

    /**
     * @param {ParentNode} [sourceRoot]
     * @param {boolean} [bindLiveRows]
     */
    function hydrateFromDom(sourceRoot = main, bindLiveRows = true) {
        for (const row of $$(sourceRoot, 'li[data-directory-entry="session"]')) {
            if (!(row instanceof HTMLLIElement)) continue;
            const details = $(row, ":scope > article > details");
            if (bindLiveRows && details instanceof HTMLDetailsElement) bindDisclosure(details);
            const rawKey = row.dataset.sessionKey ?? "";
            const keyMatch = /^(\d+):(\d+)$/u.exec(rawKey);
            if (!keyMatch) continue;
            const wsId = Number(keyMatch[1]);
            const id = Number(keyMatch[2]);
            const key = `${wsId}:${id}`;
            if (bindLiveRows) rowsByKey.set(key, row);

            const parentRow = row.parentElement?.closest('li[data-directory-entry="session"]');
            const parentKeyMatch = parentRow instanceof HTMLLIElement && parentRow.dataset.sessionKey
                ? /^(\d+):(\d+)$/u.exec(parentRow.dataset.sessionKey)
                : null;
            const enclosingDetails = row.closest("details");
            const isBackground = parentKeyMatch === null && enclosingDetails instanceof HTMLDetailsElement
                && $(enclosingDetails, ':scope > summary[data-i18n="background-work"]') !== null;
            const parentSessionId = parentKeyMatch ? Number(parentKeyMatch[2]) : isBackground ? 0 : null;
            const kind = asSessionKind(row.dataset.sessionKind) ?? (parentSessionId === null ? "root" : "work");
            const archived = row.dataset.archived === "true";

            const article = $(row, ":scope > article");
            const headerOrSummary = article ? $(article, ":scope > header, :scope > details > summary") : null;
            const identity = headerOrSummary ? $(headerOrSummary, "[data-session-identity]") : null;
            const workspaceSpan = headerOrSummary ? $(headerOrSummary, "[data-session-workspace]") : null;
            const rawName = (identity ? $(identity, ":scope > span:last-of-type")?.textContent : null) ?? String(id);
            const name = rawName.startsWith("#") ? rawName.slice(1) : rawName;
            const lifecycle = (identity ? $(identity, "[data-lifecycle]")?.getAttribute("data-lifecycle") : null) ?? "idle";
            const titleText = identity ? $(identity, "[data-session-title]")?.textContent ?? undefined : undefined;
            const rawGates = identity ? $(identity, "[data-session-gates]")?.getAttribute("data-session-gates") : null;
            const gates = rawGates && /^\d+$/u.test(rawGates) ? Number(rawGates) : 0;
            const workspaceName = row.dataset.workspaceName
                ?? (workspaceSpan ? $(workspaceSpan, '[data-text="name"]')?.textContent : null)
                ?? workspacesById.get(wsId)?.name
                ?? String(wsId);
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
                archived,
                ...(titleText ? { title: titleText } : {}),
                reply,
            });
        }
    }

    function reconcileDom() {
        if (initialArchivedMode) {
            applyFilter();
            return;
        }
        const models = [...sessionsByKey.values()].filter(({ archived }) => !archived).toSorted(orderSessions);
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
                    archived: false,
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
                const byKey = $(sessionsOutlet, `li[data-directory-entry="session"][data-session-key="${CSS.escape(key)}"]`);
                if (byKey instanceof HTMLLIElement && !claimedRows.has(byKey)) {
                    row = byKey;
                } else {
                    const path = directoryPath({ kind: "session", workspace: session.workspaceName, session: session.name });
                    if (path !== null) {
                        const link = $(sessionsOutlet, `li[data-directory-entry="session"] a[data-session-link][href="${CSS.escape(path)}"]`);
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
            row.dataset.workspaceName = session.workspaceName;
            row.dataset.lifecycleState = session.lifecycle;
            row.dataset.gateCount = String(session.gates);
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
                    const title = `Open #${session.name}`;
                    if (link.getAttribute("title") !== title) link.setAttribute("title", title);
                }
                const lifecycleEl = $(identity, "[data-lifecycle]");
                if (lifecycleEl && lifecycleEl.getAttribute("data-lifecycle") !== session.lifecycle) {
                    lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
                    lifecycleEl.setAttribute("aria-label", session.lifecycle);
                    lifecycleEl.setAttribute("title", session.lifecycle);
                }
                const nameSpan = $(identity, ":scope > span:last-of-type");
                const displayHashName = `#${session.name}`;
                if (nameSpan && nameSpan.textContent !== displayHashName) {
                    nameSpan.textContent = displayHashName;
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

        const omittedEl = $(sessionsOutlet, ":scope > p[data-overview-omitted]");
        const emptyEl = $(sessionsOutlet, ':scope > p[data-i18n="no-sessions"]');
        let rootList = $(sessionsOutlet, ":scope > ul");
        let backgroundDetails = $(sessionsOutlet, ":scope > details");
        if (models.length === 0) {
            rootList?.remove();
            backgroundDetails?.remove();
            omittedEl?.remove();
            if (!emptyEl) $.clone(sessionsOutlet, "#overview-empty");
            return;
        }
        emptyEl?.remove();
        const roots = children.get(null) ?? [];
        if (roots.length > 0) {
            if (!rootList) {
                const anchor = backgroundDetails ?? omittedEl;
                rootList = anchor
                    ? $.clone(anchor, "#overview-list", { position: "beforebegin" })
                    : $.clone(sessionsOutlet, "#overview-list");
            }
            reconcileList(rootList, roots);
        } else {
            rootList?.remove();
        }
        if (background.length > 0) {
            if (!backgroundDetails) {
                backgroundDetails = omittedEl
                    ? $.clone(omittedEl, "#overview-background", { position: "beforebegin" })
                    : $.clone(sessionsOutlet, "#overview-background");
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
        if (initialArchivedMode) return;
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
                const oldName = prev?.name;
                workspacesById.set(id, {
                    name,
                    projectRoot: prev?.projectRoot ?? null,
                    projectLabel: prev?.projectLabel ?? null,
                });
                if (oldName && workspacesOutlet) {
                    const wsRow = $(workspacesOutlet, `li[data-directory-entry="workspace"][data-workspace-name="${CSS.escape(oldName)}"]`);
                    if (wsRow instanceof HTMLLIElement) {
                        wsRow.dataset.workspaceName = name;
                        const wsLink = $(wsRow, 'a[data-text="name"]');
                        const wsPath = directoryPath({ kind: "workspace", workspace: name });
                        if (wsLink && wsPath) {
                            wsLink.textContent = name;
                            wsLink.setAttribute("href", wsPath);
                        }
                    }
                }
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
                const prev = workspacesById.get(id);
                if (prev && workspacesOutlet) {
                    $(workspacesOutlet, `li[data-directory-entry="workspace"][data-workspace-name="${CSS.escape(prev.name)}"]`)?.remove();
                }
                let removed = false;
                for (const [key, session] of sessionsByKey.entries()) {
                    if (session.workspaceId === id) {
                        sessionsByKey.delete(key);
                        removed = true;
                    }
                }
                if (removed) reconcileDom();
                else applyFilter();
                return;
            }
            case "session/created": {
                const id = typeof data.id === "number" ? data.id : notifSessionId;
                const wsId = typeof data.workspaceId === "number" ? data.workspaceId : notifWorkspaceId;
                if (id === null || wsId === null || typeof data.name !== "string") return;
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
                    archived: false,
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
            case "session/titled": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.id === "number" ? data.id : notifSessionId;
                if (wsId === null || sid === null) return;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return;
                const nextTitle = typeof data.title === "string" && data.title.trim().length > 0 ? data.title : undefined;
                if (cur.title === nextTitle) return;
                const next = { ...cur };
                if (nextTitle !== undefined) next.title = nextTitle;
                else delete next.title;
                sessionsByKey.set(key, next);
                reconcileDom();
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
            case "loop/gate-settled": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
                if (wsId === null || sid === null) return;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur || cur.gates <= 0) return;
                sessionsByKey.set(key, { ...cur, gates: Math.max(0, cur.gates - 1) });
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
                }
                if (nextReply !== cur.reply || nextLifecycle !== cur.lifecycle) {
                    sessionsByKey.set(key, { ...cur, reply: nextReply, lifecycle: nextLifecycle });
                    reconcileDom();
                }
                return;
            }
            case "loop/started":
            case "loop/parked": {
                const wsId = notifWorkspaceId;
                const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
                if (wsId === null || sid === null) return;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return;
                const lifecycle = event === "loop/parked" ? "parked" : "running";
                if (cur.lifecycle !== lifecycle) {
                    sessionsByKey.set(key, { ...cur, lifecycle });
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
            case "notifications/resync": {
                void (async () => {
                    try {
                        const targetPath = `${location.pathname}${location.search}`;
                        const res = await fetch(targetPath, {
                            headers: { accept: "text/html" },
                            cache: "no-store",
                        });
                        if (!res.ok || disposed) return;
                        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
                        const parsedMain = $(doc, "main#main");
                        if (!parsedMain) return;
                        sessionsByKey.clear();
                        hydrateFromDom(parsedMain, false);
                        reconcileDom();
                    } catch {
                        // Ignore transient resync fetch errors; passive reconnect will retry.
                    }
                })();
                return;
            }
            default:
                return;
        }
    }

    hydrateFromDom();
    applyFilter();

    let disposed = false;

    const notifications = subscribeWorkspaceNotifications({
        auth,
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
