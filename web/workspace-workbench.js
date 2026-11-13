import { $, $$, on, route, the } from "on_the_money";
import { directoryPath, parseDirectory } from "../src/directory-addresses.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";

// {§web-workspace-tabs} RFC 9112 caps HTTP/1.1 browsers at 6 concurrent connections per origin.
// Retaining 1 workspace /notifications SSE stream plus at most 3 connected SessionAgent /acp streams
// always reserves >= 2 connections for POST /auth/token, POST /acp, GET hydrations, and POST /render/mermaid.
const MAX_CONNECTED_SESSION_PANES = 3;

const INTRA_WORKSPACE_LINK = [
    "[data-workspace-route]",
    "main a[data-session-link]",
    "main a[data-session-name]",
    "main [data-session-workspace] a",
    "#session-workspace a",
    "#session-descendants a",
].join(", ");

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly name: string,
 *   readonly parentSessionId: number | null,
 *   readonly kind: "root" | "work" | "fork",
 *   readonly lifecycle: string,
 *   readonly gates: number,
 *   readonly replyId: number | null,
 *   readonly archived: boolean,
 * }} WorkbenchSession
 */

/**
 * @typedef {{
 *   deactivate(): void,
 *   activate(): void,
 *   canEvict(): boolean,
 *   dispose(): void,
 * }} PaneController
 */

/**
 * @typedef {{
 *   readonly routeKey: string,
 *   readonly kind: "workspace" | "session",
 *   readonly sessionName: string | null,
 *   readonly main: HTMLElement,
 *   readonly footer: HTMLElement | null,
 *   readonly breadcrumb: HTMLElement,
 *   readonly controller: PaneController,
 *   lastUsedSeq: number,
 * }} PaneEntry
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {"root" | "work" | "fork" | null} */
const asSessionKind = (value) => value === "root" || value === "work" || value === "fork" ? value : null;

/** @param {WorkbenchSession} a @param {WorkbenchSession} b */
const orderByReply = (a, b) => a.replyId !== null && b.replyId !== null ? b.replyId - a.replyId
    : a.replyId !== null ? -1 : b.replyId !== null ? 1 : 0;

/** @param {WorkbenchSession} session @param {string | null} selectedSession */
function isVisibleInTabStrip(session, selectedSession) {
    if (session.name === selectedSession) return true;
    if (session.archived) return false;
    if (session.parentSessionId === null || session.kind === "root" || session.kind === "fork") return true;
    return ["queued", "running", "parked", "failed"].includes(session.lifecycle) || session.gates > 0;
}

/**
 * {§web-workspace-tabs} Live intra-workspace tab bar, quick-switcher modal, and resident pane workbench.
 * @param {HTMLElement} tabs
 */
