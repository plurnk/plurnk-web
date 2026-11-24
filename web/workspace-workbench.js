import { $, $$, on, the } from "on_the_money";
import { directoryPath, parseDirectory, parseSessionHash, workspaceSettingsPath } from "../src/directory-addresses.js";
import { allowWorkspaceCreation } from "./endpoints.js";
import renderInPageError from "./error-view.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import { hasActiveOidcGrant, onOidcGrantChange } from "./oidc.js";
import { parseWorkspaceList, renderWorkspacesDialog, wireWorkspaceCreateDialog } from "./workspace-dialogs.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";
import {
    applyWorkbenchNotification,
    computeOrderedUnarchived,
    hydrateFoldedSessions,
    hydrateSessionsFromTabList,
    loadWorkbenchSessionsFromAcp,
    selectInitialWorkbenchSession,
} from "./workspace-workbench-state.js";
import { createWorkbenchTabsAndSwitcher } from "./workspace-workbench-ui.js";

/** @typedef {import("./workspace-workbench-state.js").WorkbenchSession} WorkbenchSession */

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

/**
 * {§web-directory-documents} {§web-workspace-tabs} {§web-workspace-folder}
 * Unified browser-style session tab strip, `#<session>` hash routing, quick-switcher modal, and resident WebSocket `/acp` panes.
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

    if (isPreseededFixture) {
        hydrateSessionsFromTabList(tabsList, sessionsById, tabRowsById);
        hydrateFoldedSessions(tabs.dataset.foldedSessions, sessionsById);
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

    const workbenchUi = createWorkbenchTabsAndSwitcher({
        tabs,
        tabsList,
        tabRowsById,
        sessionsById,
        pageLifetime,
        live,
        getWorkspaceId: () => workspaceId,
        getWorkspaceName: () => currentWorkspaceName,
        getSelectedSessionName: () => selectedSessionName,
        onSyncHeaderPlace: syncHeaderPlace,
        onSelectSession: (target, options) => selectSession(target, options),
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
        sessions: computeOrderedUnarchived(sessionsById).map(({ name }) => name),
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
        workbenchUi.closeSwitcherIfOpen();
        const seq = ++selectSeq;
        selectedSessionName = sessionName;

        const targetHash = `#${encodeURIComponent(sessionName)}`;
        if (updateHistory === "push" && location.hash !== targetHash) {
            history.pushState(null, "", targetHash);
        } else if (updateHistory === "replace" && location.hash !== targetHash) {
            history.replaceState(null, "", targetHash);
        }

        workbenchUi.reconcileTabs();
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
        workbenchUi.reconcileTabs();
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

        await loadWorkbenchSessionsFromAcp(currentWorkspaceName, pageLifetime.signal, sessionsById);
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
        initialTarget = selectInitialWorkbenchSession(allModelSessions);
    }

    const notifications = subscribeWorkspaceNotifications({
        workspaceId,
        onNotification: (raw) => applyWorkbenchNotification(raw, {
            workspaceId,
            sessionsById,
            onWorkspaceRenamed(name) {
                suggestionWorkspaces.delete(currentWorkspaceName);
                currentWorkspaceName = name;
                knownWorkspaceNames.add(name);
                suggestionWorkspaces.add(name);
                recomputeWorkspaceMarker();
            },
            onWorkspaceMetaFromSession(meta) {
                if (typeof meta.workspaceName === "string") {
                    currentWorkspaceName = meta.workspaceName;
                    knownWorkspaceNames.add(meta.workspaceName);
                }
                if (typeof meta.projectRoot === "string") hasProjectRoot = true;
                else if (meta.projectRoot === null) hasProjectRoot = false;
                if (typeof meta.projectLabel === "string") projectLabel = meta.projectLabel;
                else if (meta.projectLabel === null) projectLabel = null;
                recomputeWorkspaceMarker();
            },
            onSessionDeleted(sid, existing) {
                if (existing) {
                    const pane = panesBySession.get(existing.name);
                    if (pane && pane !== activePane) {
                        pane.controller.dispose();
                        panesBySession.delete(existing.name);
                    }
                }
                tabRowsById.delete(sid);
            },
            onReconcileTabs: () => workbenchUi.reconcileTabs(),
            onSyncHeaderPlace: syncHeaderPlace,
            onResync() {
                void (async () => {
                    try {
                        await loadWorkbenchSessionsFromAcp(currentWorkspaceName, pageLifetime.signal, sessionsById);
                        if (!pageLifetime.signal.aborted) workbenchUi.reconcileTabs();
                    } catch {
                        // Ignore transient resync errors; passive reconnect will retry.
                    }
                })();
            },
        }),
        onStateChange: (state) => {
            the(tabs, "notifications", state);
        },
    });
    on.target(pageLifetime.signal, "abort", () => { notifications.unsubscribe(); });

    if (!initialTarget) {
        initialMain.dataset.page = "workspace";
        syncHeaderPlace();
        workbenchUi.reconcileTabs();
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
