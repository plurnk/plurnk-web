import { $, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import card from "./card.js";
import { populateDatalist } from "./combobox.js";
import {
    isActiveSession,
    isUntouchedDraftOverviewSession,
    orderSessions,
    resolveDisplayedExcerpt,
} from "./overview-state.js";

/** @typedef {import("./overview-state.js").OverviewWorkspace} OverviewWorkspace */
/** @typedef {import("./overview-state.js").OverviewSession} OverviewSession */
/** @typedef {ReturnType<typeof import("./overview-state.js").createOverviewStore>} OverviewStore */

/**
 * @typedef {{
 *   readonly filterQuery: string,
 *   readonly filterWorkspace: string,
 *   readonly filterStatus: string,
 *   readonly filterKind: string,
 * }} OverviewFilters
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

/**
 * Move or insert `node` before `ref` inside `parent` while preserving focus and details state.
 * @param {Element} parent
 * @param {HTMLElement} node
 * @param {Node | null} ref
 */
function placeBefore(parent, node, ref) {
    if (node.isConnected && node.parentElement === parent && typeof /** @type {{ moveBefore?: unknown }} */ (parent).moveBefore === "function") {
        /** @type {{ moveBefore(child: Node, before: Node | null): void }} */ (/** @type {unknown} */ (parent)).moveBefore(node, ref);
        return;
    }
    const active = document.activeElement;
    const preserveFocus = active instanceof HTMLElement && node.contains(active) ? active : null;
    parent.insertBefore(node, ref);
    if (preserveFocus && document.activeElement !== preserveFocus) {
        preserveFocus.focus({ preventScroll: true });
    }
}

/**
 * {§web-search} {§web-session-directory} {§web-workspace-folder} {§web-page-shell}
 * Keyed DOM reconciler and in-place filter for `#search-workspaces` cards and nested session trees.
 * @param {Element} workspacesOutlet
 * @param {Element | null} suggestionsElement
 */
export function createOverviewRenderer(workspacesOutlet, suggestionsElement) {
    const suggestionsList = suggestionsElement instanceof HTMLDataListElement ? suggestionsElement : null;
    /** @type {Map<number, HTMLLIElement>} */
    const workspaceRowsById = new Map();
    /** @type {Map<string, HTMLLIElement>} */
    const sessionRowsByKey = new Map();

    /**
     * @param {OverviewStore} store
     * @param {OverviewFilters} filters
     */
    function applyFilter(store, filters) {
        const { filterQuery, filterWorkspace, filterStatus, filterKind } = filters;
        const showArchived = filterStatus === "archived";
        const query = filterQuery.trim().toLowerCase();
        const isNarrowing = Boolean(
            query
            || filterWorkspace
            || (filterStatus !== "all" && filterStatus !== "archived")
            || filterKind !== "all",
        );

        /** @param {OverviewSession} session @param {OverviewWorkspace | undefined} ws */
        const matchesSelf = (session, ws) => {
            const wsName = ws?.name ?? session.workspaceName;
            if (filterWorkspace && wsName !== filterWorkspace) return false;
            if (filterStatus === "active" && !isActiveSession(session)) return false;
            if (filterStatus === "gated" && session.gates <= 0) return false;
            if (filterStatus === "failed" && session.lifecycle !== "failed") return false;
            if (filterKind === "root" && session.kind === "work") return false;
            if (filterKind === "work" && session.kind !== "work") return false;
            if (query === "") return true;
            if (session.matchedQuery === query) return true;
            const haystack = [
                session.name,
                `#${session.name}`,
                wsName,
                ws?.projectLabel ?? "",
                session.title ?? "",
                session.openingPrompt ?? "",
                session.reply?.excerpt ?? "",
            ].join("\n").toLowerCase();
            return haystack.includes(query);
        };

        /** @param {HTMLLIElement} row @param {OverviewWorkspace | undefined} ws @returns {boolean} */
        const filterSessionRow = (row, ws) => {
            const key = row.dataset.sessionKey ?? "";
            const session = store.sessionsByKey.get(key);
            if (session) {
                const article = $(row, ":scope > article");
                const headerOrSummary = article ? $(article, ":scope > header, :scope > details > summary") : null;
                if (headerOrSummary) {
                    const nextExcerpt = resolveDisplayedExcerpt(session, query);
                    let excerptEl = $(headerOrSummary, "[data-session-excerpt]");
                    if (nextExcerpt !== "") {
                        excerptEl ??= $.clone(headerOrSummary, "#session-excerpt-line");
                        if (excerptEl.textContent !== nextExcerpt) excerptEl.textContent = nextExcerpt;
                    } else {
                        excerptEl?.remove();
                    }
                }
            }
            let childMatch = false;
            const childList = $(row, ":scope > article > details > ul");
            if (childList instanceof HTMLUListElement) {
                if (filterKind === "root") {
                    childList.hidden = true;
                } else {
                    childList.hidden = false;
                    for (const child of childList.children) {
                        if (child instanceof HTMLLIElement && filterSessionRow(child, ws)) {
                            childMatch = true;
                        }
                    }
                }
            }
            const visible = (session ? matchesSelf(session, ws) : true) || (filterKind !== "root" && childMatch);
            row.hidden = !visible;
            return visible;
        };

        const wsList = $(workspacesOutlet, ":scope > ul");
        let visibleWsCount = 0;
        if (wsList instanceof HTMLUListElement) {
            for (const wsItem of wsList.children) {
                if (!(wsItem instanceof HTMLLIElement)) continue;
                const wsId = Number(wsItem.dataset.workspaceId ?? "NaN");
                const ws = Number.isFinite(wsId) ? store.workspacesById.get(wsId) : undefined;
                const wsName = ws?.name ?? wsItem.dataset.workspaceName ?? "";
                if (filterWorkspace && wsName !== filterWorkspace) {
                    wsItem.hidden = true;
                    continue;
                }
                let visibleSessionsInWs = 0;
                const rootList = $(wsItem, ":scope > article > ul[data-workspace-sessions]");
                if (rootList instanceof HTMLUListElement) {
                    let visibleRoots = 0;
                    for (const sRow of rootList.children) {
                        if (sRow instanceof HTMLLIElement && filterSessionRow(sRow, ws)) {
                            visibleRoots += 1;
                        }
                    }
                    rootList.hidden = visibleRoots === 0;
                    visibleSessionsInWs += visibleRoots;
                }
                const bgDetails = $(wsItem, ":scope > article > details[data-workspace-background]");
                if (bgDetails instanceof HTMLDetailsElement) {
                    if (filterKind === "root") {
                        bgDetails.hidden = true;
                    } else {
                        let visibleBg = 0;
                        const bgList = $(bgDetails, ":scope > ul");
                        if (bgList instanceof HTMLUListElement) {
                            for (const sRow of bgList.children) {
                                if (sRow instanceof HTMLLIElement && filterSessionRow(sRow, ws)) {
                                    visibleBg += 1;
                                }
                            }
                        }
                        bgDetails.hidden = visibleBg === 0;
                        visibleSessionsInWs += visibleBg;
                    }
                }
                let showWs = true;
                if (showArchived && !(ws?.archived ?? wsItem.dataset.archived === "true") && visibleSessionsInWs === 0) {
                    showWs = false;
                } else if (filterStatus !== "all" && filterStatus !== "archived" && visibleSessionsInWs === 0) {
                    showWs = false;
                } else if (filterKind !== "all" && visibleSessionsInWs === 0) {
                    showWs = false;
                } else if (query !== "" && visibleSessionsInWs === 0) {
                    const wsHay = `${wsName}\n${ws?.projectLabel ?? ""}`.toLowerCase();
                    if (!wsHay.includes(query)) showWs = false;
                }
                wsItem.hidden = !showWs;
                if (showWs) visibleWsCount += 1;
            }
            wsList.hidden = visibleWsCount === 0;
        }

        const omittedCount = store.getOmittedCount();
        let omittedEl = $(workspacesOutlet, ":scope > p[data-overview-omitted]");
        if (omittedCount > 0 && !isNarrowing && !showArchived) {
            omittedEl ??= $.clone(workspacesOutlet, "#overview-omitted-note");
            the(omittedEl, "overview-omitted", String(omittedCount));
            if (omittedEl instanceof HTMLElement) omittedEl.hidden = false;
        } else {
            omittedEl?.remove();
            omittedEl = null;
        }

        const emptyWs = $(workspacesOutlet, ':scope > p[data-i18n="no-workspaces"]');
        const emptySess = $(workspacesOutlet, ':scope > p[data-i18n="no-sessions"]');
        if (!store.isInitialLoadDone()) {
            emptyWs?.remove();
            emptySess?.remove();
            return;
        }
        if (visibleWsCount === 0) {
            const hasAnyWorkspaceInPosture = [...store.workspacesById.values()].some((ws) => showArchived ? ws.archived : !ws.archived);
            const preferNoWorkspaces = !hasAnyWorkspaceInPosture && !isNarrowing;
            if (preferNoWorkspaces) {
                emptySess?.remove();
                if (!emptyWs) {
                    if (omittedEl) $.clone(omittedEl, "#workspaces-empty", { position: "beforebegin" });
                    else $.clone(workspacesOutlet, "#workspaces-empty");
                }
            } else {
                emptyWs?.remove();
                if (!emptySess) {
                    if (omittedEl) $.clone(omittedEl, "#overview-empty", { position: "beforebegin" });
                    else $.clone(workspacesOutlet, "#overview-empty");
                }
            }
        } else {
            emptyWs?.remove();
            emptySess?.remove();
        }
    }

    /**
     * @param {OverviewStore} store
     * @param {OverviewFilters} filters
     */
    function reconcileDom(store, filters) {
        const showArchived = filters.filterStatus === "archived";
        populateDatalist(suggestionsList, store.collectSuggestionTerms(showArchived));

        const childParents = new Set();
        for (const s of store.sessionsByKey.values()) {
            if (s.origin !== "model" || s.parentSessionId === null) continue;
            const ws = store.workspacesById.get(s.workspaceId);
            const isArchived = s.archived || Boolean(ws?.archived);
            if (showArchived ? !isArchived : isArchived) continue;
            childParents.add(`${s.workspaceId}:${s.parentSessionId}`);
        }

        /** @type {Map<number, OverviewSession[]>} */
        const sessionsByWs = new Map();
        for (const s of store.sessionsByKey.values()) {
            if (s.origin !== "model") continue;
            const ws = store.workspacesById.get(s.workspaceId);
            const isArchived = s.archived || Boolean(ws?.archived);
            if (showArchived ? !isArchived : isArchived) continue;
            if (isUntouchedDraftOverviewSession(s, childParents.has(`${s.workspaceId}:${s.id}`))) continue;
            const bucket = sessionsByWs.get(s.workspaceId) ?? [];
            bucket.push(s);
            sessionsByWs.set(s.workspaceId, bucket);
        }

        const candidateWorkspaces = [...store.workspacesById.values()].filter((ws) => {
            const wsSessions = sessionsByWs.get(ws.id) ?? [];
            return showArchived ? (ws.archived || wsSessions.length > 0) : !ws.archived;
        });

        const maxReplyByWs = new Map(candidateWorkspaces.map((ws) => {
            const wsSessions = sessionsByWs.get(ws.id) ?? [];
            let maxReply = -1;
            for (const s of wsSessions) {
                if (s.reply !== null && s.reply.id > maxReply) maxReply = s.reply.id;
            }
            return [ws.id, maxReply];
        }));

        const orderedWorkspaces = candidateWorkspaces.toSorted((a, b) => {
            const aMax = maxReplyByWs.get(a.id) ?? -1;
            const bMax = maxReplyByWs.get(b.id) ?? -1;
            if (aMax !== bMax) return bMax - aMax;
            const aHas = (sessionsByWs.get(a.id)?.length ?? 0) > 0;
            const bHas = (sessionsByWs.get(b.id)?.length ?? 0) > 0;
            if (aHas !== bHas) return aHas ? -1 : 1;
            return a.order - b.order;
        });

        /** @type {Set<HTMLLIElement>} */
        const claimedSessionRows = new Set();
        /** @type {Set<HTMLLIElement>} */
        const claimedWsRows = new Set();
        const queryLower = filters.filterQuery.trim().toLowerCase();

        /** @param {Element} list @param {OverviewSession} session @param {OverviewWorkspace} ws */
        const findOrCloneSessionRow = (list, session, ws) => {
            const key = `${session.workspaceId}:${session.id}`;
            let row = sessionRowsByKey.get(key);
            if (!row || !row.isConnected || claimedSessionRows.has(row)) {
                const byKey = $(workspacesOutlet, `li[data-directory-entry="session"][data-session-key="${CSS.escape(key)}"]`);
                if (byKey instanceof HTMLLIElement && !claimedSessionRows.has(byKey)) {
                    row = byKey;
                } else {
                    row = /** @type {HTMLLIElement} */ ($.clone(list, "#session-card"));
                }
                sessionRowsByKey.set(key, row);
            }
            row.dataset.sessionKey = key;
            row.dataset.sessionKind = session.kind;
            row.dataset.workspaceName = ws.name;
            row.dataset.lifecycleState = session.lifecycle;
            row.dataset.gateCount = String(session.gates);
            if (session.reply !== null) row.dataset.replyId = String(session.reply.id);
            else delete row.dataset.replyId;
            if (session.archived || ws.archived) row.dataset.archived = "true";
            else delete row.dataset.archived;
            claimedSessionRows.add(row);
            return row;
        };

        /**
         * @param {HTMLLIElement} row
         * @param {OverviewSession} session
         * @param {OverviewWorkspace} ws
         * @param {ReadonlyMap<number | null, OverviewSession[]>} children
         * @param {ReadonlyMap<number, OverviewSession>} byId
         */
        const reconcileSessionCard = (row, session, ws, children, byId) => {
            const descendants = children.get(session.id) ?? [];
            const parentModel = session.parentSessionId !== null && session.parentSessionId > 0
                ? (byId.get(session.parentSessionId) ?? null)
                : null;
            const hasLineage = parentModel !== null || session.parentName !== null;
            const { header, body } = card(row, descendants.length > 0);
            const identity = $(header, "[data-session-identity]");
            if (identity) {
                const lifecycleEl = $(identity, "[data-lifecycle]");
                if (lifecycleEl && lifecycleEl.getAttribute("data-lifecycle") !== session.lifecycle) {
                    lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
                    lifecycleEl.setAttribute("aria-label", session.lifecycle);
                    lifecycleEl.setAttribute("title", session.lifecycle);
                }

                const link = $(identity, "[data-session-link]");
                const sessionPath = directoryPath({ kind: "session", workspace: ws.name, session: session.name });
                const rawTitle = typeof session.title === "string" && session.title.trim() !== "" ? session.title.trim() : null;
                const rawPrompt = typeof session.openingPrompt === "string" && session.openingPrompt.trim() !== "" ? session.openingPrompt.trim() : null;
                const headline = rawTitle ?? rawPrompt ?? `#${session.name}`;
                const showHandle = headline !== `#${session.name}`;
                if (link) {
                    if (sessionPath !== null && link instanceof HTMLAnchorElement) {
                        if (link.getAttribute("href") !== sessionPath) link.setAttribute("href", sessionPath);
                        if (link.getAttribute("aria-label") !== session.name) link.setAttribute("aria-label", session.name);
                        const titleAttr = `Open #${session.name}`;
                        if (link.getAttribute("title") !== titleAttr) link.setAttribute("title", titleAttr);
                    }
                    if (rawTitle !== null) link.setAttribute("data-session-title", rawTitle);
                    else link.removeAttribute("data-session-title");
                    if (rawPrompt !== null) link.setAttribute("data-session-prompt", rawPrompt);
                    else link.removeAttribute("data-session-prompt");
                    const headlineSpan = $(link, "[data-session-headline]") ?? link;
                    if (headlineSpan.textContent !== headline) headlineSpan.textContent = headline;
                }

                let parentSpan = $(identity, "[data-session-parent]");
                if (!hasLineage) {
                    parentSpan?.remove();
                } else if (link) {
                    const pOrigin = parentModel ? parentModel.origin : session.parentOrigin;
                    const pName = parentModel ? parentModel.name : (session.parentName ?? "_plurnk");
                    const parentPath = pOrigin === "model"
                        ? directoryPath({ kind: "session", workspace: ws.name, session: pName })
                        : null;
                    if (parentPath !== null) {
                        let parentLink = parentSpan ? $(parentSpan, "a") : null;
                        if (!parentSpan || !parentLink) {
                            parentSpan?.remove();
                            parentSpan = $.clone(link, "#session-parent-link", { position: "beforebegin" });
                            parentLink = $(parentSpan, "a");
                        }
                        if (parentLink) {
                            if (parentLink.getAttribute("href") !== parentPath) parentLink.setAttribute("href", parentPath);
                            if (parentLink.textContent !== pName) parentLink.textContent = pName;
                        }
                    } else {
                        let parentText = parentSpan && !$(parentSpan, "a") ? $(parentSpan, "span") : null;
                        if (!parentSpan || !parentText) {
                            parentSpan?.remove();
                            parentSpan = $.clone(link, "#session-parent-text", { position: "beforebegin" });
                            parentText = $(parentSpan, "span");
                        }
                        if (parentText && parentText.textContent !== pName) parentText.textContent = pName;
                    }
                }

                let handleBadge = $(identity, "[data-session-handle]");
                if (showHandle && link) {
                    handleBadge ??= $.clone(link, "#session-handle-badge", { position: "afterend" });
                    const handleText = `#${session.name}`;
                    if (handleBadge.textContent !== handleText) handleBadge.textContent = handleText;
                } else {
                    handleBadge?.remove();
                }

                const metaAnchor = $(identity, "[data-session-meta]");
                let gatesBadge = $(identity, "[data-session-gates]");
                if (session.gates > 0) {
                    if (!gatesBadge) {
                        gatesBadge = metaAnchor
                            ? $.clone(metaAnchor, "#session-gates-badge", { position: "beforebegin" })
                            : $.clone(identity, "#session-gates-badge");
                    }
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
                    if (!childrenBadge) {
                        childrenBadge = metaAnchor
                            ? $.clone(metaAnchor, "#session-children-badge", { position: "beforebegin" })
                            : $.clone(identity, "#session-children-badge");
                    }
                    const countText = String(descendants.length);
                    const label = `${descendants.length} ${descendants.length === 1 ? "child" : "children"}`;
                    childrenBadge.setAttribute("data-session-children", countText);
                    childrenBadge.setAttribute("aria-label", label);
                    childrenBadge.setAttribute("title", label);
                    if (childrenBadge.textContent !== countText) childrenBadge.textContent = countText;
                } else {
                    childrenBadge?.remove();
                }

                const hasTime = typeof session.reply?.at === "number" && Number.isFinite(session.reply.at);
                const isSessArchived = session.archived || ws.archived;
                let metaEl = $(identity, "[data-session-meta]");
                if (hasTime || isSessArchived) {
                    metaEl ??= $.clone(identity, "#session-meta-group");
                    let timeBadge = $(metaEl, "time[data-session-time]");
                    if (hasTime && session.reply?.at !== undefined) {
                        timeBadge ??= $.clone(metaEl, "#session-time-badge", { position: "afterbegin" });
                        const iso = new Date(session.reply.at).toISOString();
                        if (timeBadge.getAttribute("datetime") !== iso) timeBadge.setAttribute("datetime", iso);
                        if (timeBadge.getAttribute("title") !== iso) timeBadge.setAttribute("title", iso);
                        const relative = formatRelativeAge(session.reply.at);
                        if (timeBadge.textContent !== relative) timeBadge.textContent = relative;
                    } else {
                        timeBadge?.remove();
                    }
                    let unarchiveForm = $(metaEl, 'form[data-inline-unarchive="session"]');
                    if (isSessArchived) {
                        unarchiveForm ??= $.clone(metaEl, "#session-unarchive-form");
                        const wsInput = $(unarchiveForm, 'input[name="workspace"]');
                        const sessInput = $(unarchiveForm, 'input[name="session"]');
                        if (wsInput instanceof HTMLInputElement) {
                            wsInput.value = ws.name;
                            wsInput.setAttribute("value", ws.name);
                        }
                        if (sessInput instanceof HTMLInputElement) {
                            sessInput.value = session.name;
                            sessInput.setAttribute("value", session.name);
                        }
                    } else {
                        unarchiveForm?.remove();
                    }
                } else {
                    metaEl?.remove();
                }
            }

            const excerptText = resolveDisplayedExcerpt(session, queryLower);
            let excerptEl = $(header, "[data-session-excerpt]");
            if (excerptText !== "") {
                excerptEl ??= $.clone(header, "#session-excerpt-line");
                if (excerptEl.textContent !== excerptText) excerptEl.textContent = excerptText;
            } else {
                excerptEl?.remove();
            }

            if (!(body instanceof HTMLDetailsElement)) return;
            let childList = $(body, ":scope > ul");
            if (descendants.length > 0) {
                childList ??= $.clone(body, "#overview-list");
                reconcileSessionList(childList, descendants, ws, children, byId);
            } else {
                childList?.remove();
            }
        };

        /**
         * @param {Element} list
         * @param {readonly OverviewSession[]} entries
         * @param {OverviewWorkspace} ws
         * @param {ReadonlyMap<number | null, OverviewSession[]>} children
         * @param {ReadonlyMap<number, OverviewSession>} byId
         */
        function reconcileSessionList(list, entries, ws, children, byId) {
            for (const [index, session] of entries.entries()) {
                const row = findOrCloneSessionRow(list, session, ws);
                if (list.children[index] !== row) {
                    placeBefore(list, row, list.children[index] ?? null);
                }
                reconcileSessionCard(row, session, ws, children, byId);
            }
            while (list.children.length > entries.length) {
                list.lastElementChild?.remove();
            }
        }

        const omittedEl = $(workspacesOutlet, ":scope > p[data-overview-omitted]");
        let wsList = $(workspacesOutlet, ":scope > ul");
        if (orderedWorkspaces.length === 0) {
            wsList?.remove();
            applyFilter(store, filters);
            return;
        }
        if (!wsList) {
            wsList = omittedEl
                ? $.clone(omittedEl, "#overview-list", { position: "beforebegin" })
                : $.clone(workspacesOutlet, "#overview-list");
        }

        for (const [wsIndex, ws] of orderedWorkspaces.entries()) {
            let wsRow = workspaceRowsById.get(ws.id);
            if (!wsRow || !wsRow.isConnected || claimedWsRows.has(wsRow)) {
                const byIdEl = $(workspacesOutlet, `li[data-directory-entry="workspace"][data-workspace-id="${CSS.escape(String(ws.id))}"]`);
                if (byIdEl instanceof HTMLLIElement && !claimedWsRows.has(byIdEl)) {
                    wsRow = byIdEl;
                } else {
                    wsRow = /** @type {HTMLLIElement} */ ($.clone(wsList, "#workspace-card"));
                }
                workspaceRowsById.set(ws.id, wsRow);
            }
            claimedWsRows.add(wsRow);
            if (wsList.children[wsIndex] !== wsRow) {
                placeBefore(wsList, wsRow, wsList.children[wsIndex] ?? null);
            }

            wsRow.dataset.workspaceId = String(ws.id);
            wsRow.dataset.workspaceName = ws.name;
            wsRow.dataset.folder = String(ws.projectRoot !== null);
            if (ws.archived) wsRow.dataset.archived = "true";
            else delete wsRow.dataset.archived;

            const wsArticle = $(wsRow, ":scope > article");
            if (wsArticle) {
                const wsAriaLabel = ws.projectRoot === null ? "Folderless workspace" : "Project workspace";
                if (wsArticle.getAttribute("aria-label") !== wsAriaLabel) wsArticle.setAttribute("aria-label", wsAriaLabel);
                const wsHeader = $(wsArticle, ":scope > header");
                if (wsHeader) {
                    const wsLink = $(wsHeader, 'a[data-text="name"]');
                    const wsPath = directoryPath({ kind: "workspace", workspace: ws.name });
                    if (wsLink) {
                        if (wsLink.textContent !== ws.name) wsLink.textContent = ws.name;
                        if (wsPath !== null && wsLink.getAttribute("href") !== wsPath) wsLink.setAttribute("href", wsPath);
                    }
                    let projNote = $(wsHeader, '[data-text="project-label"]');
                    if (ws.projectLabel !== null && ws.projectLabel !== ws.name && wsLink) {
                        projNote ??= $.clone(wsLink, "#workspace-project-note", { position: "afterend" });
                        if (projNote.textContent !== ws.projectLabel) projNote.textContent = ws.projectLabel;
                    } else {
                        projNote?.remove();
                    }
                    let wsUnarchive = $(wsHeader, 'form[data-inline-unarchive="workspace"]');
                    if (ws.archived) {
                        wsUnarchive ??= $.clone(wsHeader, "#workspace-unarchive-form");
                        const wsInput = $(wsUnarchive, 'input[name="workspace"]');
                        if (wsInput instanceof HTMLInputElement) {
                            wsInput.value = ws.name;
                            wsInput.setAttribute("value", ws.name);
                        }
                    } else {
                        wsUnarchive?.remove();
                    }
                }

                const sortedSessions = (sessionsByWs.get(ws.id) ?? []).toSorted(orderSessions);
                const byId = new Map(sortedSessions.map((s) => [s.id, s]));
                const visibleIds = new Set(sortedSessions.map((s) => s.id));
                const children = Map.groupBy(
                    sortedSessions,
                    (s) => s.parentSessionId !== null && visibleIds.has(s.parentSessionId) ? s.parentSessionId : null,
                );
                const background = sortedSessions.filter((s) =>
                    s.parentSessionId !== null && !visibleIds.has(s.parentSessionId) && s.parentOrigin !== "model",
                );
                const backgroundIds = new Set(background.map((s) => s.id));
                const roots = (children.get(null) ?? []).filter((s) => !backgroundIds.has(s.id));

                let rootList = $(wsArticle, ":scope > ul[data-workspace-sessions]");
                let bgDetails = $(wsArticle, ":scope > details[data-workspace-background]");
                if (roots.length > 0) {
                    if (!rootList) {
                        rootList = bgDetails
                            ? $.clone(bgDetails, "#overview-workspace-list", { position: "beforebegin" })
                            : $.clone(wsArticle, "#overview-workspace-list");
                    }
                    reconcileSessionList(rootList, roots, ws, children, byId);
                } else {
                    rootList?.remove();
                }
                if (background.length > 0) {
                    bgDetails ??= $.clone(wsArticle, "#overview-background");
                    const bgList = $(bgDetails, ":scope > ul");
                    if (bgList) reconcileSessionList(bgList, background, ws, children, byId);
                } else {
                    bgDetails?.remove();
                }
            }
        }
        while (wsList.children.length > orderedWorkspaces.length) {
            wsList.lastElementChild?.remove();
        }
        applyFilter(store, filters);
    }

    return {
        applyFilter,
        reconcileDom,
    };
}
