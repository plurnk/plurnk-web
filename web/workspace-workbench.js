import { $, $$, on, the } from "on_the_money";
import { directoryPath, nextSequentialName, parseDirectory, parseSessionHash, workspaceSettingsPath } from "../src/directory-addresses.js";
import { allowWorkspaceCreation } from "./endpoints.js";
import renderInPageError from "./error-view.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import { hasActiveOidcGrant, onOidcGrantChange } from "./oidc.js";
import { isUntouchedDraftSession, orderByReply } from "./session-selection.js";
import { parseWorkspaceList, renderWorkspacesDialog, wireWorkspaceCreateDialog } from "./workspace-dialogs.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";

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

/**
 * @typedef {{
 *   deactivate(): void,
 *   activate(): void,
 *   dispose(): void,
 * }} PaneController
 */

/**
 * @typedef {{
 *   readonly sessionName: string,
 *   readonly main: HTMLElement,
 *   readonly footer: HTMLElement,
 *   readonly controller: PaneController,
 * }} PaneEntry
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {"root" | "work" | "fork" | null} */
const asSessionKind = (value) => value === "root" || value === "work" || value === "fork" ? value : null;

/** @param {WorkbenchSession} session @param {boolean} hasModelChildren */
function isUntouchedDraftWorkbenchSession(session, hasModelChildren) {
    return session.parentSessionId === null
        && session.kind === "root"
        && session.lifecycle === "idle"
        && session.replyId === null
        && !(typeof session.title === "string" && session.title.trim() !== "")
        && session.gates === 0
        && !hasModelChildren;
}

/** @param {WorkbenchSession} session @param {string | null} selectedSession @param {boolean} isDraft */
function isVisibleInTabStrip(session, selectedSession, isDraft) {
    if (session.name === selectedSession) return true;
    if (session.archived || isDraft) return false;
    if (session.parentSessionId === null || session.kind === "root" || session.kind === "fork") return true;
    return ["queued", "running", "parked", "failed"].includes(session.lifecycle) || session.gates > 0;
}

/**
 * {§web-directory-documents} {§web-workspace-tabs} {§web-session-creation} Unified browser-style session tab strip,
 * `#<session>` hash routing, quick-switcher modal, and resident WebSocket `/acp` panes.
 * @param {HTMLElement} tabs
 */
