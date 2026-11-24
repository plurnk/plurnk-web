import { $, on, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import card from "./card.js";
import { overviewExcerptCharsLimit, overviewSessionsLimit } from "./endpoints.js";
import managementAction from "./management-action.js";
import { matchSnippet, truncateSingleLine } from "./session-selection.js";
import { parseWorkspaceList, renderWorkspacesDialog, wireWorkspaceCreateDialog } from "./workspace-dialogs.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";

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

/** @param {unknown} value @returns {"root" | "work" | "fork" | null} */
const asSessionKind = (value) => value === "root" || value === "work" || value === "fork" ? value : null;

/** @param {string} raw */
const singleLineExcerpt = (raw) => raw.replaceAll(/\s+/gu, " ").trim();

/** @param {OverviewSession} a @param {OverviewSession} b */
const orderSessions = (a, b) => a.reply !== null && b.reply !== null ? b.reply.id - a.reply.id
    : a.reply !== null ? -1 : b.reply !== null ? 1 : 0;

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

/** @param {OverviewSession} session */
const isActiveSession = (session) =>
    session.lifecycle === "running" || session.lifecycle === "queued" || session.lifecycle === "parked";

/**
 * {§web-search} {§web-session-directory}
 * @param {OverviewSession} session
 * @param {boolean} hasModelChildren
 */
function isUntouchedDraftOverviewSession(session, hasModelChildren) {
    return session.parentSessionId === null
        && session.kind === "root"
        && session.lifecycle === "idle"
        && session.reply === null
        && !(typeof session.title === "string" && session.title.trim() !== "")
        && !(typeof session.openingPrompt === "string" && session.openingPrompt.trim() !== "")
        && session.gates === 0
        && !hasModelChildren;
}

/**
 * {§web-search} {§web-session-directory} Live workspace-grouped Search & Directory page (`/search/`) powered exclusively by `/acp` + `/notifications`.
 * @param {HTMLElement} main
 */
export default function observeOverview(main) {
    const workspacesOutlet = $(main, "#search-workspaces") ?? main;
    const controlsForm = $(main, "#search-controls");
    const searchInput = controlsForm ? $(controlsForm, "input[data-overview-search]") : null;
    const suggestionsList = controlsForm ? $(controlsForm, "#search-suggestions") : null;
    const wsField = controlsForm ? $(controlsForm, "[data-search-workspace]") : null;
    const statusSelect = controlsForm ? $(controlsForm, "select[data-overview-scope]") : null;
    const kindField = controlsForm ? $(controlsForm, "[data-search-kind]") : null;

    let resources = new AbortController();
    /** @type {AbortController | null} */
    let searchAbort = null;
    /** @type {unknown[]} */
    const inFlightNotifications = [];
    /** @type {Map<number, HTMLLIElement>} */
    const workspaceRowsById = new Map();
    /** @type {Map<string, HTMLLIElement>} */
    const sessionRowsByKey = new Map();
    /** @type {Map<number, OverviewWorkspace>} */
    const workspacesById = new Map();
    /** @type {Map<string, OverviewSession>} */
    const sessionsByKey = new Map();
    /** @type {Map<string, readonly string[]>} */
    const loopPromptsCache = new Map();
    let nextWorkspaceOrder = 0;
    let omittedCount = 0;
    let initialLoadDone = false;

    const readFieldValue = (/** @type {Element | null} */ el, /** @type {string} */ fallback = "") =>
        el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : fallback;

    let filterQuery = searchInput instanceof HTMLInputElement ? searchInput.value : "";
    let filterWorkspace = readFieldValue(wsField, "");
    let filterStatus = readFieldValue(statusSelect, "all");
    let filterKind = readFieldValue(kindField, "all");

    wireWorkspaceCreateDialog({
        signal: resources.signal,
        getKnownWorkspaceNames: () => [...workspacesById.values()].map(({ name }) => name),
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

    /** @param {OverviewSession} session @param {string} queryLower */
    function resolveDisplayedExcerpt(session, queryLower) {
        if (queryLower !== "" && session.matchedQuery === queryLower && session.matchedExcerpt) {
            return session.matchedExcerpt;
        }
        return session.reply?.excerpt ?? "";
    }

    function updateSuggestionsDatalist() {
        if (!(suggestionsList instanceof HTMLDataListElement)) return;
        const showArchived = filterStatus === "archived";
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
        const list = [...terms].slice(0, 100);
        $.cloneEach(suggestionsList, "#search-suggestion-option", list, (opt, term) => {
            if (opt instanceof HTMLOptionElement) {
                opt.value = term;
                opt.setAttribute("value", term);
            }
        });
    }

    function applyFilter() {
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
            const session = sessionsByKey.get(key);
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
                const ws = Number.isFinite(wsId) ? workspacesById.get(wsId) : undefined;
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
        if (!initialLoadDone) {
            emptyWs?.remove();
            emptySess?.remove();
            return;
        }
        if (visibleWsCount === 0) {
            const hasAnyWorkspaceInPosture = [...workspacesById.values()].some((ws) => showArchived ? ws.archived : !ws.archived);
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

    function reconcileDom() {
        updateSuggestionsDatalist();
        const showArchived = filterStatus === "archived";
        const childParents = new Set();
        for (const s of sessionsByKey.values()) {
            if (s.origin !== "model" || s.parentSessionId === null) continue;
            const ws = workspacesById.get(s.workspaceId);
            const isArchived = s.archived || Boolean(ws?.archived);
            if (showArchived ? !isArchived : isArchived) continue;
            childParents.add(`${s.workspaceId}:${s.parentSessionId}`);
        }

        /** @type {Map<number, OverviewSession[]>} */
        const sessionsByWs = new Map();
        for (const s of sessionsByKey.values()) {
            if (s.origin !== "model") continue;
            const ws = workspacesById.get(s.workspaceId);
            const isArchived = s.archived || Boolean(ws?.archived);
            if (showArchived ? !isArchived : isArchived) continue;
            if (isUntouchedDraftOverviewSession(s, childParents.has(`${s.workspaceId}:${s.id}`))) continue;
            const bucket = sessionsByWs.get(s.workspaceId) ?? [];
            bucket.push(s);
            sessionsByWs.set(s.workspaceId, bucket);
        }

        const candidateWorkspaces = [...workspacesById.values()].filter((ws) => {
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
        const queryLower = filterQuery.trim().toLowerCase();

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
            applyFilter();
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
        applyFilter();
    }

    /**
     * Fetch prompts from `session.loops` for a session (cached per `workspaceId:sessionId:replyId`).
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

    async function fetchAcpSearch() {
        searchAbort?.abort();
        searchAbort = null;
        inFlightNotifications.length = 0;
        const controller = new AbortController();
        searchAbort = controller;
        const signal = AbortSignal.any([resources.signal, controller.signal]);
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

        try {
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
            if (signal.aborted || disposed) return;

            const listedWorkspaces = parseWorkspaceList(rawWsList);
            renderWorkspacesDialog(listedWorkspaces, null);

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
            if (signal.aborted || disposed) return;

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
            if (signal.aborted || disposed) return;

            workspacesById.clear();
            for (const [id, ws] of nextWorkspaces) workspacesById.set(id, ws);
            nextWorkspaceOrder = nextOrder;
            sessionsByKey.clear();
            for (const [k, v] of nextSessions) sessionsByKey.set(k, v);
            initialLoadDone = true;
            const buffered = inFlightNotifications.splice(0);
            if (searchAbort === controller) searchAbort = null;
            for (const payload of buffered) {
                applyNotification(payload);
            }
            reconcileDom();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
        } finally {
            if (searchAbort === controller) searchAbort = null;
        }
    }

    let unarchiveBusy = false;
    on(main, "submit", "form[data-inline-unarchive]", (event, form) => {
        if (!(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        if (unarchiveBusy) return;
        const kind = form.dataset.inlineUnarchive;
        const data = new FormData(form);
        const wsName = String(data.get("workspace") ?? "").trim();
        const sessName = String(data.get("session") ?? "").trim();
        if (!wsName) return;
        const wsEntry = [...workspacesById.values()].find(({ name }) => name === wsName);
        unarchiveBusy = true;
        void (async () => {
            try {
                if (kind === "workspace") {
                    await managementAction(
                        "workspace.archive",
                        { workspace: wsName, ...(wsEntry ? { workspaceId: wsEntry.id } : {}), archived: false },
                        "",
                        resources.signal,
                        { workspace: wsName, ...(wsEntry ? { workspaceId: wsEntry.id } : {}) },
                    );
                    location.assign(directoryPath({ kind: "workspace", workspace: wsName }) ?? "/search/");
                    return;
                }
                if (kind === "session" && sessName && wsEntry) {
                    if (wsEntry.archived) {
                        await managementAction(
                            "workspace.archive",
                            { workspaceId: wsEntry.id, archived: false },
                            "",
                            resources.signal,
                            { workspaceId: wsEntry.id },
                        );
                    }
                    await managementAction(
                        "session/unarchive",
                        {},
                        `${wsEntry.id}#${sessName}`,
                        resources.signal,
                    );
                    location.assign(directoryPath({ kind: "session", workspace: wsName, session: sessName }) ?? "/search/");
                }
            } finally {
                unarchiveBusy = false;
            }
        })();
    });

    if (controlsForm instanceof HTMLFormElement) {
        on(controlsForm, "submit", "form", (event) => {
            event.preventDefault();
            filterQuery = searchInput instanceof HTMLInputElement ? searchInput.value : "";
            filterWorkspace = readFieldValue(wsField, "");
            filterStatus = readFieldValue(statusSelect, "all");
            filterKind = readFieldValue(kindField, "all");
            syncUrlQuery();
            applyFilter();
            void fetchAcpSearch();
        });
        on(controlsForm, "input", "input[data-overview-search]", (_event, input) => {
            if (input instanceof HTMLInputElement) {
                filterQuery = input.value;
                syncUrlQuery();
                applyFilter();
                void fetchAcpSearch();
            }
        });
        on(controlsForm, "change", "select", (_event, select) => {
            if (!(select instanceof HTMLSelectElement)) return;
            filterWorkspace = readFieldValue(wsField, "");
            filterStatus = readFieldValue(statusSelect, "all");
            filterKind = readFieldValue(kindField, "all");
            syncUrlQuery();
            applyFilter();
            void fetchAcpSearch();
        });
    }

    /** @param {unknown} raw */
    function applyNotification(raw) {
        if (filterStatus === "archived") return;
        if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) return;
        const { event, data } = raw;
        const notifWorkspaceId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
        const notifSessionId = typeof raw.sessionId === "number" ? raw.sessionId : null;
        const notifTimestamp = typeof raw.timestamp === "number" ? raw.timestamp : Date.now();

        switch (event) {
            case "workspace/created": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                const name = typeof data.name === "string" ? data.name : null;
                if (id === null || name === null) return;
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
                reconcileDom();
                return;
            }
            case "workspace/renamed": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                const name = typeof data.name === "string" ? data.name : null;
                if (id === null || name === null) return;
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
                reconcileDom();
                return;
            }
            case "workspace/archived": {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                if (id === null) return;
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
                reconcileDom();
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
                workspacesById.set(wsId, {
                    id: wsId,
                    name: wsName,
                    projectRoot: projRoot,
                    projectLabel: projLabel,
                    archived: false,
                    order: prevWs?.order ?? nextWorkspaceOrder++,
                });
                if (data.origin !== "model") {
                    reconcileDom();
                    return;
                }
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
                reconcileDom();
                return;
            }
            case "session/archived":
            case "session/deleted": {
                if (event === "session/archived" && (data.archivedAt === null || data.archivedAt === undefined)) return;
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
                const nextTitle = typeof data.title === "string" && data.title.trim().length > 0 ? data.title.trim() : undefined;
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
                const sid = typeof entry.sessionId === "number" ? entry.sessionId : notifSessionId;
                if (wsId === null || sid === null) return;
                const key = `${wsId}:${sid}`;
                const cur = sessionsByKey.get(key);
                if (!cur) return;
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
                const rawPrompt = typeof data.prompt === "string" ? singleLineExcerpt(data.prompt) : "";
                const nextOpeningPrompt = cur.openingPrompt ?? (rawPrompt !== "" ? rawPrompt : undefined);
                if (cur.lifecycle !== lifecycle || nextOpeningPrompt !== cur.openingPrompt) {
                    sessionsByKey.set(key, {
                        ...cur,
                        lifecycle,
                        ...(nextOpeningPrompt ? { openingPrompt: nextOpeningPrompt } : {}),
                    });
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
                void fetchAcpSearch();
                return;
            }
            default:
                return;
        }
    }

    let disposed = false;
    void fetchAcpSearch();

    const notifications = subscribeWorkspaceNotifications({
        onStateChange: (state) => {
            if (!disposed) the(main, "connection", state);
        },
        onNotification: (payload) => {
            if (disposed) return;
            if (searchAbort !== null && isRecord(payload) && payload.event !== "notifications/resync") {
                inFlightNotifications.push(payload);
            }
            applyNotification(payload);
        },
    });

    const offPageHide = on.target(window, "pagehide", () => {
        if (disposed) return;
        searchAbort?.abort();
        resources.abort();
    });
    const offPageShow = on.target(window, "pageshow", (event) => {
        if (disposed) return;
        if (event instanceof PageTransitionEvent && event.persisted) {
            resources = new AbortController();
            void fetchAcpSearch();
        }
    });

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            offPageHide();
            offPageShow();
            notifications.unsubscribe();
            searchAbort?.abort();
            resources.abort();
        },
    };
}
