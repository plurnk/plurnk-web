import { $, $$, on, the } from "on_the_money";
import { directoryPath, workspaceSettingsPath } from "../src/directory-addresses.js";
import { serviceVersion } from "./endpoints.js";
import renderInPageError from "./error-view.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import { mountSchedulePanel } from "./schedule-panel.js";
import { createModelSearchCache } from "./session-models.js";
import { isRecord } from "./session-translator.js";
import { parseWorkspaceList, wireWorkspaceCreateDialog } from "./workspace-dialogs.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";
import { mountFamilyAndEnvSections } from "./workspace-settings-families.js";
import { mountModelsHelpAboutSections } from "./workspace-settings-models.js";
import { mountWorkspaceAndSessionSettings, wireSettingsSessionCreateDialog } from "./workspace-settings-session.js";

/**
 * @typedef {"workspace" | "session" | "models" | "mcp" | "skills" | "schedule" | "personas" | "members" | "env" | "help" | "about"} SettingsSection
 */

/** @typedef {import("./workspace-settings-families.js").WorkspaceFamily} WorkspaceFamily */
/** @typedef {import("./workspace-dialogs.js").WorkspaceSettingsContext} WorkspaceSettingsContext */

const SECTIONS = /** @type {const} */ (["workspace", "session", "models", "mcp", "skills", "schedule", "personas", "members", "env", "help", "about"]);

/** @param {unknown} value @returns {value is SettingsSection} */
export const isSettingsSection = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (SECTIONS).includes(value);

/**
 * {§web-workspace-settings} Mounts workspace and session management inside `<article id="workspace-settings">`.
 * @param {HTMLElement} article
 * @param {() => WorkspaceSettingsContext} getContext
 * @param {{ updateHash?: boolean, initialQuery?: string, initialHelpFilter?: string, initialEnvScope?: "workspace" | "session" }} [options]
 */
