import { $, $$, on, the } from "on_the_money";
import { directoryPath, parseDirectory, parseSessionHash } from "../src/directory-addresses.js";
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
 * {§web-workspace-tabs} Progressive-disclosure desktop session tabs, `#<session>` hash routing, quick-switcher modal, and resident WebSocket `/acp` panes.
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
    const initialYolo = tabs.dataset.initialYolo === "true";
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

    // Hoist workspace-level management dialogs to document.body so they survive pane swaps.
    for (const dialog of $$(initialMain, ":scope > dialog")) {
        document.body.append(dialog);
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
            const rawReply = item.dataset.replyId;
            const replyId = rawReply && /^\d+$/u.test(rawReply) ? Number(rawReply) : null;
            const archived = item.dataset.archived === "true";
            sessionsById.set(id, { id, name, parentSessionId, parentName, parentOrigin, kind, lifecycle, gates, replyId, archived });
        }
    }

    hydrateSessionsFromTabList(tabsList, true);
    if (tabs.dataset.foldedSessions) {
        try {
            const parsed = JSON.parse(tabs.dataset.foldedSessions);
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
                        replyId: typeof raw.replyId === "number" ? raw.replyId : null,
                        archived: false,
                    });
                }
            }
        } catch { /* ignore malformed metadata */ }
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

    function syncHeaderPlace() {
        const wsControl = $("#session-workspace");
        const workspacePath = directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
        if (wsControl && workspacePath !== null) {
            the(wsControl, {
                "workspace-name": currentWorkspaceName,
                "workspace-path": workspacePath,
                "workspace-icon": workspaceMarker.icon,
                "workspace-icon-label": workspaceMarker.label,
            });
        }
        if (selectedSessionName !== null) {
            the("page-title", `${currentWorkspaceName}#${selectedSessionName} — Plurnk`);
            for (const el of $$('[data-text="active-session-name"]')) {
                if (el.textContent !== selectedSessionName) el.textContent = selectedSessionName;
            }
            for (const input of $$('input[name="session"]')) {
                if (input instanceof HTMLInputElement && input.type === "hidden") {
                    input.value = selectedSessionName;
                }
            }
        }
        for (const input of $$('input[name="workspace"]')) {
            if (input instanceof HTMLInputElement && input.type === "hidden") {
                input.value = currentWorkspaceName;
            }
        }

        // Sync parent session link in #dialog-session-manage
        const parentLine = $("#dialog-session-manage [data-session-parent-line]");
        if (parentLine instanceof HTMLElement && selectedSessionName !== null) {
            const currentEntry = [...sessionsById.values()].find(({ name }) => name === selectedSessionName);
            const parentEntry = currentEntry?.parentSessionId != null
                ? sessionsById.get(currentEntry.parentSessionId) ?? null
                : null;
            const resolvedParentName = parentEntry?.name ?? currentEntry?.parentName ?? null;
            const resolvedParentOrigin = parentEntry ? "model" : (currentEntry?.parentOrigin ?? null);
            if (resolvedParentName !== null) {
                parentLine.hidden = false;
                parentLine.replaceChildren();
                if (resolvedParentOrigin === "model") {
                    const frag = $.clone(parentLine, "#session-manage-parent-link");
                    const link = $(frag, "a[data-workspace-route]");
                    if (link instanceof HTMLAnchorElement) {
                        link.href = `#${encodeURIComponent(resolvedParentName)}`;
                        link.dataset.tabSession = resolvedParentName;
                    }
                } else {
                    $.clone(parentLine, "#session-manage-parent-text");
                }
                the(parentLine, { "parent-name": resolvedParentName });
            } else {
                parentLine.hidden = true;
                parentLine.replaceChildren();
            }
        }
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
        for (const session of switcherSessions) {
            const item = /** @type {HTMLLIElement} */ ($.clone(switcherList, "#workspace-switcher-item"));
            item.dataset.switcherEntry = `${workspaceId}:${session.id}`;
            item.dataset.sessionKind = session.kind;
            item.dataset.switcherSearchText = `#${session.name} ${session.name} ${session.kind} ${session.lifecycle}`;
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
            if (labelEl) labelEl.textContent = `#${session.name}`;
        }
        applySwitcherFilter();
    }

    function reconcileTabs() {
        tabs.dataset.workspaceName = currentWorkspaceName;
        syncHeaderPlace();

        const orderedUnarchived = computeOrderedUnarchived();
        const visible = orderedUnarchived.filter((entry) => isVisibleInTabStrip(entry, selectedSessionName));
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
                if (link.getAttribute("href") !== sessionHash) link.setAttribute("href", sessionHash);
                const title = `#${session.name} (${session.lifecycle})`;
                if (link.getAttribute("title") !== title) link.setAttribute("title", title);
                if (session.name === selectedSessionName) link.setAttribute("aria-current", "true");
                else link.removeAttribute("aria-current");

                const lifecycleEl = $(link, "[data-lifecycle]");
                if (lifecycleEl && lifecycleEl.getAttribute("data-lifecycle") !== session.lifecycle) {
                    lifecycleEl.setAttribute("data-lifecycle", session.lifecycle);
                }
                const labelEl = $(link, "[data-tab-label]");
                const tabText = `#${session.name}`;
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

        let activeCount = 0;
        let gatedCount = 0;
        let backgroundGatedCount = 0;
        for (const entry of orderedUnarchived) {
            if (["queued", "running", "parked"].includes(entry.lifecycle)) activeCount++;
            if (entry.gates > 0) {
                gatedCount += entry.gates;
                if (entry.name !== selectedSessionName) backgroundGatedCount += entry.gates;
            }
        }

        const headerGates = $("[data-header-gates]");
        if (headerGates instanceof HTMLElement) {
            if (backgroundGatedCount > 0) {
                const label = `${backgroundGatedCount} awaiting input in other sessions`;
                headerGates.hidden = false;
                headerGates.dataset.sessionGates = String(backgroundGatedCount);
                headerGates.setAttribute("aria-label", label);
                headerGates.setAttribute("title", label);
                headerGates.textContent = String(backgroundGatedCount);
            } else {
                headerGates.hidden = true;
                headerGates.removeAttribute("data-session-gates");
                headerGates.textContent = "";
            }
        }

        const currentEl = $(switcherButton, "[data-switcher-current]");
        const currentText = selectedSessionName === null ? currentWorkspaceName : `#${selectedSessionName}`;
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
        on(switcherDialog, "click", "a[data-workspace-route]", (event, link) => {
            event.preventDefault();
            const target = link.getAttribute("data-tab-session") ?? parseSessionHash(link.getAttribute("href") ?? "");
            switcherDialog?.close();
            if (target) void selectSession(target, { updateHistory: "push", recordPlace: true });
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

    const pageLifetime = new AbortController();
    on.target(window, "pagehide", (event) => {
        if (!(event instanceof PageTransitionEvent) || !event.persisted) {
            pageLifetime.abort();
        }
    });

    /** @param {string} sessionName */
    function recordActivePlace(sessionName) {
        if (!live || pageLifetime.signal.aborted) return;
        const body = new URLSearchParams({ workspace: currentWorkspaceName, session: sessionName });
        void fetch("/place", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body,
            signal: pageLifetime.signal,
        }).catch(() => {});
    }

    /** @param {string} targetPath */
    function navigateHref(targetPath) {
        if (targetPath.startsWith("#")) {
            const targetSession = parseSessionHash(targetPath);
            if (targetSession) {
                void selectSession(targetSession, { updateHistory: "push", recordPlace: true });
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
            void selectSession(dir.session, { updateHistory: "push", recordPlace: true });
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
                    void selectSession(target, { updateHistory: "push", recordPlace: true });
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
                void selectSession(target, { updateHistory: "push", recordPlace: true });
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
            if (target) void selectSession(target, { updateHistory: "push", recordPlace: true });
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

    /** @type {Promise<{ open(section?: import("./workspace-settings.js").SettingsSection): void, notifyChanged(familyOrTopic: string): void }> | null} */
    let settingsControllerPromise = null;

    /** @param {string} [rawSection] */
    async function openSettingsModal(rawSection) {
        settingsControllerPromise ??= import("./workspace-settings.js").then(({ createWorkspaceSettingsController }) =>
            createWorkspaceSettingsController(() => ({
                workspaceId,
                workspaceName: currentWorkspaceName,
                sessionName: selectedSessionName,
                auth,
                signal: pageLifetime.signal,
            })),
        );
        const controller = await settingsControllerPromise;
        const { isSettingsSection } = await import("./workspace-settings.js");
        controller.open(isSettingsSection(rawSection) ? rawSection : undefined);
    }

    on(document.body, "click", "[data-workspace-settings]", () => {
        void openSettingsModal();
    });

    on(document.body, "click", "[data-open-workspace-settings]", (_event, btn) => {
        const targetSection = btn.getAttribute("data-open-workspace-settings") ?? undefined;
        void openSettingsModal(targetSection);
    });

    on(document.body, "click", 'a[data-workspace-route="session"], main a[data-session-name], #session-descendants a', (event, link) => {
        if (!(link instanceof HTMLAnchorElement)) return;
        if (event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
        const rawHref = link.getAttribute("href") ?? "";
        if (rawHref.startsWith("#")) {
            const target = link.dataset.tabSession ?? parseSessionHash(rawHref);
            if (target) {
                event.preventDefault();
                const openDialog = link.closest("dialog");
                if (openDialog instanceof HTMLDialogElement && openDialog.open) openDialog.close();
                void selectSession(target, { updateHistory: "push", recordPlace: true });
            }
            return;
        }
        const dir = parseDirectory(rawHref);
        if (dir && dir.kind === "session" && knownWorkspaceNames.has(dir.workspace)) {
            event.preventDefault();
            const openDialog = link.closest("dialog");
            if (openDialog instanceof HTMLDialogElement && openDialog.open) openDialog.close();
            void selectSession(dir.session, { updateHistory: "push", recordPlace: true });
        }
    });

    /** @type {Map<string, PaneEntry>} */
    const panesBySession = new Map();
    /** @type {PaneEntry | null} */
    let activePane = null;
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

    /** @param {string} sessionName @returns {Promise<PaneEntry>} */
    async function createSessionPane(sessionName) {
        const observeSession = await getObserveSession();
        const folderLabel = projectLabel !== null && projectLabel !== currentWorkspaceName ? projectLabel : "";
        const sessionPath = directoryPath({ kind: "session", workspace: currentWorkspaceName, session: sessionName }) ?? `/~/${encodeURIComponent(currentWorkspaceName)}#${encodeURIComponent(sessionName)}`;

        const nextMain = /** @type {HTMLElement} */ ($.clone(tabs, "#workspace-session-main", { position: "afterend" }));
        nextMain.dataset.sessionName = sessionName;
        const folderEl = $(nextMain, "#session-folder");
        if (folderEl) {
            the(folderEl, "project-label", folderLabel);
        }
        const connEl = $(nextMain, "#session-connection");
        if (connEl) {
            the(connEl, {
                "session-path": sessionPath,
                "sign-in-path": `/auth/login?return=${encodeURIComponent(sessionPath)}`,
            });
        }

        const nextFooter = /** @type {HTMLElement} */ ($.clone(nextMain, "#workspace-session-footer", { position: "afterend" }));
        nextFooter.dataset.workspaceId = String(workspaceId);
        nextFooter.dataset.sessionId = `${workspaceId}#${sessionName}`;
        nextFooter.dataset.sessionName = sessionName;
        nextFooter.dataset.auth = auth;
        if (tabs.dataset.needsOnboarding === "true") {
            nextFooter.dataset.needsOnboarding = "true";
        }
        const yoloBtn = $(nextFooter, "#session-yolo");
        if (yoloBtn instanceof HTMLButtonElement) {
            yoloBtn.setAttribute("aria-pressed", String(initialYolo));
            yoloBtn.title = `${initialYolo ? "Auto" : "Manual"} Approval (Shift+Tab · /yolo)`;
            the(yoloBtn, "yolo-label", initialYolo ? "Auto-approve" : "Review");
        }

        const controller = observeSession(nextFooter, {
            main: nextMain,
            transport: live ? "ws" : "http",
            onNavigate: navigateHref,
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
     * @param {{ updateHistory: "push" | "replace" | "none", recordPlace: boolean }} options
     */
    async function selectSession(sessionName, { updateHistory, recordPlace }) {
        if (switcherDialog?.open) switcherDialog.close();
        const seq = ++selectSeq;
        selectedSessionName = sessionName;

        const targetHash = `#${encodeURIComponent(sessionName)}`;
        if (updateHistory === "push" && location.hash !== targetHash) {
            history.pushState(null, "", targetHash);
        } else if (updateHistory === "replace" && location.hash !== targetHash) {
            history.replaceState(null, "", targetHash);
        }
        if (recordPlace) recordActivePlace(sessionName);

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
                tabs.insertAdjacentElement("afterend", cached.main);
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
            void selectSession(hashSession, { updateHistory: "none", recordPlace: true });
        }
    });

    if (!live) {
        const statusFooter = $("#session-status");
        if (statusFooter instanceof HTMLElement && serverSessionName !== null) {
            const observeSession = await getObserveSession();
            const controller = observeSession(statusFooter, {
                main: initialMain,
                transport: "http",
                onNavigate: navigateHref,
            });
            const entry = { sessionName: serverSessionName, main: initialMain, footer: statusFooter, controller };
            panesBySession.set(serverSessionName, entry);
            activePane = entry;
            const hashSession = parseSessionHash(location.hash);
            if (hashSession !== null && hashSession !== serverSessionName) {
                await selectSession(hashSession, { updateHistory: "none", recordPlace: false });
            } else if (!location.hash) {
                history.replaceState(null, "", `#${encodeURIComponent(serverSessionName)}`);
            }
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
            case "functionality/changed": {
                if (notifWorkspaceId !== workspaceId) return;
                const family = typeof data.family === "string" ? data.family : null;
                if (family && settingsControllerPromise) {
                    void settingsControllerPromise.then((ctrl) => ctrl.notifyChanged(family));
                }
                return;
            }
            case "session/policy": {
                if (notifWorkspaceId !== workspaceId) return;
                if (settingsControllerPromise) {
                    void settingsControllerPromise.then((ctrl) => ctrl.notifyChanged("policy"));
                }
                return;
            }
            case "notifications/resync": {
                void (async () => {
                    try {
                        const wsPath = directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
                        if (!wsPath) return;
                        const res = await fetch(wsPath, {
                            headers: { accept: "text/html" },
                            cache: "no-store",
                        });
                        if (!res.ok) return;
                        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
                        const parsedTabsList = $(doc, "#workspace-tabs > ul");
                        if (parsedTabsList) {
                            sessionsById.clear();
                            hydrateSessionsFromTabList(parsedTabsList, false);
                            reconcileTabs();
                        }
                        if (settingsControllerPromise) {
                            void settingsControllerPromise.then((ctrl) => ctrl.notifyChanged("resync"));
                        }
                    } catch {
                        // Ignore transient resync fetch errors; passive reconnect will retry.
                    }
                })();
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
        auth,
        workspaceId,
        onNotification: applyNotification,
        onStateChange: (state) => {
            the(tabs, "notifications", state);
        },
    });

    await notifications.initialAuthSettled;
    const statusFooter = $("#session-status");
    const initialHashSession = parseSessionHash(location.hash);

    if (initialHashSession !== null && initialHashSession !== serverSessionName) {
        await selectSession(initialHashSession, { updateHistory: "none", recordPlace: true });
        return;
    }

    if (statusFooter instanceof HTMLElement && serverSessionName !== null) {
        if (!location.hash) {
            history.replaceState(null, "", `#${encodeURIComponent(serverSessionName)}`);
        }
        const observeSession = await getObserveSession();
        const controller = observeSession(statusFooter, {
            main: initialMain,
            transport: "ws",
            onNavigate: navigateHref,
        });
        const entry = {
            sessionName: serverSessionName,
            main: initialMain,
            footer: statusFooter,
            controller,
        };
        panesBySession.set(serverSessionName, entry);
        activePane = entry;
        reconcileTabs();
        scrollActiveTabIntoView();
    }
}