export default async function observeWorkspaceWorkbench(tabs) {
    const rawTabsList = $(tabs, ":scope > ul");
    const initialMain = $("#main");
    if (!(rawTabsList instanceof HTMLUListElement) || !(initialMain instanceof HTMLElement)) {
        throw new Error("Workspace workbench shell is incomplete.");
    }
    const tabsList = rawTabsList;

    for (const dialog of $$(initialMain, ":scope > dialog")) {
        document.body.append(dialog);
    }

    const pageLifetime = new AbortController();
    on.target(window, "pagehide", (event) => {
        if (!(event instanceof PageTransitionEvent) || !event.persisted) {
            pageLifetime.abort();
        }
    });

    const preseededWorkspaceId = tabs.dataset.workspaceId ?? "";
    const isPreseededFixture = /^[1-9]\d*$/u.test(preseededWorkspaceId) && tabs.dataset.live !== "true";
    let workspaceId = isPreseededFixture ? Number(preseededWorkspaceId) : 0;
    const live = !isPreseededFixture;
    let currentWorkspaceName = initialMain.dataset.requestedWorkspace
        ?? tabs.dataset.workspaceName
        ?? (workspaceId > 0 ? String(workspaceId) : "");

    /** @type {Set<string>} */
    const knownWorkspaceNames = new Set(currentWorkspaceName ? [currentWorkspaceName] : []);
    /** @type {Set<string>} */
    const suggestionWorkspaces = new Set(currentWorkspaceName ? [currentWorkspaceName] : []);
    for (const link of $$("#dialog-workspaces [data-workspaces-list] > li > a[href]")) {
        const dir = parseDirectory(link.getAttribute("href") ?? "");
        if (dir && "workspace" in dir) suggestionWorkspaces.add(dir.workspace);
    }

    /** @returns {{ icon: string, label: string }} */
    function readWorkspaceMarker() {
        const sessionMarker = $('#session-workspace > [role="img"]');
        if (sessionMarker) {
            return {
                icon: sessionMarker.textContent ?? "☁️",
                label: sessionMarker.getAttribute("aria-label") ?? "Folderless workspace",
            };
        }
        return { icon: "☁️", label: "Folderless workspace" };
    }

    let workspaceMarker = readWorkspaceMarker();
    /** @type {boolean | null} */
    let hasProjectRoot = workspaceMarker.icon === "🗂️" ? true : null;
    /** @type {string | null} */
    let projectLabel = $(initialMain, "#session-folder")?.getAttribute("data-project-label")
        || (workspaceMarker.icon === "🗂️" ? currentWorkspaceName : null);
    if (projectLabel !== null && projectLabel !== "") hasProjectRoot = true;

    function recomputeWorkspaceMarker() {
        if (hasProjectRoot === true || (projectLabel !== null && projectLabel !== "")) {
            workspaceMarker = { icon: "🗂️", label: "Project workspace" };
        } else {
            workspaceMarker = { icon: "☁️", label: "Folderless workspace" };
        }
    }

    const serverSessionName = $("#session-status")?.getAttribute("data-session-name")
        ?? initialMain.dataset.sessionName
        ?? null;
    /** @type {string | null} */
    let selectedSessionName = serverSessionName;

    /** @type {Map<number, WorkbenchSession>} */
    const sessionsById = new Map();
    /** @type {Map<number, HTMLLIElement>} */
    const tabRowsById = new Map();

    /** @param {ParentNode} listRoot @param {boolean} [bindDomRows] */
    function hydrateSessionsFromTabList(listRoot, bindDomRows = false) {
        for (const item of $$(listRoot, ":scope > li[data-tab-id]")) {
            if (!(item instanceof HTMLLIElement)) continue;
            const idMatch = /^(\d+):(\d+)$/u.exec(item.dataset.tabId ?? "");
            if (!idMatch) continue;
            const id = Number(idMatch[2]);
            if (bindDomRows) tabRowsById.set(id, item);
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

    /** @param {string | undefined} rawFolded */
    function hydrateFoldedSessions(rawFolded) {
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

    if (isPreseededFixture) {
        hydrateSessionsFromTabList(tabsList, true);
        hydrateFoldedSessions(tabs.dataset.foldedSessions);
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

    function syncHeaderPlace() {
        const wsControl = $("#session-workspace");
        const workspacePath = directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
        const settingsPath = workspaceSettingsPath(currentWorkspaceName, selectedSessionName);
        if (wsControl && workspacePath !== null) {
            the(wsControl, {
                "workspace-name": currentWorkspaceName,
                "workspace-path": workspacePath,
                ...(settingsPath !== null ? { "workspace-settings-path": settingsPath } : {}),
                "workspace-icon": workspaceMarker.icon,
                "workspace-icon-label": workspaceMarker.label,
            });
        }
        const folderLabel = projectLabel !== null && projectLabel !== currentWorkspaceName ? projectLabel : "";
        const currentFolderEl = $("#main #session-folder");
        if (currentFolderEl instanceof HTMLElement) {
            currentFolderEl.dataset.projectLabel = folderLabel;
            the(currentFolderEl, "project-label", folderLabel);
        }
        if (selectedSessionName !== null) {
            the("page-title", `${currentWorkspaceName}#${selectedSessionName} — Plurnk`);
            for (const el of $$('[data-text="active-session-name"]')) {
                if (el.textContent !== selectedSessionName) el.textContent = selectedSessionName;
            }
            for (const input of $$('input[name="session"]')) {
                if (input instanceof HTMLInputElement && input.type === "hidden" && !input.closest("[data-inline-unarchive]")) {
                    input.value = selectedSessionName;
                }
            }
        } else {
            the("page-title", `${currentWorkspaceName} — Plurnk`);
        }
        for (const input of $$('input[name="workspace"]')) {
            if (input instanceof HTMLInputElement && input.type === "hidden" && !input.closest("[data-inline-unarchive]")) {
                input.value = currentWorkspaceName;
            }
        }
    }

    /** @type {HTMLDialogElement | null} */
    let switcherDialog = null;
    /** @type {HTMLInputElement | null} */
    let switcherSearch = null;
    /** @type {HTMLUListElement | null} */
    let switcherList = null;
    /** @type {HTMLDetailsElement | null} */
    let switcherArchivedDetails = null;
    /** @type {HTMLUListElement | null} */
    let switcherArchivedList = null;
    let switcherQuery = "";

    function applySwitcherFilter() {
        const query = switcherQuery.trim().toLowerCase();
        if (switcherList) {
            for (const item of switcherList.children) {
                if (!(item instanceof HTMLLIElement)) continue;
                const text = (item.dataset.switcherSearchText ?? item.textContent ?? "").toLowerCase();
                item.hidden = query !== "" && !text.includes(query);
            }
        }
        if (switcherArchivedList && switcherArchivedDetails) {
            let shownArchived = 0;
            for (const item of switcherArchivedList.children) {
                if (!(item instanceof HTMLLIElement)) continue;
                const text = (item.dataset.switcherSearchText ?? item.textContent ?? "").toLowerCase();
                const matches = query === "" || text.includes(query);
                item.hidden = !matches;
                if (matches) shownArchived += 1;
            }
            if (query !== "" && shownArchived > 0) switcherArchivedDetails.open = true;
        }
    }

    /** @param {readonly WorkbenchSession[]} orderedUnarchived */
    function renderSwitcherItems(orderedUnarchived) {
        if (!switcherList) return;
        const childParents = new Set(orderedUnarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
        const switcherSessions = orderedUnarchived.filter((entry) =>
            entry.name === selectedSessionName || !isUntouchedDraftWorkbenchSession(entry, childParents.has(entry.id)));
        if (selectedSessionName !== null && !switcherSessions.some(({ name }) => name === selectedSessionName)) {
            const direct = [...sessionsById.values()].find(({ name }) => name === selectedSessionName);
            if (direct) switcherSessions.push(direct);
        }
        switcherList.replaceChildren();
        for (const session of switcherSessions) {
            const item = /** @type {HTMLLIElement} */ ($.clone(switcherList, "#workspace-switcher-item"));
            const titleText = typeof session.title === "string" && session.title.trim() !== "" ? session.title.trim() : null;
            item.dataset.switcherEntry = `${workspaceId}:${session.id}`;
            item.dataset.sessionKind = session.kind;
            item.dataset.switcherSearchText = `#${session.name} ${session.name} ${titleText ?? ""} ${session.kind} ${session.lifecycle}`;
            const link = $(item, "a[data-workspace-route]");
            const lifecycleEl = $(item, "[data-lifecycle]");
            const labelEl = $(item, "[data-switcher-label]");
            if (link) {
                link.setAttribute("data-workspace-route", "session");
                link.setAttribute("data-tab-session", session.name);
                link.setAttribute("href", `#${encodeURIComponent(session.name)}`);
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
            if (labelEl) labelEl.textContent = titleText ? `${titleText} (#${session.name})` : `#${session.name}`;
        }

        if (switcherArchivedDetails && switcherArchivedList) {
            const archivedSessions = [...sessionsById.values()]
                .filter(({ archived }) => archived)
                .toSorted((a, b) => b.id - a.id);
            switcherArchivedList.replaceChildren();
            if (archivedSessions.length === 0) {
                switcherArchivedDetails.hidden = true;
                the(switcherArchivedDetails, "archived-session-count", 0);
            } else {
                switcherArchivedDetails.hidden = false;
                the(switcherArchivedDetails, "archived-session-count", archivedSessions.length);
                for (const session of archivedSessions) {
                    const item = /** @type {HTMLLIElement} */ ($.clone(switcherArchivedList, "#workspace-switcher-archived-item"));
                    const titleText = typeof session.title === "string" && session.title.trim() !== "" ? session.title.trim() : null;
                    item.dataset.switcherArchivedEntry = `${workspaceId}:${session.id}`;
                    item.dataset.switcherSearchText = `#${session.name} ${session.name} ${titleText ?? ""} archived`;
                    const labelEl = $(item, "[data-switcher-archived-label]");
                    if (labelEl) labelEl.textContent = titleText ? `${titleText} (#${session.name})` : `#${session.name}`;
                    const wsInput = $(item, 'input[name="workspace"]');
                    if (wsInput instanceof HTMLInputElement) wsInput.value = currentWorkspaceName;
                    const sessInput = $(item, 'input[name="session"]');
                    if (sessInput instanceof HTMLInputElement) sessInput.value = session.name;
                }
            }
        }
        applySwitcherFilter();
    }

    function reconcileTabs() {
        tabs.dataset.workspaceName = currentWorkspaceName;
        syncHeaderPlace();

        const orderedUnarchived = computeOrderedUnarchived();
        const childParents = new Set(orderedUnarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
        const visible = orderedUnarchived.filter((entry) =>
            isVisibleInTabStrip(entry, selectedSessionName, isUntouchedDraftWorkbenchSession(entry, childParents.has(entry.id))));
        if (selectedSessionName !== null && !visible.some(({ name }) => name === selectedSessionName)) {
            const direct = [...sessionsById.values()].find(({ name }) => name === selectedSessionName);
            if (direct) visible.push(direct);
        }

        for (const [index, session] of visible.entries()) {
            const sessionHash = `#${encodeURIComponent(session.name)}`;
            let row = tabRowsById.get(session.id);
            if (!row) {
                row = /** @type {HTMLLIElement} */ ($.clone(tabsList, "#workspace-tab-item"));
                tabRowsById.set(session.id, row);
            }
            const isDraft = isUntouchedDraftWorkbenchSession(session, childParents.has(session.id));
            const titleText = typeof session.title === "string" && session.title.trim() !== "" ? session.title.trim() : null;
            row.dataset.tabId = `${workspaceId}:${session.id}`;
            row.dataset.sessionKind = session.kind;
            if (isDraft) row.dataset.tabDraft = "true";
            else delete row.dataset.tabDraft;
            if (titleText !== null) row.dataset.sessionTitle = titleText;
            else delete row.dataset.sessionTitle;
            if (session.parentSessionId !== null) row.dataset.parentId = String(session.parentSessionId);
            else delete row.dataset.parentId;
            if (session.replyId !== null) row.dataset.replyId = String(session.replyId);
            else delete row.dataset.replyId;
            if (session.archived) row.dataset.archived = "true";
            else delete row.dataset.archived;

            const link = $(row, 'a[data-workspace-route="session"]');
            if (link instanceof HTMLAnchorElement) {
                link.dataset.tabSession = session.name;
                const nextHref = session.name === selectedSessionName
                    ? (workspaceSettingsPath(currentWorkspaceName, session.name, "session") ?? sessionHash)
                    : sessionHash;
                if (link.getAttribute("href") !== nextHref) link.setAttribute("href", nextHref);
                const hoverTitle = titleText !== null
                    ? `${titleText} (#${session.name} · ${session.lifecycle})`
                    : `#${session.name} (${session.lifecycle})`;
                if (link.getAttribute("title") !== hoverTitle) link.setAttribute("title", hoverTitle);
                if (session.name === selectedSessionName) link.setAttribute("aria-current", "true");
                else link.removeAttribute("aria-current");

                const lifecycleEl = $(link, "[data-lifecycle]");
                if (lifecycleEl && lifecycleEl.getAttribute("data-lifecycle") !== session.lifecycle) {
                    lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
                }
                const labelEl = $(link, "[data-tab-label]");
                const tabText = titleText ?? `#${session.name}`;
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

            if (tabsList.children[index] !== row) {
                tabsList.insertBefore(row, tabsList.children[index] ?? null);
            }
        }

        while (tabsList.children.length > visible.length) {
            tabsList.lastElementChild?.remove();
        }

        tabs.dataset.tabCount = String(visible.length);

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
        const rawArchivedDetails = $(switcherDialog, "details[data-switcher-archived]");
        switcherArchivedDetails = rawArchivedDetails instanceof HTMLDetailsElement ? rawArchivedDetails : null;
        const rawArchivedList = $(switcherDialog, "ul[data-switcher-archived-list]");
        switcherArchivedList = rawArchivedList instanceof HTMLUListElement ? rawArchivedList : null;
        const newSessBtn = $(switcherDialog, "button[data-switcher-new-session]");
        if (newSessBtn instanceof HTMLButtonElement && tabs.dataset.workspaceArchived === "true") {
            newSessBtn.hidden = true;
        }
        on(switcherDialog, "input", "input[data-switcher-search]", (_event, input) => {
            if (input instanceof HTMLInputElement) {
                switcherQuery = input.value;
                applySwitcherFilter();
            }
        });
        on(switcherDialog, "click", "a[data-workspace-route]", (event, link) => {
            event.preventDefault();
            const target = link.getAttribute("data-tab-session") ?? parseSessionHash(link.getAttribute("href") ?? "");
            switcherDialog?.close();
            if (target) void selectSession(target, { updateHistory: "push" });
        });
        on(switcherDialog, "click", "[data-switcher-new-session]", () => {
            switcherDialog?.close();
            openSessionCreateDialog();
        });
        return switcherDialog;
    }

    function openSwitcherDialog() {
        const dialog = ensureSwitcherDialog();
        const newSessBtn = $(dialog, "button[data-switcher-new-session]");
        if (newSessBtn instanceof HTMLButtonElement) {
            newSessBtn.hidden = tabs.dataset.workspaceArchived === "true";
        }
        switcherQuery = "";
        if (switcherSearch) switcherSearch.value = "";
        renderSwitcherItems(computeOrderedUnarchived());
        if (!dialog.open) dialog.showModal();
        switcherSearch?.focus();
    }

    /** @type {Map<string, PaneEntry>} */
    const panesBySession = new Map();
    /** @type {PaneEntry | null} */
    let activePane = null;

    const offGrantChange = onOidcGrantChange(() => {
        if (hasActiveOidcGrant()) return;
        for (const [sessionName, pane] of panesBySession) {
            if (pane !== activePane) {
                pane.controller.dispose();
                panesBySession.delete(sessionName);
            }
        }
    });
    on.target(pageLifetime.signal, "abort", offGrantChange);

    wireWorkspaceCreateDialog({
        signal: pageLifetime.signal,
        getKnownWorkspaceNames: () => suggestionWorkspaces,
    });

    /** @param {string} targetPath */
    function navigateHref(targetPath) {
        if (targetPath.startsWith("#")) {
            const targetSession = parseSessionHash(targetPath);
            if (targetSession) {
                void selectSession(targetSession, { updateHistory: "push" });
            }
            return;
        }
        const dir = parseDirectory(targetPath);
        if (dir && dir.kind === "session" && (dir.workspace === currentWorkspaceName || knownWorkspaceNames.has(dir.workspace))) {
            if (dir.workspace !== currentWorkspaceName) {
                currentWorkspaceName = dir.workspace;
                knownWorkspaceNames.add(dir.workspace);
                recomputeWorkspaceMarker();
            }
            const nextUrl = directoryPath({ kind: "session", workspace: currentWorkspaceName, session: dir.session });
            if (nextUrl && location.pathname !== nextUrl.split("#", 1)[0]) {
                history.replaceState(null, "", nextUrl);
            }
            void selectSession(dir.session, { updateHistory: "push" });
            return;
        }
        location.assign(targetPath);
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
                const target = first?.dataset.tabSession ?? parseSessionHash(first?.getAttribute("href") ?? "");
                if (target) {
                    rawEvent.preventDefault();
                    switcherDialog.close();
                    void selectSession(target, { updateHistory: "push" });
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
            const target = targetLink?.dataset.tabSession;
            if (target) {
                rawEvent.preventDefault();
                void selectSession(target, { updateHistory: "push" });
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
            const target = links[nextIndex]?.dataset.tabSession;
            if (target) void selectSession(target, { updateHistory: "push" });
            return;
        }

        if (rawEvent.code === "KeyN") {
            if (openSessionCreateDialog()) {
                rawEvent.preventDefault();
            }
        }
    });

    on(document.body, "click", "[data-open-sessions]", () => {
        openSwitcherDialog();
    });

    function openSessionCreateDialog() {
        if (tabs.dataset.workspaceArchived === "true") return false;
        const createDialog = $("#dialog-session-create");
        if (!(createDialog instanceof HTMLDialogElement)) return false;
        if (switcherDialog?.open) switcherDialog.close();
        syncHeaderPlace();
        the(createDialog, "session-create-error", "");
        const nameInput = $(createDialog, 'input[name="name"]');
        const titleInput = $(createDialog, 'input[name="title"]');
        if (nameInput instanceof HTMLInputElement) nameInput.value = "";
        if (titleInput instanceof HTMLInputElement) titleInput.value = "";
        if (!createDialog.open) createDialog.showModal();
        if (nameInput instanceof HTMLInputElement) {
            nameInput.focus();
        }
        return true;
    }

    let newSessionBusy = false;
    /**
     * @param {"push" | "replace"} historyMode
     * @param {{ name?: string, title?: string }} [requested]
     */
    async function openFreshSequentialSession(historyMode, requested = {}) {
        if (newSessionBusy) return false;
        newSessionBusy = true;
        try {
            const explicitName = (requested.name ?? "").trim();
            const explicitTitle = (requested.title ?? "").trim();
            /** @type {unknown} */
            let created;
            if (explicitName) {
                const existingSessions = await managementAction("workspace.sessions", {
                    workspace: currentWorkspaceName,
                    includeArchived: true,
                }, "", pageLifetime.signal, { workspace: currentWorkspaceName });
                const rows = isRecord(existingSessions) && Array.isArray(existingSessions.sessions) ? existingSessions.sessions : [];
                if (rows.some((row) => isRecord(row) && row.name === explicitName)) {
                    throw Object.assign(new Error(`Session '${explicitName}' is already in use in workspace '${currentWorkspaceName}'.`), { status: 409 });
                }
                created = await managementAction("session/new", {
                    _meta: { plurnk: { workspace: currentWorkspaceName, sessionName: explicitName } },
                }, "", pageLifetime.signal);
            } else {
                const seen = new Set([...sessionsById.values()].map(({ name }) => name));
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    const candidate = nextSequentialName("session", seen);
                    try {
                        created = await managementAction("session/new", {
                            _meta: { plurnk: { workspace: currentWorkspaceName, sessionName: candidate } },
                        }, "", pageLifetime.signal);
                        break;
                    } catch (error) {
                        if (Reflect.get(Object(error), "status") === 409 && attempt < 7) {
                            seen.add(candidate);
                            continue;
                        }
                        throw error;
                    }
                }
            }
            const rawSessionId = isRecord(created) && typeof created.sessionId === "string" ? created.sessionId : "";
            const freshName = rawSessionId.includes("#") ? (rawSessionId.split("#")[1] ?? "") : explicitName;
            if (freshName) {
                if (explicitTitle) {
                    await managementAction(
                        "session/set_title",
                        { title: explicitTitle },
                        `${workspaceId}#${freshName}`,
                        pageLifetime.signal,
                    );
                }
                const existingEntry = [...sessionsById.values()].find(({ name }) => name === freshName);
                if (!existingEntry) {
                    const maxId = Math.max(0, ...sessionsById.keys());
                    sessionsById.set(maxId + 1, {
                        id: maxId + 1,
                        name: freshName,
                        parentSessionId: null,
                        kind: "root",
                        lifecycle: "idle",
                        gates: 0,
                        title: explicitTitle || null,
                        replyId: null,
                        archived: false,
                    });
                } else if (explicitTitle) {
                    sessionsById.set(existingEntry.id, { ...existingEntry, title: explicitTitle });
                }
                await selectSession(freshName, { updateHistory: historyMode });
                return true;
            }
            location.assign(directoryPath({ kind: "workspace", workspace: currentWorkspaceName }) ?? "/");
            return true;
        } finally {
            newSessionBusy = false;
        }
    }

    on(document.body, "click", '[data-action="new-session"]', (event) => {
        if (openSessionCreateDialog()) {
            event.preventDefault();
        }
    });

    on(document.body, "submit", "form#session-create", (event, form) => {
        if (!live || !(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        if (newSessionBusy) return;
        const data = new FormData(form);
        const rawName = String(data.get("name") ?? "").trim();
        const rawTitle = String(data.get("title") ?? "").trim();
        const createDialog = $("#dialog-session-create");
        if (createDialog instanceof HTMLElement) the(createDialog, "session-create-error", "");
        void (async () => {
            try {
                const ok = await openFreshSequentialSession("push", { name: rawName, title: rawTitle });
                if (ok && createDialog instanceof HTMLDialogElement && createDialog.open) {
                    createDialog.close();
                }
            } catch (error) {
                const { message, recovery } = await describeFailure(error);
                if (createDialog instanceof HTMLElement) {
                    the(createDialog, "session-create-error", [message, recovery].filter(Boolean).join(" "));
                }
            }
        })();
    });

    let unarchiveMutationBusy = false;
    on(document.body, "submit", 'form[data-inline-unarchive="session"]', (event, form) => {
        if (!live || !(form instanceof HTMLFormElement) || !form.closest("#dialog-workspace-switcher")) return;
        event.preventDefault();
        if (unarchiveMutationBusy) return;
        const targetSession = String(new FormData(form).get("session") ?? "").trim();
        if (!targetSession) return;
        unarchiveMutationBusy = true;
        void (async () => {
            try {
                await managementAction("session/unarchive", {}, `${workspaceId}#${targetSession}`, pageLifetime.signal);
                for (const [sid, cur] of sessionsById) {
                    if (cur.name === targetSession || (cur.archived && cur.parentName === targetSession)) {
                        sessionsById.set(sid, { ...cur, archived: false });
                    }
                }
                if (switcherDialog?.open) switcherDialog.close();
                await selectSession(targetSession, { updateHistory: "push" });
            } catch {
                location.assign(directoryPath({ kind: "workspace", workspace: currentWorkspaceName }) ?? "/search/?status=archived");
            } finally {
                unarchiveMutationBusy = false;
            }
        })();
    });

    on(document.body, "click", 'a[data-workspace-route="session"], main a[data-session-name], #session-descendants a', (event, link) => {
        if (!(link instanceof HTMLAnchorElement)) return;
        if (event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
        const rawHref = link.getAttribute("href") ?? "";
        if (link.closest("#workspace-tabs") && link.dataset.tabSession === selectedSessionName) {
            return;
        }
        if (rawHref.startsWith("#")) {
            const target = link.dataset.tabSession ?? parseSessionHash(rawHref);
            if (target) {
                event.preventDefault();
                const openDialog = link.closest("dialog");
                if (openDialog instanceof HTMLDialogElement && openDialog.open) openDialog.close();
                void selectSession(target, { updateHistory: "push" });
            }
            return;
        }
        const dir = parseDirectory(rawHref);
        if (dir && dir.kind === "session" && knownWorkspaceNames.has(dir.workspace)) {
            event.preventDefault();
            const openDialog = link.closest("dialog");
            if (openDialog instanceof HTMLDialogElement && openDialog.open) openDialog.close();
            void selectSession(dir.session, { updateHistory: "push" });
        }
    });

    /** @type {Promise<typeof import("./session.js")["default"]> | null} */
    let observeSessionPromise = null;
    const getObserveSession = () => {
        observeSessionPromise ??= import("./session.js").then((mod) => mod.default);
        return observeSessionPromise;
    };

    function scrollActiveTabIntoView() {
        const currentTab = $(tabsList, 'a[aria-current="true"]');
        currentTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    const getWorkbenchSnapshot = () => ({
        workspaces: [...suggestionWorkspaces],
        sessions: computeOrderedUnarchived().map(({ name }) => name),
        projectRoot: hasProjectRoot === true ? (projectLabel ?? currentWorkspaceName) : null,
    });

    /** @param {string} sessionName @returns {Promise<PaneEntry>} */
    async function createSessionPane(sessionName) {
        const observeSession = await getObserveSession();
        const folderLabel = projectLabel !== null && projectLabel !== currentWorkspaceName ? projectLabel : "";
        const sessionPath = directoryPath({ kind: "session", workspace: currentWorkspaceName, session: sessionName })
            ?? `/~/${encodeURIComponent(currentWorkspaceName)}#${encodeURIComponent(sessionName)}`;

        const nextMain = /** @type {HTMLElement} */ ($.clone(tabs, "#workspace-session-main", { position: "beforebegin" }));
        nextMain.dataset.sessionName = sessionName;
        const folderEl = $(nextMain, "#session-folder");
        if (folderEl instanceof HTMLElement) {
            folderEl.dataset.projectLabel = folderLabel;
            the(folderEl, "project-label", folderLabel);
        }
        const connEl = $(nextMain, "#session-connection");
        if (connEl) {
            the(connEl, { "session-path": sessionPath });
        }

        const nextFooter = /** @type {HTMLElement} */ ($.clone(nextMain, "#workspace-session-footer", { position: "afterend" }));
        nextFooter.dataset.workspaceId = String(workspaceId);
        nextFooter.dataset.sessionId = `${workspaceId}#${sessionName}`;
        nextFooter.dataset.sessionName = sessionName;
        the(nextFooter, {
            "session-name": sessionName,
            "session-settings-path": workspaceSettingsPath(currentWorkspaceName, sessionName, "session") ?? sessionPath,
        });

        const controller = observeSession(nextFooter, {
            main: nextMain,
            transport: live ? "ws" : "http",
            onNavigate: navigateHref,
            getWorkbenchSnapshot,
        });
        const entry = {
            sessionName,
            main: nextMain,
            footer: nextFooter,
            controller,
        };
        panesBySession.set(sessionName, entry);
        return entry;
    }

    let selectSeq = 0;

    /**
     * @param {string} sessionName
     * @param {{ updateHistory: "push" | "replace" | "none" }} options
     */
    async function selectSession(sessionName, { updateHistory }) {
        if (switcherDialog?.open) switcherDialog.close();
        const seq = ++selectSeq;
        selectedSessionName = sessionName;

        const targetHash = `#${encodeURIComponent(sessionName)}`;
        if (updateHistory === "push" && location.hash !== targetHash) {
            history.pushState(null, "", targetHash);
        } else if (updateHistory === "replace" && location.hash !== targetHash) {
            history.replaceState(null, "", targetHash);
        }

        reconcileTabs();
        scrollActiveTabIntoView();

        const cached = panesBySession.get(sessionName);
        if (cached) {
            if (activePane !== cached) {
                if (activePane) {
                    activePane.controller.deactivate();
                    activePane.main.remove();
                    activePane.footer.remove();
                } else {
                    $("#main")?.remove();
                    $("#session-status")?.remove();
                }
                tabs.insertAdjacentElement("beforebegin", cached.main);
                cached.main.insertAdjacentElement("afterend", cached.footer);
                activePane = cached;
                cached.controller.activate();
            }
            return;
        }

        if (activePane) {
            activePane.controller.deactivate();
            activePane.main.remove();
            activePane.footer.remove();
            activePane = null;
        } else {
            $("#main")?.remove();
            $("#session-status")?.remove();
        }

        const created = await createSessionPane(sessionName);
        if (seq !== selectSeq) {
            if (created !== activePane) {
                created.controller.deactivate();
                created.main.remove();
                created.footer.remove();
            }
            return;
        }
        activePane = created;
        created.controller.activate();
        reconcileTabs();
        scrollActiveTabIntoView();
    }

    on.target(window, "hashchange", () => {
        const hashSession = parseSessionHash(location.hash);
        if (hashSession !== null && hashSession !== selectedSessionName) {
            if (live && !Array.from(sessionsById.values()).some(({ name }) => name === hashSession)) {
                const currentMain = $("#main");
                if (currentMain instanceof HTMLElement) {
                    for (const pane of panesBySession.values()) pane.controller.dispose();
                    panesBySession.clear();
                    activePane = null;
                    renderInPageError(currentMain, 404, "Workspace or session not found.");
                }
                return;
            }
            void selectSession(hashSession, { updateHistory: "none" });
        }
    });

    if (isPreseededFixture) {
        const statusFooter = $("#session-status");
        if (statusFooter instanceof HTMLElement && serverSessionName !== null) {
            const observeSession = await getObserveSession();
            const controller = observeSession(statusFooter, {
                main: initialMain,
                transport: "http",
                onNavigate: navigateHref,
                getWorkbenchSnapshot,
            });
            const entry = { sessionName: serverSessionName, main: initialMain, footer: statusFooter, controller };
            panesBySession.set(serverSessionName, entry);
            activePane = entry;
            const hashSession = parseSessionHash(location.hash);
            if (hashSession !== null && hashSession !== serverSessionName) {
                await selectSession(hashSession, { updateHistory: "none" });
            } else if (!location.hash) {
                history.replaceState(null, "", `#${encodeURIComponent(serverSessionName)}`);
            }
        }
        return;
    }

    /**
     * Hydrate `sessionsById` from `/acp` (`session/list` + `workspace.sessions`) for `workspaceId` / `currentWorkspaceName`.
     */
    async function loadSessionsFromAcp() {
        const [overviewRes, sessionsRes] = await Promise.all([
            managementAction("session/list", {
                archived: "include",
                _meta: { plurnk: { workspaceName: currentWorkspaceName, limit: 1000 } },
            }, "", pageLifetime.signal),
            managementAction("workspace.sessions", {
                workspace: currentWorkspaceName,
                includeArchived: true,
            }, "", pageLifetime.signal, { workspace: currentWorkspaceName }),
        ]);

        /** @type {Map<number, { kind?: string, gates: number, title?: string, replyId: number | null, reply: { id: number } | null }>} */
        const overviewById = new Map();
        const rawOverviewSessions = isRecord(overviewRes) && Array.isArray(overviewRes.sessions) ? overviewRes.sessions : [];
        for (const item of rawOverviewSessions) {
            if (!isRecord(item)) continue;
            const meta = isRecord(item._meta) && isRecord(item._meta.plurnk) ? item._meta.plurnk : null;
            if (!meta || typeof meta.id !== "number") continue;
            const replyId = isRecord(meta.reply) && typeof meta.reply.id === "number" ? meta.reply.id : null;
            overviewById.set(meta.id, {
                ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
                gates: typeof meta.gates === "number" ? meta.gates : 0,
                ...(typeof meta.title === "string" ? { title: meta.title } : {}),
                replyId,
                reply: replyId !== null ? { id: replyId } : null,
            });
        }

        const rawRows = isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions) ? sessionsRes.sessions : [];
        /** @type {Map<number, Record<string, unknown>>} */
        const rawById = new Map();
        for (const row of rawRows) {
            if (isRecord(row) && typeof row.id === "number") rawById.set(row.id, row);
        }

        sessionsById.clear();
        for (const row of rawRows) {
            if (!isRecord(row) || typeof row.id !== "number" || typeof row.name !== "string") continue;
            if (row.origin !== "model") continue;
            const info = overviewById.get(row.id);
            const parentSessionId = typeof row.parentSessionId === "number" ? row.parentSessionId : null;
            const parentRow = parentSessionId !== null ? rawById.get(parentSessionId) : undefined;
            const resolvedTitle = typeof info?.title === "string" && info.title.trim() !== ""
                ? info.title.trim()
                : typeof row.title === "string" && row.title.trim() !== ""
                    ? row.title.trim()
                    : null;
            const isArchived = row.archivedAt !== null && row.archivedAt !== undefined;
            sessionsById.set(row.id, {
                id: row.id,
                name: row.name,
                parentSessionId,
                parentName: typeof parentRow?.name === "string" ? parentRow.name : null,
                parentOrigin: typeof parentRow?.origin === "string" ? parentRow.origin : null,
                kind: asSessionKind(info?.kind ?? row.kind) ?? (parentSessionId === null ? "root" : "work"),
                lifecycle: typeof row.lifecycle === "string" ? row.lifecycle : "idle",
                gates: info?.gates ?? 0,
                title: resolvedTitle,
                replyId: info?.replyId ?? null,
                archived: isArchived,
            });
        }
    }

    try {
        const listedWorkspaces = parseWorkspaceList(
            await managementAction("workspace.list", { includeArchived: true }, "", pageLifetime.signal),
        );
        if (pageLifetime.signal.aborted) return;

        for (const ws of listedWorkspaces) {
            if (ws.archivedAt === null) suggestionWorkspaces.add(ws.name);
        }
        renderWorkspacesDialog(listedWorkspaces, currentWorkspaceName);

        const matchedWorkspace = listedWorkspaces.find(({ name }) => name === currentWorkspaceName);
        if (!matchedWorkspace) {
            renderInPageError(initialMain, 404, "Workspace or session not found.");
            return;
        }

        workspaceId = matchedWorkspace.id;
        currentWorkspaceName = matchedWorkspace.name;
        knownWorkspaceNames.add(currentWorkspaceName);
        hasProjectRoot = (matchedWorkspace.projectLabel ?? matchedWorkspace.projectRoot) !== null;
        projectLabel = matchedWorkspace.projectLabel;
        recomputeWorkspaceMarker();

        tabs.dataset.workspaceId = String(workspaceId);
        tabs.dataset.workspaceName = currentWorkspaceName;
        tabs.dataset.live = "true";
        if (matchedWorkspace.archivedAt !== null) {
            tabs.dataset.workspaceArchived = "true";
        } else {
            delete tabs.dataset.workspaceArchived;
        }

        await loadSessionsFromAcp();
        if (pageLifetime.signal.aborted) return;
    } catch (error) {
        if (pageLifetime.signal.aborted || Reflect.get(Object(error), "status") === 401) return;
        const status = typeof Reflect.get(Object(error), "status") === "number"
            ? /** @type {number} */ (Reflect.get(Object(error), "status"))
            : 502;
        const { message, recovery } = await describeFailure(error);
        renderInPageError(initialMain, status, message, recovery);
        return;
    }

    const initialHashSession = parseSessionHash(location.hash);
    const allModelSessions = [...sessionsById.values()];

    /** @type {WorkbenchSession | undefined} */
    let initialTarget;
    if (initialHashSession !== null) {
        initialTarget = allModelSessions.find(({ name }) => name === initialHashSession);
        if (!initialTarget) {
            renderInPageError(initialMain, 404, "Workspace or session not found.");
            return;
        }
    } else {
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
        initialTarget = candidateRoots.find(({ replyId }) => replyId !== null)
            ?? candidateRoots.find(({ name }) => name === "session1")
            ?? candidateRoots[0]
            ?? unarchivedModel.toSorted((a, b) => orderByReply(withReplyShape(a), withReplyShape(b)) || a.id - b.id)[0]
            ?? allModelSessions[0];
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
                suggestionWorkspaces.delete(currentWorkspaceName);
                currentWorkspaceName = name;
                knownWorkspaceNames.add(name);
                suggestionWorkspaces.add(name);
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
                const title = typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim() : null;
                sessionsById.set(id, {
                    id,
                    name: data.name,
                    parentSessionId,
                    kind,
                    lifecycle,
                    gates: 0,
                    title,
                    replyId: null,
                    archived: false,
                });
                reconcileTabs();
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
                reconcileTabs();
                syncHeaderPlace();
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
                if (changed) reconcileTabs();
                return;
            }
            case "session/deleted": {
                if (notifWorkspaceId !== workspaceId) return;
                const ids = Array.isArray(data.sessionIds) ? data.sessionIds : (typeof data.id === "number" ? [data.id] : []);
                let changed = false;
                for (const sid of ids) {
                    if (typeof sid !== "number") continue;
                    const existing = sessionsById.get(sid);
                    if (existing) {
                        const pane = panesBySession.get(existing.name);
                        if (pane && pane !== activePane) {
                            pane.controller.dispose();
                            panesBySession.delete(existing.name);
                        }
                    }
                    if (sessionsById.delete(sid)) {
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
            case "loop/gate-settled": {
                if (notifWorkspaceId !== workspaceId) return;
                const sid = typeof data.sessionId === "number" ? data.sessionId : notifSessionId;
                if (sid === null) return;
                const cur = sessionsById.get(sid);
                if (!cur || cur.gates <= 0) return;
                sessionsById.set(sid, { ...cur, gates: Math.max(0, cur.gates - 1) });
                reconcileTabs();
                return;
            }
            case "notifications/resync": {
                void (async () => {
                    try {
                        await loadSessionsFromAcp();
                        if (!pageLifetime.signal.aborted) reconcileTabs();
                    } catch {
                        // Ignore transient resync errors; passive reconnect will retry.
                    }
                })();
                return;
            }
            case "log/entry": {
                const entry = isRecord(data.entry) ? data.entry : null;
                if (!entry || notifWorkspaceId !== workspaceId) return;
                const sid = typeof entry.sessionId === "number" ? entry.sessionId : notifSessionId;
                if (sid === null) return;
                const cur = sessionsById.get(sid);
                if (!cur) return;
                let nextReplyId = cur.replyId;
                let nextLifecycle = cur.lifecycle;
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
                    if (rxCompletion !== null) nextReplyId = entry.id;
                }
                if (entry.state !== "proposed" && entry.op !== "done" && entry.op !== "fail" && entry.op !== "wait") {
                    nextLifecycle = "running";
                }
                if (nextReplyId !== cur.replyId || nextLifecycle !== cur.lifecycle) {
                    sessionsById.set(sid, { ...cur, replyId: nextReplyId, lifecycle: nextLifecycle });
                    reconcileTabs();
                }
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
        workspaceId,
        onNotification: applyNotification,
        onStateChange: (state) => {
            the(tabs, "notifications", state);
        },
    });
    on.target(pageLifetime.signal, "abort", () => { notifications.unsubscribe(); });

    if (!initialTarget) {
        initialMain.dataset.page = "workspace";
        syncHeaderPlace();
        reconcileTabs();
        if (!$(initialMain, "#workspace-empty")) {
            const emptyCard = $.clone(initialMain, "#workspace-empty-card");
            const startBtn = $(emptyCard, "[data-workspace-empty-new]");
            if (startBtn instanceof HTMLElement && (tabs.dataset.workspaceArchived === "true" || !allowWorkspaceCreation())) {
                startBtn.remove();
            }
        }
        return;
    }

    await notifications.initialAuthSettled;
    if (pageLifetime.signal.aborted) return;

    await selectSession(initialTarget.name, {
        updateHistory: initialHashSession !== null ? "none" : "replace",
    });
}
