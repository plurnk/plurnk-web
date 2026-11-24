import { $, $$, on, the } from "on_the_money";
import { directoryPath, nextSequentialName, parseSessionHash, workspaceSettingsPath } from "../src/directory-addresses.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import {
    computeOrderedUnarchived,
    isRecord,
    isUntouchedDraftWorkbenchSession,
    isVisibleInTabStrip,
} from "./workspace-workbench-state.js";

/** @typedef {import("./workspace-workbench-state.js").WorkbenchSession} WorkbenchSession */

/**
 * {§web-workspace-tabs} {§web-session-creation} {§web-session-archive}
 * Bottom tab strip (`#workspace-tabs`), quick-switcher modal (`#dialog-workspace-switcher`),
 * session-creation dialog (`#dialog-session-create`), and workbench keyboard shortcuts.
 * @param {{
 *   readonly tabs: HTMLElement,
 *   readonly tabsList: HTMLUListElement,
 *   readonly tabRowsById: Map<number, HTMLLIElement>,
 *   readonly sessionsById: Map<number, WorkbenchSession>,
 *   readonly pageLifetime: AbortController,
 *   readonly live: boolean,
 *   readonly getWorkspaceId: () => number,
 *   readonly getWorkspaceName: () => string,
 *   readonly getSelectedSessionName: () => string | null,
 *   readonly onSyncHeaderPlace: () => void,
 *   readonly onSelectSession: (sessionName: string, options: { updateHistory: "push" | "replace" | "none" }) => Promise<void>,
 * }} host
 */
export function createWorkbenchTabsAndSwitcher({
    tabs,
    tabsList,
    tabRowsById,
    sessionsById,
    pageLifetime,
    live,
    getWorkspaceId,
    getWorkspaceName,
    getSelectedSessionName,
    onSyncHeaderPlace,
    onSelectSession,
}) {
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
        const workspaceId = getWorkspaceId();
        const currentWorkspaceName = getWorkspaceName();
        const selectedSessionName = getSelectedSessionName();
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
        const workspaceId = getWorkspaceId();
        const currentWorkspaceName = getWorkspaceName();
        const selectedSessionName = getSelectedSessionName();
        tabs.dataset.workspaceName = currentWorkspaceName;
        onSyncHeaderPlace();

        const orderedUnarchived = computeOrderedUnarchived(sessionsById);
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
            if (target) void onSelectSession(target, { updateHistory: "push" });
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
        renderSwitcherItems(computeOrderedUnarchived(sessionsById));
        if (!dialog.open) dialog.showModal();
        switcherSearch?.focus();
    }

    function closeSwitcherIfOpen() {
        if (switcherDialog?.open) switcherDialog.close();
    }

    function openSessionCreateDialog() {
        if (tabs.dataset.workspaceArchived === "true") return false;
        const createDialog = $("#dialog-session-create");
        if (!(createDialog instanceof HTMLDialogElement)) return false;
        closeSwitcherIfOpen();
        onSyncHeaderPlace();
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
        const currentWorkspaceName = getWorkspaceName();
        const workspaceId = getWorkspaceId();
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
                await onSelectSession(freshName, { updateHistory: historyMode });
                return true;
            }
            location.assign(directoryPath({ kind: "workspace", workspace: currentWorkspaceName }) ?? "/");
            return true;
        } finally {
            newSessionBusy = false;
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
                const target = first?.dataset.tabSession ?? parseSessionHash(first?.getAttribute("href") ?? "");
                if (target) {
                    rawEvent.preventDefault();
                    switcherDialog.close();
                    void onSelectSession(target, { updateHistory: "push" });
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
                void onSelectSession(target, { updateHistory: "push" });
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
            if (target) void onSelectSession(target, { updateHistory: "push" });
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
                const workspaceId = getWorkspaceId();
                await managementAction("session/unarchive", {}, `${workspaceId}#${targetSession}`, pageLifetime.signal);
                for (const [sid, cur] of sessionsById) {
                    if (cur.name === targetSession || (cur.archived && cur.parentName === targetSession)) {
                        sessionsById.set(sid, { ...cur, archived: false });
                    }
                }
                closeSwitcherIfOpen();
                await onSelectSession(targetSession, { updateHistory: "push" });
            } catch {
                location.assign(directoryPath({ kind: "workspace", workspace: getWorkspaceName() }) ?? "/search/?status=archived");
            } finally {
                unarchiveMutationBusy = false;
            }
        })();
    });

    return {
        reconcileTabs,
        closeSwitcherIfOpen,
    };
}