export function createWorkspaceSettingsController(article, getContext, {
    updateHash = false,
    initialQuery = "",
    initialHelpFilter = "",
    initialEnvScope = "workspace",
} = {}) {
    /** @type {Element | null} */
    let envPanel = null;
    /** @type {SettingsSection} */
    let activeSection = "workspace";
    let busy = false;
    let refreshDepth = 0;
    let mounted = false;

    /** @type {ReturnType<typeof mountWorkspaceAndSessionSettings> | null} */
    let sessionController = null;
    /** @type {ReturnType<typeof mountModelsHelpAboutSections> | null} */
    let modelsHelpAboutController = null;
    /** @type {ReturnType<typeof mountFamilyAndEnvSections> | null} */
    let familiesEnvController = null;
    /** @type {ReturnType<typeof mountSchedulePanel> | null} */
    let schedulePanelController = null;

    const modelSearchCache = createModelSearchCache((kind, params = {}, signal) => {
        const ctx = getContext();
        const combinedSignal = signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal;
        return managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", combinedSignal, {
            workspaceId: ctx.workspaceId,
        });
    });

    function syncLoadingState() {
        the(article, "ws-settings-loading", busy || refreshDepth > 0 ? "true" : null);
    }

    /** @param {boolean} nextBusy @param {string} [message] @param {string} [recovery] */
    function setFeedback(nextBusy, message = "", recovery = "") {
        busy = nextBusy;
        the(article, {
            "ws-settings-loading": nextBusy || refreshDepth > 0 ? "true" : null,
            "ws-settings-busy": nextBusy ? "true" : null,
            "ws-settings-message": message,
            "ws-settings-recovery": recovery,
            "env-busy": nextBusy ? "" : null,
        });
        if (envPanel) {
            the(envPanel, "env-busy", nextBusy ? "" : null);
        }
    }

    /**
     * @param {string} kind
     * @param {Record<string, unknown>} [params]
     * @param {{ requireSession?: boolean, signal?: AbortSignal }} [opts]
     */
    async function invoke(kind, params = {}, opts = {}) {
        const ctx = getContext();
        const combinedSignal = opts.signal ? AbortSignal.any([ctx.signal, opts.signal]) : ctx.signal;
        combinedSignal.throwIfAborted();
        const sessionId = ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "";
        if (opts.requireSession && !sessionId) {
            throw new Error("Open a session tab to manage session-scoped settings.");
        }
        return managementAction(kind, params, sessionId, combinedSignal, {
            workspaceId: ctx.workspaceId,
        });
    }

    /** @param {(signal: AbortSignal) => Promise<string>} work */
    async function runMutation(work) {
        if (busy) return;
        const ctx = getContext();
        setFeedback(true, "Running…", "");
        try {
            ctx.signal.throwIfAborted();
            const summary = await work(ctx.signal);
            ctx.signal.throwIfAborted();
            setFeedback(false, summary, "");
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery);
        }
    }

    /** @param {SettingsSection} section */
    async function refreshSection(section) {
        if (section === "workspace") {
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (section === "help") {
            modelsHelpAboutController?.applyHelpFilter();
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (section === "about") {
            modelsHelpAboutController?.syncAboutPanel();
            if (serviceVersion() === null) {
                const ctx = getContext();
                await managementAction("workspace.list", {}, "", ctx.signal).catch(() => null);
                modelsHelpAboutController?.syncAboutPanel();
            }
            if (!busy) setFeedback(false, "", "");
            return;
        }
        const ctx = getContext();
        if (ctx.workspaceId <= 0) {
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (section === "session" && ctx.sessionName === null) {
            sessionController?.renderSessionConfigControls(null, [], []);
            if (!busy) setFeedback(false, "", "");
            return;
        }
        if (!busy) {
            the(article, { "ws-settings-message": "", "ws-settings-recovery": "" });
        }
        refreshDepth += 1;
        syncLoadingState();
        try {
            if (section === "session") {
                await sessionController?.hydrateSessionConfig();
                return;
            }
            if (section === "models") {
                await modelsHelpAboutController?.loadModelsCatalog();
                return;
            }
            if (section === "env") {
                await familiesEnvController?.loadEnvSection();
                return;
            }
            await familiesEnvController?.loadFamilySection(section);
            ctx.signal.throwIfAborted();
            if (section === "schedule" && schedulePanelController) {
                void schedulePanelController.refreshAuxiliaryData();
            }
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            if (!busy) {
                setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery);
            }
        } finally {
            refreshDepth = Math.max(0, refreshDepth - 1);
            syncLoadingState();
        }
    }

    function prefillScheduleTarget() {
        schedulePanelController?.prefillTarget();
    }

    /** @param {SettingsSection} section @param {boolean} [pushHash] */
    function selectSection(section, pushHash = false) {
        ensureMounted();
        activeSection = section;
        for (const item of $$(article, "[data-settings-section]")) {
            if (item.getAttribute("data-settings-section") === section) {
                item.setAttribute("aria-current", "true");
            } else {
                item.removeAttribute("aria-current");
            }
        }
        for (const panel of $$(article, "[data-settings-panel]")) {
            if (panel instanceof HTMLElement) {
                panel.hidden = panel.dataset.settingsPanel !== section;
            }
        }
        if (pushHash && updateHash && typeof history === "object") {
            const nextUrl = section === "workspace"
                ? `${location.pathname}${location.search}`
                : `${location.pathname}${location.search}#${section}`;
            if (`${location.pathname}${location.search}${location.hash}` !== nextUrl) {
                history.replaceState(null, "", nextUrl);
            }
        }
        if (section === "schedule") prefillScheduleTarget();
        void refreshSection(section);
    }

    function ensureMounted() {
        if (mounted) return;
        mounted = true;
        const sessionConfigOutlet = $(article, "[data-session-config-outlet]");
        if (sessionConfigOutlet) {
            const clonedSessionCfg = $.clone(sessionConfigOutlet, "#session-config-controls", { position: "beforebegin" });
            if (clonedSessionCfg) sessionConfigOutlet.remove();
        }
        if (!$(article, '[data-settings-panel="mcp"]')) {
            const host = $(article, "[data-settings-subsystems]") ?? article;
            $.clone(host, "#workspace-settings-subsystems");
        }
        const envOutlet = $(article, "[data-ws-env-outlet]");
        if (envOutlet && !envPanel) {
            envPanel = $.clone(envOutlet, "#command-env");
            const envSetForm = $(envPanel, "form[data-env-set-form]");
            const envFormOutlet = $(article, "[data-ws-env-form-outlet]");
            if (envSetForm && envFormOutlet) {
                envFormOutlet.replaceWith(envSetForm);
            }
        }

        sessionController = mountWorkspaceAndSessionSettings(article, {
            getContext,
            invoke,
            runMutation,
            modelSearchCache,
            refreshSessionSection: () => refreshSection("session"),
        });

        modelsHelpAboutController = mountModelsHelpAboutSections(article, {
            getContext,
            invoke,
            runMutation,
            modelSearchCache,
            initialQuery,
            initialHelpFilter,
            onRefreshModels: () => refreshSection("models"),
        });

        const schedulePanelEl = $(article, '[data-settings-panel="schedule"]');
        if (schedulePanelEl instanceof HTMLElement) {
            schedulePanelController = mountSchedulePanel(schedulePanelEl, {
                getContext,
                invoke,
                invokeForSession: (kind, params, targetSession, signal) => {
                    const ctx = getContext();
                    const combinedSignal = signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal;
                    return managementAction(kind, params, `${ctx.workspaceId}#${targetSession}`, combinedSignal, {
                        workspaceId: ctx.workspaceId,
                    });
                },
                runMutation,
                setFeedback,
                refreshList: () => familiesEnvController?.loadFamilySection("schedule") ?? Promise.resolve(),
            });
        }

        familiesEnvController = mountFamilyAndEnvSections(article, {
            getContext,
            invoke,
            runMutation,
            setFeedback,
            isBusy: () => busy,
            modelSearchCache,
            envPanel,
            initialEnvScope,
            onRenderScheduleList: (res) => { schedulePanelController?.renderList(res); },
            onRefreshSection: (section) => refreshSection(section),
            onRefreshEnv: () => refreshSection("env"),
        });

        on.target(getContext().signal, "abort", () => {
            sessionController?.dispose();
            modelsHelpAboutController?.dispose();
            familiesEnvController?.dispose();
            schedulePanelController?.dispose();
        });

        on(article, "click", "details[data-family-disclosure] > summary", (_event, summary) => {
            if (!busy) setFeedback(false, "", "");
            const details = summary.parentElement;
            if (details instanceof HTMLDetailsElement && details.dataset.familyDisclosure === "schedule" && !details.open) {
                prefillScheduleTarget();
            }
        });

        on(article, "click", "[data-settings-section]", (event, link) => {
            const raw = link.getAttribute("data-settings-section");
            if (isSettingsSection(raw)) {
                event.preventDefault();
                selectSection(raw, true);
            }
        });
    }

    ensureMounted();

    return {
        /** @param {SettingsSection} [initialSection] */
        open(initialSection = activeSection) {
            const targetSection = isSettingsSection(initialSection) ? initialSection : "workspace";
            selectSection(targetSection, false);
        },
        /** @param {SettingsSection} section @param {boolean} [pushHash] */
        selectSection(section, pushHash = false) {
            selectSection(section, pushHash);
        },
        /** @param {string} familyOrTopic */
        notifyChanged(familyOrTopic) {
            if (busy || activeSection === "help" || activeSection === "about") return;
            if (
                familyOrTopic === "resync"
                || familyOrTopic === activeSection
                || (familyOrTopic === "policy" && (activeSection === "session" || activeSection === "models"))
                || (familyOrTopic === "personas" && (activeSection === "session" || activeSection === "schedule"))
                || (familyOrTopic === "mcp" && activeSection === "schedule")
            ) {
                void refreshSection(activeSection);
            }
        },
    };
}

/** @param {string} hash @returns {SettingsSection} */
function parseSettingsHash(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    try {
        const decoded = decodeURIComponent(raw);
        return isSettingsSection(decoded) ? decoded : "workspace";
    } catch {
        return "workspace";
    }
}

/**
 * {§web-workspace-settings} Dedicated `/settings/?workspace=<name>` page entrypoint loaded over `/acp`.
 * @param {HTMLElement} main
 */
export default async function observeWorkspaceSettings(main) {
    const article = $(main, "#workspace-settings");
    if (!(article instanceof HTMLElement)) {
        throw new Error("Workspace settings article is missing.");
    }

    const pageLifetime = new AbortController();
    on.target(window, "pagehide", (event) => {
        if (!(event instanceof PageTransitionEvent) || !event.persisted) {
            pageLifetime.abort();
        }
    });

    const queryParams = new URLSearchParams(location.search);
    const preseededWorkspaceId = main.dataset.workspaceId ?? "";
    const isPreseededFixture = /^[1-9]\d*$/u.test(preseededWorkspaceId) && main.dataset.live !== "true";

    let workspaceId = isPreseededFixture ? Number(preseededWorkspaceId) : 0;
    let currentWorkspaceName = queryParams.get("workspace") ?? main.dataset.workspaceName ?? "";
    let sessionName = queryParams.get("session") || main.dataset.sessionName || null;
    /** @type {Set<string>} */
    const knownWorkspaceNames = new Set(currentWorkspaceName ? [currentWorkspaceName] : []);
    /** @type {Set<string>} */
    const knownSessionNames = new Set(sessionName ? [sessionName] : []);

    wireWorkspaceCreateDialog({
        signal: pageLifetime.signal,
        getKnownWorkspaceNames: () => knownWorkspaceNames,
    });

    wireSettingsSessionCreateDialog({
        signal: pageLifetime.signal,
        getWorkspaceId: () => workspaceId,
        getWorkspaceName: () => currentWorkspaceName,
        getKnownSessionNames: () => knownSessionNames,
    });

    if (!isPreseededFixture) {
        if (currentWorkspaceName !== "" && directoryPath({ kind: "workspace", workspace: currentWorkspaceName }) === null) {
            renderInPageError(main, 404, "Workspace not found.");
            return;
        }
        try {
            const listedWorkspaces = parseWorkspaceList(
                await managementAction("workspace.list", { includeArchived: true }, "", pageLifetime.signal),
            );
            if (pageLifetime.signal.aborted) return;
            for (const ws of listedWorkspaces) knownWorkspaceNames.add(ws.name);

            const matchedWorkspace = currentWorkspaceName !== ""
                ? listedWorkspaces.find(({ name }) => name === currentWorkspaceName)
                : (listedWorkspaces.find(({ archivedAt }) => archivedAt === null) ?? listedWorkspaces[0]);

            if (!matchedWorkspace) {
                const initialSec = parseSettingsHash(location.hash);
                if (currentWorkspaceName !== "" || (initialSec !== "about" && initialSec !== "help")) {
                    renderInPageError(main, 404, "Workspace not found.");
                    return;
                }
            } else {
                workspaceId = matchedWorkspace.id;
                currentWorkspaceName = matchedWorkspace.name;
                main.dataset.workspaceId = String(workspaceId);
                main.dataset.workspaceName = currentWorkspaceName;
                main.dataset.live = "true";

                const wsArchived = matchedWorkspace.archivedAt !== null;
                if (wsArchived) article.dataset.workspaceArchived = "true";
                else delete article.dataset.workspaceArchived;

                const effectiveProject = matchedWorkspace.projectLabel ?? matchedWorkspace.projectRoot;
                const iconGlyph = effectiveProject !== null ? "🗂️" : "☁️";
                const iconLabel = effectiveProject !== null ? "Project workspace" : "Folderless workspace";

                const sessionsRes = await managementAction("workspace.sessions", {
                    workspaceId,
                    includeArchived: true,
                }, "", pageLifetime.signal, { workspaceId }).catch(() => null);
                if (pageLifetime.signal.aborted) return;

                const rawRows = isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions) ? sessionsRes.sessions : [];
                /** @type {Map<number, Record<string, unknown>>} */
                const rowById = new Map();
                for (const row of rawRows) {
                    if (isRecord(row) && typeof row.id === "number") {
                        rowById.set(row.id, row);
                        if (typeof row.name === "string") knownSessionNames.add(row.name);
                    }
                }
                const activeRow = sessionName
                    ? (rawRows.find((r) => isRecord(r) && r.name === sessionName && r.origin === "model") ?? null)
                    : null;
                if (!activeRow) sessionName = null;
                main.dataset.sessionName = sessionName ?? "";

                the("page-title", `${currentWorkspaceName} · Settings — Plurnk`);
                const backLink = $("[data-settings-back]");
                const backPath = sessionName !== null
                    ? directoryPath({ kind: "session", workspace: currentWorkspaceName, session: sessionName })
                    : directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
                if (backLink && backPath !== null) {
                    the(backLink, {
                        "workspace-name": currentWorkspaceName,
                        "workspace-back-path": backPath,
                        "workspace-icon": iconGlyph,
                        "workspace-icon-label": iconLabel,
                    });
                }

                const folderLine = $(article, "[data-settings-folder]");
                if (folderLine instanceof HTMLElement) {
                    if (matchedWorkspace.projectLabel !== null) {
                        folderLine.hidden = false;
                        the(folderLine, "project-label", matchedWorkspace.projectLabel);
                    } else {
                        folderLine.hidden = true;
                    }
                }

                const renameInput = $(article, 'form#workspace-rename input[name="name"]');
                if (renameInput instanceof HTMLInputElement) renameInput.value = currentWorkspaceName;
                const wsArchBtn = $(article, "[data-workspace-archive-btn]");
                const wsUnarchBtn = $(article, "[data-workspace-unarchive-btn]");
                if (wsArchBtn instanceof HTMLElement) wsArchBtn.hidden = wsArchived;
                if (wsUnarchBtn instanceof HTMLElement) wsUnarchBtn.hidden = !wsArchived;
                const addSessionBtn = $(article, "[data-settings-add-session]");
                if (addSessionBtn instanceof HTMLElement) addSessionBtn.hidden = wsArchived;

                for (const input of $$('input[name="workspace"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden") {
                        input.value = currentWorkspaceName;
                    }
                }
                for (const input of $$('input[name="session"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden") {
                        input.value = sessionName ?? "";
                    }
                }

                const headingHandle = $(article, "[data-session-heading-handle]");
                const parentLine = $(article, "[data-session-parent-line]");
                const parentSlot = $(article, "[data-session-parent-slot]");
                const titleForm = $(article, "form#session-title");
                const noSessionNote = $(article, "[data-no-active-session]");
                if (isRecord(activeRow) && sessionName !== null) {
                    if (headingHandle instanceof HTMLElement) {
                        headingHandle.hidden = false;
                        the(headingHandle, "session-heading-code", `#${sessionName}`);
                    }
                    if (noSessionNote instanceof HTMLElement) noSessionNote.hidden = true;
                    if (titleForm instanceof HTMLFormElement) {
                        titleForm.hidden = false;
                        const titleInput = $(titleForm, 'input[name="title"]');
                        if (titleInput instanceof HTMLInputElement) {
                            titleInput.value = typeof activeRow.title === "string" ? activeRow.title : "";
                        }
                        const sessArchived = activeRow.archivedAt !== null && activeRow.archivedAt !== undefined;
                        const sessArchBtn = $(titleForm, "[data-session-archive-btn]");
                        const sessUnarchBtn = $(titleForm, "[data-session-unarchive-btn]");
                        if (sessArchBtn instanceof HTMLElement) sessArchBtn.hidden = sessArchived;
                        if (sessUnarchBtn instanceof HTMLElement) sessUnarchBtn.hidden = !sessArchived;
                    }
                    const parentId = typeof activeRow.parentSessionId === "number" ? activeRow.parentSessionId : null;
                    const parentRow = parentId !== null ? rowById.get(parentId) : undefined;
                    if (parentLine instanceof HTMLElement && parentSlot instanceof HTMLElement && isRecord(parentRow) && typeof parentRow.name === "string") {
                        parentLine.hidden = false;
                        parentSlot.replaceChildren();
                        const parentHref = parentRow.origin === "model"
                            ? directoryPath({ kind: "session", workspace: currentWorkspaceName, session: parentRow.name })
                            : null;
                        if (parentHref !== null) {
                            const cloned = $.clone(parentSlot, "#session-parent-link");
                            const link = $(cloned, "a");
                            if (link instanceof HTMLAnchorElement) {
                                link.href = parentHref;
                                link.textContent = parentRow.name;
                                parentSlot.replaceChildren(link);
                            }
                        } else {
                            parentSlot.textContent = parentRow.name;
                        }
                    } else if (parentLine instanceof HTMLElement) {
                        parentLine.hidden = true;
                    }
                } else {
                    if (headingHandle instanceof HTMLElement) headingHandle.hidden = true;
                    if (parentLine instanceof HTMLElement) parentLine.hidden = true;
                    if (titleForm instanceof HTMLElement) titleForm.hidden = true;
                    if (noSessionNote instanceof HTMLElement) noSessionNote.hidden = false;
                }
            }
        } catch (error) {
            if (pageLifetime.signal.aborted || Reflect.get(Object(error), "status") === 401) return;
            const status = typeof Reflect.get(Object(error), "status") === "number"
                ? /** @type {number} */ (Reflect.get(Object(error), "status"))
                : 502;
            const { message, recovery } = await describeFailure(error);
            renderInPageError(main, status, message, recovery);
            return;
        }
    }

    const controller = createWorkspaceSettingsController(article, () => ({
        workspaceId,
        workspaceName: currentWorkspaceName,
        sessionName,
        signal: pageLifetime.signal,
    }), {
        updateHash: true,
        initialQuery: queryParams.get("q") ?? "",
        initialHelpFilter: queryParams.get("cmd") ?? "",
        initialEnvScope: queryParams.get("envScope") === "session" ? "session" : "workspace",
    });

    controller.selectSection(parseSettingsHash(location.hash), false);

    on.target(window, "hashchange", () => {
        controller.selectSection(parseSettingsHash(location.hash), false);
    });

    if (isPreseededFixture || workspaceId <= 0) return;

    const notifications = subscribeWorkspaceNotifications({
        workspaceId,
        onNotification(raw) {
            if (!isRecord(raw) || typeof raw.event !== "string" || !isRecord(raw.data)) return;
            const { event, data } = raw;
            const notifWorkspaceId = typeof raw.workspaceId === "number" ? raw.workspaceId : null;
            if (event === "workspace/renamed") {
                const id = typeof data.id === "number" ? data.id : notifWorkspaceId;
                const name = typeof data.name === "string" ? data.name : null;
                if (id !== workspaceId || name === null) return;
                currentWorkspaceName = name;
                main.dataset.workspaceName = name;
                the("page-title", `${name} · Settings — Plurnk`);
                const backLink = $("[data-settings-back]");
                const backPath = sessionName !== null
                    ? directoryPath({ kind: "session", workspace: name, session: sessionName })
                    : directoryPath({ kind: "workspace", workspace: name });
                if (backLink && backPath !== null) {
                    the(backLink, {
                        "workspace-name": name,
                        "workspace-back-path": backPath,
                    });
                }
                for (const input of $$('input[name="workspace"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden") {
                        input.value = name;
                    }
                }
                const nextSettingsPath = workspaceSettingsPath(name, sessionName, location.hash.slice(1) || null);
                if (nextSettingsPath !== null && typeof history === "object") {
                    history.replaceState(null, "", nextSettingsPath);
                }
                return;
            }
            if (notifWorkspaceId !== workspaceId && event !== "notifications/resync") return;
            if (event === "functionality/changed" && typeof data.family === "string") {
                controller.notifyChanged(data.family);
            } else if (event === "session/policy") {
                controller.notifyChanged("policy");
            } else if (event === "notifications/resync") {
                controller.notifyChanged("resync");
            }
        },
    });
    on.target(pageLifetime.signal, "abort", () => {
        notifications.unsubscribe();
    });
}