export default async function observeWorkspaceWorkbench(tabs) {
    const rawWorkspaceId = tabs.dataset.workspaceId ?? "";
    const rawAuth = tabs.dataset.auth;
    if (!/^[1-9]\d*$/u.test(rawWorkspaceId) || (rawAuth !== "session" && rawAuth !== "none")) {
        throw new Error("Workspace workbench metadata is incomplete.");
    }
    const workspaceId = Number(rawWorkspaceId);
    const auth = rawAuth;
    const live = tabs.dataset.live === "true";
    let currentWorkspaceName = tabs.dataset.workspaceName ?? String(workspaceId);
    /** @type {Set<string>} */
    const knownWorkspaceNames = new Set([currentWorkspaceName]);

    const rawTabsList = $(tabs, ":scope > ul");
    const rawSwitcherButton = $(tabs, ":scope > button[data-workspace-switcher]");
    const initialMain = $("#main");
    if (!(rawTabsList instanceof HTMLUListElement) || !(rawSwitcherButton instanceof HTMLButtonElement) || !(initialMain instanceof HTMLElement)) {
        throw new Error("Workspace workbench shell is incomplete.");
    }
    const tabsList = rawTabsList;
    const switcherButton = rawSwitcherButton;

    const rawHeader = $("body > header");
    if (!(rawHeader instanceof HTMLElement)) throw new Error("Workspace header is absent.");
    const headerEl = rawHeader;

    /** @returns {{ icon: string, label: string }} */
    function readBreadcrumbMarker() {
        const sessionMarker = $('#session-workspace > [role="img"]');
        if (sessionMarker) {
            return {
                icon: sessionMarker.textContent ?? "☁️",
                label: sessionMarker.getAttribute("aria-label") ?? "Folderless workspace",
            };
        }
        const overviewCurrent = $('header nav[aria-label="breadcrumb"] [aria-current="page"][data-text="name"]');
        const prev = overviewCurrent?.previousElementSibling;
        return {
            icon: prev?.textContent ?? "☁️",
            label: prev?.getAttribute("aria-label") ?? "Folderless workspace",
        };
    }

    let workspaceMarker = readBreadcrumbMarker();
    /** @type {boolean | null} */
    let hasProjectRoot = workspaceMarker.icon === "🗂️" ? true : null;
    /** @type {string | null} */
    let projectLabel = initialMain.dataset.page === "session"
        ? ($(initialMain, "#session-folder")?.getAttribute("data-project-label") || (workspaceMarker.icon === "🗂️" ? currentWorkspaceName : null))
        : ($(initialMain, '[data-text="project-label"]')?.textContent ?? (workspaceMarker.icon === "🗂️" ? currentWorkspaceName : null));
    if (projectLabel !== null) hasProjectRoot = true;

    function recomputeWorkspaceMarker() {
        const separateFolder = projectLabel !== null && projectLabel !== currentWorkspaceName;
        if (separateFolder) {
            workspaceMarker = { icon: "☁️", label: "Workspace" };
        } else if (hasProjectRoot === true || projectLabel !== null) {
            workspaceMarker = { icon: "🗂️", label: "Project workspace" };
        } else {
            workspaceMarker = { icon: "☁️", label: "Folderless workspace" };
        }
    }

    /** @type {string | null} */
    let selectedSessionName = initialMain.dataset.page === "session"
        ? ($("#session-status")?.getAttribute("data-session-name") ?? null)
        : null;

    /** @type {Map<number, WorkbenchSession>} */
    const sessionsById = new Map();
    /** @type {Map<number, HTMLLIElement>} */
    const tabRowsById = new Map();

    for (const item of $$(tabsList, ":scope > li[data-tab-id]")) {
        if (!(item instanceof HTMLLIElement)) continue;
        const idMatch = /^(\d+):(\d+)$/u.exec(item.dataset.tabId ?? "");
        if (!idMatch) continue;
        const id = Number(idMatch[2]);
        tabRowsById.set(id, item);
        const link = $(item, "a[data-tab-session]");
        const name = link instanceof HTMLElement ? (link.dataset.tabSession ?? String(id)) : String(id);
        const rawParent = item.dataset.parentId;
        const parentSessionId = rawParent && /^\d+$/u.test(rawParent) ? Number(rawParent) : null;
        const kind = asSessionKind(item.dataset.sessionKind) ?? (parentSessionId === null ? "root" : "work");
        const lifecycle = $(item, "[data-lifecycle]")?.getAttribute("data-lifecycle") ?? "idle";
        const rawGates = $(item, "[data-session-gates]")?.getAttribute("data-session-gates");
        const gates = rawGates && /^\d+$/u.test(rawGates) ? Number(rawGates) : 0;
        const rawReply = item.dataset.replyId;
        const replyId = rawReply && /^\d+$/u.test(rawReply) ? Number(rawReply) : null;
        const archived = item.dataset.archived === "true";
        sessionsById.set(id, { id, name, parentSessionId, kind, lifecycle, gates, replyId, archived });
    }

    /** @param {ParentNode} overviewMain */
    function hydrateSessionsFromOverview(overviewMain) {
        for (const row of $$(overviewMain, 'li[data-directory-entry="session"]')) {
            if (!(row instanceof HTMLLIElement)) continue;
            const keyMatch = /^(\d+):(\d+)$/u.exec(row.dataset.sessionKey ?? "");
            if (!keyMatch || Number(keyMatch[1]) !== workspaceId) continue;
            const id = Number(keyMatch[2]);
            const parentRow = row.parentElement?.closest('li[data-directory-entry="session"]');
            const parentMatch = parentRow instanceof HTMLLIElement && parentRow.dataset.sessionKey
                ? /^(\d+):(\d+)$/u.exec(parentRow.dataset.sessionKey)
                : null;
            const enclosingDetails = row.closest("details");
            const isBackground = parentMatch === null && enclosingDetails instanceof HTMLDetailsElement
                && $(enclosingDetails, ':scope > summary[data-i18n="background-work"]') !== null;
            const parentSessionId = parentMatch ? Number(parentMatch[2]) : isBackground ? 0 : null;
            const kind = asSessionKind(row.dataset.sessionKind) ?? (parentSessionId === null ? "root" : "work");
            const identity = $(row, ":scope > article > header [data-session-identity], :scope > article > details > summary [data-session-identity]");
            const name = (identity ? $(identity, ":scope > span:last-of-type")?.textContent : null) ?? String(id);
            const lifecycle = (identity ? $(identity, "[data-lifecycle]")?.getAttribute("data-lifecycle") : null) ?? "idle";
            const rawGates = identity ? $(identity, "[data-session-gates]")?.getAttribute("data-session-gates") : null;
            const gates = rawGates && /^\d+$/u.test(rawGates) ? Number(rawGates) : 0;
            const rawReply = row.dataset.replyId;
            const replyId = rawReply && /^\d+$/u.test(rawReply) ? Number(rawReply) : (sessionsById.get(id)?.replyId ?? null);
            sessionsById.set(id, { id, name, parentSessionId, kind, lifecycle, gates, replyId, archived: false });
        }
    }

    if (initialMain.dataset.page === "workspace") {
        hydrateSessionsFromOverview(initialMain);
    }

    /** @returns {WorkbenchSession[]} */
    function computeOrderedUnarchived() {
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
            .toSorted(orderByReply);
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

    /** @type {HTMLDialogElement | null} */
    let switcherDialog = null;
    /** @type {HTMLInputElement | null} */
    let switcherSearch = null;
    /** @type {HTMLUListElement | null} */
    let switcherList = null;
    let switcherQuery = "";

    function applySwitcherFilter() {
        if (!switcherList) return;
        const query = switcherQuery.trim().toLowerCase();
        for (const item of switcherList.children) {
            if (!(item instanceof HTMLLIElement)) continue;
            const text = (item.dataset.switcherSearchText ?? item.textContent ?? "").toLowerCase();
            item.hidden = query !== "" && !text.includes(query);
        }
    }

    /** @param {readonly WorkbenchSession[]} orderedUnarchived */
    function renderSwitcherItems(orderedUnarchived) {
        if (!switcherList) return;
        const switcherSessions = [...orderedUnarchived];
        if (selectedSessionName !== null && !switcherSessions.some(({ name }) => name === selectedSessionName)) {
            const direct = [...sessionsById.values()].find(({ name }) => name === selectedSessionName);
            if (direct) switcherSessions.push(direct);
        }
        switcherList.replaceChildren();
        const overviewHref = directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
        if (overviewHref !== null) {
            const overviewItem = /** @type {HTMLLIElement} */ ($.clone(switcherList, "#workspace-switcher-item"));
            overviewItem.dataset.switcherEntry = "overview";
            overviewItem.dataset.switcherSearchText = `overview ${currentWorkspaceName}`;
            const link = $(overviewItem, "a[data-workspace-route]");
            const lifecycleEl = $(overviewItem, "[data-lifecycle]");
            const labelEl = $(overviewItem, "[data-switcher-label]");
            lifecycleEl?.remove();
            if (link) {
                link.setAttribute("data-workspace-route", "overview");
                link.setAttribute("href", overviewHref);
                if (selectedSessionName === null) link.setAttribute("aria-current", "true");
                else link.removeAttribute("aria-current");
            }
            if (labelEl) labelEl.textContent = "Overview";
        }
        for (const session of switcherSessions) {
            const sessionHref = directoryPath({ kind: "session", workspace: currentWorkspaceName, session: session.name });
            if (sessionHref === null) continue;
            const item = /** @type {HTMLLIElement} */ ($.clone(switcherList, "#workspace-switcher-item"));
            item.dataset.switcherEntry = `${workspaceId}:${session.id}`;
            item.dataset.sessionKind = session.kind;
            item.dataset.switcherSearchText = `@${session.name} ${session.kind} ${session.lifecycle}`;
            const link = $(item, "a[data-workspace-route]");
            const lifecycleEl = $(item, "[data-lifecycle]");
            const labelEl = $(item, "[data-switcher-label]");
            if (link) {
                link.setAttribute("data-workspace-route", "session");
                link.setAttribute("href", sessionHref);
                if (session.name === selectedSessionName) link.setAttribute("aria-current", "true");
                else link.removeAttribute("aria-current");
                if (session.gates > 0) {
                    const gatesBadge = $.clone(link, "#session-gates-badge");
                    const label = `${session.gates} awaiting input`;
                    gatesBadge.setAttribute("data-session-gates", String(session.gates));
                    gatesBadge.setAttribute("aria-label", label);
                    gatesBadge.setAttribute("title", label);
                    gatesBadge.textContent = String(session.gates);
                }
            }
            if (lifecycleEl) lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
            if (labelEl) labelEl.textContent = `@${session.name}`;
        }
        applySwitcherFilter();
    }

    function reconcileTabs() {
        tabs.dataset.workspaceName = currentWorkspaceName;
        for (const input of $$('dialog#dialog-session-create form input[name="workspace"]')) {
            if (input instanceof HTMLInputElement) input.value = currentWorkspaceName;
        }
        const orderedUnarchived = computeOrderedUnarchived();
        const visible = orderedUnarchived.filter((entry) => isVisibleInTabStrip(entry, selectedSessionName));
        if (selectedSessionName !== null && !visible.some(({ name }) => name === selectedSessionName)) {
            const direct = [...sessionsById.values()].find(({ name }) => name === selectedSessionName);
            if (direct) visible.push(direct);
        }

        const overviewLink = $(tabsList, ':scope > li:first-child > a[data-workspace-route="overview"]');
        const overviewHref = directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
        if (overviewLink && overviewHref !== null) {
            if (overviewLink.getAttribute("href") !== overviewHref) overviewLink.setAttribute("href", overviewHref);
            if (selectedSessionName === null) overviewLink.setAttribute("aria-current", "true");
            else overviewLink.removeAttribute("aria-current");
        }

        for (const [index, session] of visible.entries()) {
            const sessionHref = directoryPath({ kind: "session", workspace: currentWorkspaceName, session: session.name });
            if (sessionHref === null) continue;
            let row = tabRowsById.get(session.id);
            if (!row) {
                row = /** @type {HTMLLIElement} */ ($.clone(tabsList, "#workspace-tab-item"));
                tabRowsById.set(session.id, row);
            }
            row.dataset.tabId = `${workspaceId}:${session.id}`;
            row.dataset.sessionKind = session.kind;
            if (session.parentSessionId !== null) row.dataset.parentId = String(session.parentSessionId);
            else delete row.dataset.parentId;
            if (session.replyId !== null) row.dataset.replyId = String(session.replyId);
            else delete row.dataset.replyId;
            if (session.archived) row.dataset.archived = "true";
            else delete row.dataset.archived;

            const link = $(row, 'a[data-workspace-route="session"]');
            if (link instanceof HTMLAnchorElement) {
                link.dataset.tabSession = session.name;
                if (link.getAttribute("href") !== sessionHref) link.setAttribute("href", sessionHref);
                const title = `@${session.name} (${session.lifecycle})`;
                if (link.getAttribute("title") !== title) link.setAttribute("title", title);
                if (session.name === selectedSessionName) link.setAttribute("aria-current", "true");
                else link.removeAttribute("aria-current");

                const lifecycleEl = $(link, "[data-lifecycle]");
                if (lifecycleEl && lifecycleEl.getAttribute("data-lifecycle") !== session.lifecycle) {
                    lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
                }
                const labelEl = $(link, "[data-tab-label]");
                const tabText = `@${session.name}`;
                if (labelEl && labelEl.textContent !== tabText) labelEl.textContent = tabText;

                let gatesBadge = $(link, "[data-session-gates]");
                if (session.gates > 0) {
                    gatesBadge ??= $.clone(link, "#session-gates-badge");
                    const gateLabel = `${session.gates} awaiting input`;
                    gatesBadge.setAttribute("data-session-gates", String(session.gates));
                    gatesBadge.setAttribute("aria-label", gateLabel);
                    gatesBadge.setAttribute("title", gateLabel);
                    if (gatesBadge.textContent !== String(session.gates)) gatesBadge.textContent = String(session.gates);
                } else {
                    gatesBadge?.remove();
                }
            }

            const desiredPosition = index + 1;
            if (tabsList.children[desiredPosition] !== row) {
                tabsList.insertBefore(row, tabsList.children[desiredPosition] ?? null);
            }
        }

        while (tabsList.children.length > visible.length + 1) {
            tabsList.lastElementChild?.remove();
        }

        let activeCount = 0;
        let gatedCount = 0;
        for (const entry of orderedUnarchived) {
            if (["queued", "running", "parked"].includes(entry.lifecycle)) activeCount++;
            if (entry.gates > 0) gatedCount += entry.gates;
        }
        const currentEl = $(switcherButton, "[data-switcher-current]");
        const currentText = selectedSessionName === null ? "Overview" : `@${selectedSessionName}`;
        if (currentEl && currentEl.textContent !== currentText) currentEl.textContent = currentText;

        let switcherGates = $(switcherButton, "[data-session-gates]");
        if (gatedCount > 0) {
            switcherGates ??= $.clone(switcherButton, "#session-gates-badge");
            const label = `${gatedCount} awaiting input`;
            switcherGates.setAttribute("data-session-gates", String(gatedCount));
            switcherGates.setAttribute("aria-label", label);
            if (switcherGates.textContent !== String(gatedCount)) switcherGates.textContent = String(gatedCount);
        } else {
            switcherGates?.remove();
        }

        let switcherActive = $(switcherButton, "[data-switcher-active]");
        if (activeCount > 0) {
            switcherActive ??= $.clone(switcherButton, "#workspace-switcher-active-badge");
            const label = `${activeCount} active`;
            switcherActive.setAttribute("data-switcher-active", String(activeCount));
            switcherActive.setAttribute("aria-label", label);
            if (switcherActive.textContent !== String(activeCount)) switcherActive.textContent = String(activeCount);
        } else {
            switcherActive?.remove();
        }

        if (switcherDialog?.open) {
            renderSwitcherItems(orderedUnarchived);
        }
    }

    function ensureSwitcherDialog() {
        if (switcherDialog instanceof HTMLDialogElement) return switcherDialog;
        const cloned = $.clone(document.body, "#workspace-switcher-dialog");
        if (!(cloned instanceof HTMLDialogElement)) throw new Error("Workspace switcher dialog template is invalid.");
        switcherDialog = cloned;
        switcherSearch = $(switcherDialog, "input[data-switcher-search]");
        switcherList = $(switcherDialog, "ul[data-switcher-list]");
        on(switcherDialog, "input", "input[data-switcher-search]", (_event, input) => {
            if (input instanceof HTMLInputElement) {
                switcherQuery = input.value;
                applySwitcherFilter();
            }
        });
        on(switcherDialog, "click", "a[data-workspace-route]", () => {
            switcherDialog?.close();
        });
        return switcherDialog;
    }

    function openSwitcherDialog() {
        const dialog = ensureSwitcherDialog();
        switcherQuery = "";
        if (switcherSearch) switcherSearch.value = "";
        renderSwitcherItems(computeOrderedUnarchived());
        if (!dialog.open) dialog.showModal();
        switcherSearch?.focus();
    }

    on(tabs, "click", "[data-workspace-switcher]", () => {
        openSwitcherDialog();
    });

    /** @param {string} href */
    function navigateHref(href) {
        if (live) {
            route.go(href);
        } else {
            location.assign(href);
        }
    }

    on.target(window, "keydown", (rawEvent) => {
        if (!(rawEvent instanceof KeyboardEvent) || rawEvent.defaultPrevented || rawEvent.isComposing || rawEvent.repeat) return;
        const modOnly = (rawEvent.metaKey !== rawEvent.ctrlKey) && !rawEvent.altKey && !rawEvent.shiftKey;
        if (modOnly && (rawEvent.code === "KeyK" || rawEvent.key.toLowerCase() === "k")) {
            if (switcherDialog?.open) {
                rawEvent.preventDefault();
                switcherDialog.close();
                return;
            }
            if (!$("dialog[open]")) {
                rawEvent.preventDefault();
                openSwitcherDialog();
            }
            return;
        }

        if (switcherDialog?.open) {
            if (!switcherList) return;
            const visibleLinks = /** @type {HTMLAnchorElement[]} */ ($$(switcherList, ":scope > li:not([hidden]) > a[data-workspace-route]"));
            if (rawEvent.key === "Enter" && rawEvent.target === switcherSearch) {
                const first = visibleLinks[0];
                const href = first?.getAttribute("href");
                if (href) {
                    rawEvent.preventDefault();
                    switcherDialog.close();
                    navigateHref(href);
                }
                return;
            }
            if (rawEvent.key === "ArrowDown" || rawEvent.key === "ArrowUp") {
                if (visibleLinks.length === 0) return;
                rawEvent.preventDefault();
                const currentIdx = visibleLinks.findIndex((link) => link === document.activeElement);
                if (rawEvent.key === "ArrowDown") {
                    const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % visibleLinks.length;
                    visibleLinks[nextIdx]?.focus();
                } else if (currentIdx <= 0) {
                    switcherSearch?.focus();
                } else {
                    visibleLinks[currentIdx - 1]?.focus();
                }
            }
            return;
        }

        if ($("dialog[open]")) return;

        const altOnly = rawEvent.altKey && !rawEvent.ctrlKey && !rawEvent.metaKey && !rawEvent.shiftKey;
        if (!altOnly) return;

        const digitMatch = /^Digit([1-9])$/u.exec(rawEvent.code);
        if (digitMatch) {
            const links = /** @type {HTMLAnchorElement[]} */ ($$(tabsList, ":scope > li:not([hidden]) > a[data-workspace-route]"));
            const digit = Number(digitMatch[1]);
            const targetIndex = digit === 9 && links.length > 9 ? links.length - 1 : digit - 1;
            const targetLink = links[targetIndex];
            const href = targetLink?.getAttribute("href");
            if (href) {
                rawEvent.preventDefault();
                navigateHref(href);
            }
            return;
        }

        if (rawEvent.code === "BracketLeft" || rawEvent.code === "BracketRight") {
            const links = /** @type {HTMLAnchorElement[]} */ ($$(tabsList, ":scope > li:not([hidden]) > a[data-workspace-route]"));
            if (links.length <= 1) return;
            rawEvent.preventDefault();
            const currentIndex = links.findIndex((link) => link.getAttribute("aria-current") === "true");
            const delta = rawEvent.code === "BracketRight" ? 1 : -1;
            const nextIndex = ((currentIndex < 0 ? 0 : currentIndex) + delta + links.length) % links.length;
            const href = links[nextIndex]?.getAttribute("href");
            if (href) navigateHref(href);
            return;
        }

        if (rawEvent.code === "KeyN") {
            const createDialog = $("#dialog-session-create");
            if (createDialog instanceof HTMLDialogElement) {
                rawEvent.preventDefault();
                createDialog.showModal();
                const nameInput = $(createDialog, 'input[name="name"]');
                if (nameInput instanceof HTMLInputElement) {
                    nameInput.focus();
                    nameInput.select();
                }
            }
        }
    });

    if (!live) {
        const statusFooter = $("#session-status");
        if (statusFooter instanceof HTMLElement) {
            (await import("./session.js")).default(statusFooter, { main: initialMain });
        }
        return;
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
                if (id !== workspaceId || name === null) return;
                currentWorkspaceName = name;
                knownWorkspaceNames.add(name);
                recomputeWorkspaceMarker();
                reconcileTabs();
                return;
            }
            case "session/created": {
                const id = typeof data.id === "number" ? data.id : notifSessionId;
                const wsId = typeof data.workspaceId === "number" ? data.workspaceId : notifWorkspaceId;
                if (id === null || wsId !== workspaceId || typeof data.name !== "string") return;
                if (typeof data.workspaceName === "string") {
                    currentWorkspaceName = data.workspaceName;
                    knownWorkspaceNames.add(data.workspaceName);
                }
                if (typeof data.projectRoot === "string") hasProjectRoot = true;
                else if (data.projectRoot === null) hasProjectRoot = false;
                if (typeof data.projectLabel === "string") projectLabel = data.projectLabel;
                else if (data.projectLabel === null) projectLabel = null;
                recomputeWorkspaceMarker();
                if (data.origin !== "model") return;
                const parentSessionId = typeof data.parentSessionId === "number" ? data.parentSessionId : null;
                const kind = asSessionKind(data.kind) ?? (parentSessionId === null ? "root" : "work");
                const lifecycle = typeof data.lifecycle === "string" ? data.lifecycle : "idle";
                sessionsById.set(id, {
                    id,
                    name: data.name,
                    parentSessionId,
                    kind,
                    lifecycle,
                    gates: 0,
                    replyId: null,
                    archived: false,
                });
                reconcileTabs();
                return;
            }
            case "session/archived": {
                if (notifWorkspaceId !== workspaceId) return;
                const isArchived = data.archived_at !== null && data.archived_at !== undefined;
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
                if (changed) reconcileTabs();
                return;
            }
            case "session/deleted": {
                if (notifWorkspaceId !== workspaceId) return;
                const ids = Array.isArray(data.sessionIds) ? data.sessionIds : (typeof data.id === "number" ? [data.id] : []);
                let changed = false;
                for (const sid of ids) {
                    if (typeof sid === "number" && sessionsById.delete(sid)) {
                        tabRowsById.delete(sid);
                        changed = true;
                    }
                }
                if (changed) reconcileTabs();
                return;
            }
            case "loop/proposal":
            case "loop/interaction": {
                if (notifWorkspaceId !== workspaceId || notifSessionId === null) return;
                if (event === "loop/proposal" && isRecord(data.disposition) && data.disposition.decision !== "review") return;
                const cur = sessionsById.get(notifSessionId);
                if (!cur) return;
                sessionsById.set(notifSessionId, { ...cur, lifecycle: "running", gates: cur.gates + 1 });
                reconcileTabs();
                return;
            }
            case "log/entry": {
                const entry = isRecord(data.entry) ? data.entry : null;
                if (!entry || notifWorkspaceId !== workspaceId) return;
                const sid = typeof entry.session_id === "number" ? entry.session_id : notifSessionId;
                if (sid === null) return;
                const cur = sessionsById.get(sid);
                if (!cur) return;
                let nextReplyId = cur.replyId;
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
                    if (rxCompletion !== null) nextReplyId = entry.id;
                }
                if (entry.state !== "proposed" && entry.op !== "done" && entry.op !== "fail" && entry.op !== "wait") {
                    nextLifecycle = "running";
                    if (entry.state === "resolved" && nextGates > 0) nextGates = 0;
                }
                if (nextReplyId !== cur.replyId || nextLifecycle !== cur.lifecycle || nextGates !== cur.gates) {
                    sessionsById.set(sid, { ...cur, replyId: nextReplyId, lifecycle: nextLifecycle, gates: nextGates });
                    reconcileTabs();
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
                const lifecycle = status === 200 ? "completed"
                    : status === 202 ? "parked"
                        : status === 499 ? "cancelled"
                            : status >= 400 ? "failed" : "completed";
                if (cur.lifecycle !== lifecycle || cur.gates !== 0) {
                    sessionsById.set(sid, { ...cur, lifecycle, gates: 0 });
                    reconcileTabs();
                }
                return;
            }
            default:
                return;
        }
    }

    const notifications = subscribeWorkspaceNotifications({
        auth,
        workspaceId,
        onNotification: applyNotification,
    });

    /** @type {Map<string, PaneEntry>} */
    const panesByRoute = new Map();
    /** @type {PaneEntry | null} */
    let activePane = null;
    let navSeq = 0;
    let useSeq = 0;
    const pageLifetime = new AbortController();

    on.target(window, "pagehide", (event) => {
        if (!(event instanceof PageTransitionEvent) || !event.persisted) {
            pageLifetime.abort();
        }
    });

    const initialSessionCreateDialog = $("#dialog-session-create");
    /** @type {HTMLDialogElement | null} */
    const sessionCreateBlueprint = initialSessionCreateDialog instanceof HTMLDialogElement
        ? /** @type {HTMLDialogElement} */ (initialSessionCreateDialog.cloneNode(true))
        : null;

    /** @param {number} maxCount */
    function evictOverflowSessionPanes(maxCount) {
        const sessionEntries = [...panesByRoute.values()].filter((entry) => entry.kind === "session");
        if (sessionEntries.length <= maxCount) return;
        const evictable = sessionEntries
            .filter((entry) => entry !== activePane && entry.controller.canEvict())
            .toSorted((a, b) => a.lastUsedSeq - b.lastUsedSeq);
        let remaining = sessionEntries.length;
        for (const victim of evictable) {
            if (remaining <= maxCount) break;
            victim.controller.dispose();
            panesByRoute.delete(victim.routeKey);
            remaining--;
        }
    }

    /** @param {HTMLElement} breadcrumb @param {"workspace" | "session"} kind @param {string | null} sessionName */
    function syncBreadcrumbElement(breadcrumb, kind, sessionName) {
        const workspacePath = directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
        if (kind === "workspace") {
            const markerEl = $(breadcrumb, "[data-workspace-marker], li:nth-child(2) > [role='img']");
            if (markerEl) {
                if (markerEl.textContent !== workspaceMarker.icon) markerEl.textContent = workspaceMarker.icon;
                if (markerEl.getAttribute("aria-label") !== workspaceMarker.label) markerEl.setAttribute("aria-label", workspaceMarker.label);
            }
            const nameEl = $(breadcrumb, '[aria-current="page"][data-text="name"]');
            if (nameEl && nameEl.textContent !== currentWorkspaceName) nameEl.textContent = currentWorkspaceName;
        } else if (sessionName !== null) {
            const wsSpan = $(breadcrumb, "#session-workspace");
            if (wsSpan && workspacePath !== null) {
                the(wsSpan, {
                    workspaceName: currentWorkspaceName,
                    workspacePath,
                    workspaceIcon: workspaceMarker.icon,
                    workspaceIconLabel: workspaceMarker.label,
                });
            }
            const sessionEl = $(breadcrumb, '[aria-current="page"][data-text="name"]');
            if (sessionEl && sessionEl.textContent !== sessionName) sessionEl.textContent = sessionName;
        }
    }

    /** @param {"workspace" | "session"} kind @param {string | null} sessionName */
    function mountTransitionalBreadcrumb(kind, sessionName) {
        $('header nav[aria-label="breadcrumb"]')?.remove();
        const crumb = kind === "workspace"
            ? $.clone(headerEl, "#workspace-breadcrumb-overview")
            : $.clone(headerEl, "#workspace-breadcrumb-session");
        syncBreadcrumbElement(crumb, kind, sessionName);
        return crumb;
    }

    function scrollActiveTabIntoView() {
        const currentTab = $(tabsList, 'a[aria-current="true"]');
        currentTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    const initialBreadcrumb = $('header nav[aria-label="breadcrumb"]');
    if (!(initialBreadcrumb instanceof HTMLElement)) throw new Error("Workspace breadcrumb is absent.");

    if (initialMain.dataset.page === "session") {
        const statusFooter = $("#session-status");
        if (!(statusFooter instanceof HTMLElement)) throw new Error("Session footer is absent.");
        const sessionName = statusFooter.dataset.sessionName ?? "";
        await notifications.initialAuthSettled;
        const { default: observeSession } = await import("./session.js");
        const controller = observeSession(statusFooter, { main: initialMain });
        const routeKey = `session:${sessionName}`;
        const entry = {
            routeKey,
            kind: /** @type {const} */ ("session"),
            sessionName,
            main: initialMain,
            footer: statusFooter,
            breadcrumb: initialBreadcrumb,
            controller,
            lastUsedSeq: ++useSeq,
        };
        panesByRoute.set(routeKey, entry);
        activePane = entry;
    } else if (initialMain.dataset.page === "workspace") {
        const { default: observeOverview } = await import("./overview.js");
        const controller = observeOverview(initialMain);
        const routeKey = "overview";
        const entry = {
            routeKey,
            kind: /** @type {const} */ ("workspace"),
            sessionName: null,
            main: initialMain,
            footer: null,
            breadcrumb: initialBreadcrumb,
            controller,
            lastUsedSeq: ++useSeq,
        };
        panesByRoute.set(routeKey, entry);
        activePane = entry;
    }

    /** @param {string} pathname */
    function handleRouteChange(pathname) {
        if (switcherDialog?.open) switcherDialog.close();
        const dir = parseDirectory(pathname);
        if (!dir || dir.kind === "daemon" || !knownWorkspaceNames.has(dir.workspace)) {
            location.assign(location.href);
            return;
        }
        const routeKey = dir.kind === "workspace" ? "overview" : `session:${dir.session}`;
        const cached = panesByRoute.get(routeKey);
        if (!cached && dir.workspace !== currentWorkspaceName) {
            location.assign(location.href);
            return;
        }

        const seq = ++navSeq;
        selectedSessionName = dir.kind === "session" ? dir.session : null;

        if (cached) {
            cached.lastUsedSeq = ++useSeq;
            if (activePane !== cached) {
                if (activePane) {
                    activePane.controller.deactivate();
                    activePane.main.remove();
                    activePane.footer?.remove();
                } else {
                    $("#main")?.remove();
                    $("#session-status")?.remove();
                }
                syncBreadcrumbElement(cached.breadcrumb, cached.kind, cached.sessionName);
                const currentCrumb = $('header nav[aria-label="breadcrumb"]');
                if (currentCrumb && currentCrumb !== cached.breadcrumb) {
                    currentCrumb.replaceWith(cached.breadcrumb);
                } else if (!currentCrumb) {
                    headerEl.append(cached.breadcrumb);
                }
                tabs.insertAdjacentElement("afterend", cached.main);
                if (cached.footer) cached.main.insertAdjacentElement("afterend", cached.footer);
                activePane = cached;
                the("page-title", cached.kind === "workspace"
                    ? `${currentWorkspaceName} — Plurnk`
                    : `${currentWorkspaceName}@${cached.sessionName} — Plurnk`);
                cached.controller.activate();
            }
            reconcileTabs();
            scrollActiveTabIntoView();
            return;
        }

        if (activePane) {
            activePane.controller.deactivate();
            activePane.main.remove();
            activePane.footer?.remove();
            activePane = null;
        } else {
            $("#main")?.remove();
            $("#session-status")?.remove();
        }

        const transitionalMain = $.clone(tabs, "#workspace-transitional-main", { position: "afterend" });
        transitionalMain.dataset.page = dir.kind;
        if (sessionCreateBlueprint) {
            const createClone = /** @type {HTMLDialogElement} */ (sessionCreateBlueprint.cloneNode(true));
            const wsInput = $(createClone, 'input[name="workspace"]');
            if (wsInput instanceof HTMLInputElement) wsInput.value = currentWorkspaceName;
            transitionalMain.append(createClone);
        }
        mountTransitionalBreadcrumb(dir.kind, dir.kind === "session" ? dir.session : null);
        the("page-title", dir.kind === "workspace"
            ? `${currentWorkspaceName} — Plurnk`
            : `${currentWorkspaceName}@${dir.session} — Plurnk`);
        reconcileTabs();
        scrollActiveTabIntoView();

        const fetchPath = directoryPath(dir.kind === "workspace"
            ? { kind: "workspace", workspace: currentWorkspaceName }
            : { kind: "session", workspace: currentWorkspaceName, session: dir.session });
        if (fetchPath === null) {
            location.assign(location.href);
            return;
        }

        void (async () => {
            try {
                const response = await fetch(fetchPath, {
                    headers: { accept: "text/html" },
                    cache: "no-store",
                    signal: pageLifetime.signal,
                });
                if (seq !== navSeq || pageLifetime.signal.aborted) return;
                if (!response.ok || response.redirected) {
                    location.assign(fetchPath);
                    return;
                }
                const html = await response.text();
                if (seq !== navSeq || pageLifetime.signal.aborted) return;
                const parsed = new DOMParser().parseFromString(html, "text/html");
                const fetchedMain = $(parsed, "#main");
                const fetchedFooter = $(parsed, "#session-status");
                const fetchedBreadcrumb = $(parsed, 'header nav[aria-label="breadcrumb"]');
                if (!(fetchedMain instanceof HTMLElement) || !(fetchedBreadcrumb instanceof HTMLElement)) {
                    location.assign(fetchPath);
                    return;
                }
                if (dir.kind === "session" && !(fetchedFooter instanceof HTMLElement)) {
                    location.assign(fetchPath);
                    return;
                }

                const nextMain = /** @type {HTMLElement} */ (document.adoptNode(fetchedMain));
                const nextFooter = fetchedFooter instanceof HTMLElement
                    ? /** @type {HTMLElement} */ (document.adoptNode(fetchedFooter))
                    : null;
                const nextBreadcrumb = /** @type {HTMLElement} */ (document.adoptNode(fetchedBreadcrumb));

                if (dir.kind === "session") {
                    evictOverflowSessionPanes(MAX_CONNECTED_SESSION_PANES - 1);
                    await notifications.initialAuthSettled;
                    if (seq !== navSeq || pageLifetime.signal.aborted) return;
                }

                $("#main")?.remove();
                $("#session-status")?.remove();
                const currentCrumb = $('header nav[aria-label="breadcrumb"]');
                if (currentCrumb) currentCrumb.replaceWith(nextBreadcrumb);
                else headerEl.append(nextBreadcrumb);
                tabs.insertAdjacentElement("afterend", nextMain);
                if (nextFooter) nextMain.insertAdjacentElement("afterend", nextFooter);

                if (dir.kind === "workspace") {
                    hydrateSessionsFromOverview(nextMain);
                    const { default: observeOverview } = await import("./overview.js");
                    if (seq !== navSeq || pageLifetime.signal.aborted) return;
                    const controller = observeOverview(nextMain);
                    const entry = {
                        routeKey,
                        kind: /** @type {const} */ ("workspace"),
                        sessionName: null,
                        main: nextMain,
                        footer: null,
                        breadcrumb: nextBreadcrumb,
                        controller,
                        lastUsedSeq: ++useSeq,
                    };
                    panesByRoute.set(routeKey, entry);
                    activePane = entry;
                } else {
                    if (!nextFooter) return;
                    const { default: observeSession } = await import("./session.js");
                    if (seq !== navSeq || pageLifetime.signal.aborted) return;
                    const controller = observeSession(nextFooter, { main: nextMain });
                    const entry = {
                        routeKey,
                        kind: /** @type {const} */ ("session"),
                        sessionName: dir.session,
                        main: nextMain,
                        footer: nextFooter,
                        breadcrumb: nextBreadcrumb,
                        controller,
                        lastUsedSeq: ++useSeq,
                    };
                    panesByRoute.set(routeKey, entry);
                    activePane = entry;
                }
                reconcileTabs();
            } catch {
                if (seq !== navSeq || pageLifetime.signal.aborted) return;
                location.assign(fetchPath);
            }
        })();
    }

    route(handleRouteChange, { match: INTRA_WORKSPACE_LINK, initial: false });
}
