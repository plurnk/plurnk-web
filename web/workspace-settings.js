import { $, $$, on, the } from "on_the_money";
import { directoryPath, settingsPath } from "../src/directory-addresses.js";
import { daemonPolicy, formatPageTitle, onDaemonPolicy, serviceVersion } from "./endpoints.js";
import renderInPageError from "./error-view.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import { subscribeWorkspaceNotifications } from "./workspace-notifications.js";
import { isRecord, parseWorkspaceList } from "./workspace-records.js";

/**
 * @typedef {"search" | "workspaces" | "sessions" | "models" | "mcp" | "skills" | "schedule" | "personas" | "members" | "env" | "help" | "about"} SettingsSection
 */

/** @typedef {import("./workspace-settings-families.js").WorkspaceFamily} WorkspaceFamily */
/** @typedef {import("./workspace-records.js").WorkspaceSettingsContext} WorkspaceSettingsContext */
/** @typedef {import("./workspace-records.js").WorkspaceSummary} WorkspaceSummary */

const SECTIONS = /** @type {const} */ ([
    "search",
    "workspaces",
    "sessions",
    "models",
    "mcp",
    "skills",
    "schedule",
    "personas",
    "members",
    "env",
    "help",
    "about",
]);
const FAMILY_SECTIONS = new Set(["mcp", "skills", "schedule", "personas", "members", "env"]);
const SUBSYSTEM_TEMPLATE_SECTIONS = new Set(["models", "mcp", "skills", "personas", "members", "env", "help"]);
const SERVICE_CAPABLE_SECTIONS = new Set(["models", "mcp", "skills", "personas", "env"]);

/** @typedef {"service" | "workspace" | "session"} SettingsScope */

/** @param {string | null} value @returns {SettingsScope | undefined} */
const parseScopeParam = (value) =>
    value === "service" || value === "workspace" || value === "session" ? value : undefined;

/** @param {unknown} value @returns {value is SettingsSection} */
export const isSettingsSection = (value) =>
    typeof value === "string" && /** @type {readonly string[]} */ (SECTIONS).includes(value);

/**
 * {§web-settings-extensions} Collect built-in and server-rendered host Settings section ids inside `#workspace-settings`.
 * @param {HTMLElement} article
 * @returns {Set<string>}
 */
function declaredSettingsSections(article) {
    /** @type {Set<string>} */
    const sections = new Set(SECTIONS);
    for (const item of $$(article, "[data-settings-section]")) {
        const raw = item.getAttribute("data-settings-section");
        if (raw !== null && raw !== "") sections.add(raw);
    }
    return sections;
}

/**
 * {§web-workspace-settings} {§web-settings-extensions} Mounts one active section panel inside `<article id="workspace-settings">`.
 * @param {HTMLElement} article
 * @param {() => WorkspaceSettingsContext} getContext
 * @param {{
 *   readonly activeSection?: string,
 *   readonly initialQuery?: string,
 *   readonly initialHelpFilter?: string,
 *   readonly initialScope?: SettingsScope,
 *   readonly initialEnvScope?: "service" | "workspace" | "session",
 *   readonly initialLoading?: boolean,
 *   readonly openCreate?: boolean,
 *   readonly preloadedWorkspaces?: readonly WorkspaceSummary[],
 * }} [options]
 */
export async function createWorkspaceSettingsController(article, getContext, {
    activeSection: suppliedSection,
    initialQuery = "",
    initialHelpFilter = "",
    initialScope,
    initialEnvScope = "workspace",
    initialLoading = false,
    openCreate = false,
    preloadedWorkspaces,
} = {}) {
    const declaredSections = declaredSettingsSections(article);
    const activeSection = suppliedSection ?? article.dataset.activeSection ?? "search";
    /** @type {Element | null} */
    let envPanel = null;
    let busy = false;
    let refreshDepth = initialLoading ? 1 : 0;
    let pendingInitialLoad = initialLoading;
    let mounted = false;

    /** @type {ReturnType<typeof import("./workspace-settings-session.js").mountWorkspaceAndSessionSettings> | null} */
    let sessionController = null;
    /** @type {ReturnType<typeof import("./workspace-settings-models.js").mountModelsHelpAboutSections> | null} */
    let modelsHelpAboutController = null;
    /** @type {ReturnType<typeof import("./workspace-settings-families.js").mountFamilyAndEnvSections> | null} */
    let familiesEnvController = null;
    /** @type {ReturnType<typeof import("./schedule-panel.js").mountSchedulePanel> | null} */
    let schedulePanelController = null;

    /** @param {string} kind @param {Record<string, unknown>} [params] @param {AbortSignal} [signal] */
    const invokeModelSearch = (kind, params = {}, signal) => {
        const ctx = getContext();
        const combinedSignal = signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal;
        return managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", combinedSignal, {
            workspaceId: ctx.workspaceId,
        });
    };

    function syncLoadingState() {
        the(article, "ws-settings-loading", busy || refreshDepth > 0 ? "true" : null);
    }

    /**
     * @param {boolean} nextBusy
     * @param {string} [message]
     * @param {string} [recovery]
     * @param {"idle" | "info" | "success" | "warning" | "error"} [level]
     */
    function setFeedback(nextBusy, message = "", recovery = "", level) {
        busy = nextBusy;
        const hasText = message.length > 0 || recovery.length > 0;
        const resolvedLevel = level ?? (!hasText ? "idle" : "info");
        const effectiveLevel = hasText ? resolvedLevel : "idle";
        the(article, {
            "ws-settings-loading": nextBusy || refreshDepth > 0 ? "true" : null,
            "ws-settings-busy": nextBusy ? "true" : null,
            "ws-settings-message": message,
            "ws-settings-recovery": recovery,
            "env-busy": nextBusy ? "" : null,
        });
        const feedbackBox = $(article, "[data-settings-feedback]");
        if (feedbackBox instanceof HTMLElement) {
            feedbackBox.dataset.feedbackLevel = effectiveLevel;
            feedbackBox.hidden = effectiveLevel === "idle";
            const urgent = effectiveLevel === "error" || effectiveLevel === "warning";
            feedbackBox.setAttribute("role", urgent ? "alert" : "status");
            feedbackBox.setAttribute("aria-live", urgent ? "assertive" : "polite");
            if (urgent && typeof feedbackBox.getBoundingClientRect === "function") {
                const rect = feedbackBox.getBoundingClientRect();
                if (rect.top < 0 || rect.bottom > window.innerHeight) {
                    feedbackBox.scrollIntoView?.({ block: "nearest" });
                }
            }
        }
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
        setFeedback(true, "Running…", "", "info");
        try {
            ctx.signal.throwIfAborted();
            const summary = await work(ctx.signal);
            ctx.signal.throwIfAborted();
            setFeedback(false, summary, "", "success");
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery, "error");
        }
    }

    /** @param {string} section */
    function isSectionAvailable(section) {
        if (!declaredSections.has(section)) return false;
        if (!isSettingsSection(section)) return true;
        const policy = daemonPolicy();
        if (FAMILY_SECTIONS.has(section) && Array.isArray(policy?.families) && !policy.families.includes(section)) {
            return false;
        }
        if (section === "members") {
            if (policy?.projectRoot === "none") return false;
            if (getContext().hasProjectRoot === false) return false;
        }
        return true;
    }

    /** @param {boolean} [usePreloaded] */
    async function refreshActiveSection(usePreloaded = false) {
        const releaseInitialLoad = () => {
            if (!pendingInitialLoad) return;
            pendingInitialLoad = false;
            refreshDepth = Math.max(0, refreshDepth - 1);
            syncLoadingState();
        };
        if (!isSectionAvailable(activeSection)) {
            const activePanel = $(article, `[data-settings-panel="${activeSection}"]`);
            if (activePanel instanceof HTMLElement) activePanel.hidden = true;
            if (!busy) setFeedback(false, "This settings section is unavailable for this workspace.", "", "warning");
            releaseInitialLoad();
            return;
        }
        const activePanel = $(article, `[data-settings-panel="${activeSection}"]`);
        if (activePanel instanceof HTMLElement) activePanel.hidden = false;

        if (!isSettingsSection(activeSection) || activeSection === "search") {
            if (!busy) setFeedback(false, "", "", "idle");
            releaseInitialLoad();
            return;
        }
        if (activeSection === "help") {
            modelsHelpAboutController?.applyHelpFilter();
            if (!busy) setFeedback(false, "", "", "idle");
            releaseInitialLoad();
            return;
        }
        if (activeSection === "about") {
            modelsHelpAboutController?.syncAboutPanel();
            if (serviceVersion() === null) {
                const ctx = getContext();
                await managementAction("workspace.list", {}, "", ctx.signal).catch(() => null);
                modelsHelpAboutController?.syncAboutPanel();
            }
            if (!busy) setFeedback(false, "", "", "idle");
            releaseInitialLoad();
            return;
        }
        const ctx = getContext();
        const allowsWithoutWorkspace = activeSection === "workspaces"
            || activeSection === "models"
            || (SERVICE_CAPABLE_SECTIONS.has(activeSection) && familiesEnvController?.currentScope() === "service");
        if (!allowsWithoutWorkspace && ctx.workspaceId <= 0) {
            if (!busy) setFeedback(false, "", "", "idle");
            releaseInitialLoad();
            return;
        }
        if (!busy) {
            setFeedback(false, "", "", "idle");
        }
        refreshDepth += 1;
        syncLoadingState();
        try {
            if (activeSection === "workspaces") {
                await sessionController?.loadWorkspacesSection(usePreloaded ? preloadedWorkspaces : undefined);
                return;
            }
            if (activeSection === "sessions") {
                await sessionController?.loadSessionsSection();
                return;
            }
            if (activeSection === "models") {
                await modelsHelpAboutController?.loadModelsCatalog();
                return;
            }
            if (activeSection === "env") {
                await familiesEnvController?.loadEnvSection();
                return;
            }
            await familiesEnvController?.loadFamilySection(activeSection);
            ctx.signal.throwIfAborted();
            if (activeSection === "schedule" && schedulePanelController) {
                void schedulePanelController.refreshAuxiliaryData();
            }
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            if (!busy) {
                setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery, "error");
            }
        } finally {
            refreshDepth = Math.max(0, refreshDepth - 1);
            if (pendingInitialLoad) {
                pendingInitialLoad = false;
                refreshDepth = Math.max(0, refreshDepth - 1);
            }
            syncLoadingState();
        }
    }

    function prefillScheduleTarget() {
        schedulePanelController?.prefillTarget();
    }

    function syncPolicyVisibility() {
        const policy = daemonPolicy();
        for (const item of $$(article, "[data-settings-section]")) {
            const raw = item.getAttribute("data-settings-section");
            if (raw === null || !declaredSections.has(raw)) continue;
            const navItem = item.parentElement;
            if (navItem instanceof HTMLElement) {
                navItem.hidden = !isSectionAvailable(raw);
            }
        }
        familiesEnvController?.applyDaemonPolicy(policy);
        const activePanel = $(article, `[data-settings-panel="${activeSection}"]`);
        if (!isSectionAvailable(activeSection)) {
            if (activePanel instanceof HTMLElement) activePanel.hidden = true;
            if (!busy) setFeedback(false, "This settings section is unavailable for this workspace.", "", "warning");
        } else if (activePanel instanceof HTMLElement) {
            activePanel.hidden = false;
        }
    }

    async function ensureMounted() {
        if (mounted) return;
        mounted = true;
        article.dataset.activeSection = activeSection;

        if (activeSection === "sessions") {
            const sessionConfigOutlet = $(article, "[data-session-config-outlet]");
            if (sessionConfigOutlet) {
                const clonedSessionCfg = $.clone(sessionConfigOutlet, "#session-config-controls", { position: "beforebegin" });
                if (clonedSessionCfg) sessionConfigOutlet.remove();
            }
        } else if (activeSection === "schedule") {
            const host = $(article, "[data-settings-subsystems]") ?? article;
            if (!$(article, '[data-settings-panel="schedule"]')) {
                const schedulePanel = $.clone(host, "#workspace-settings-schedule");
                if (schedulePanel instanceof HTMLElement) schedulePanel.hidden = false;
            }
        } else if (SUBSYSTEM_TEMPLATE_SECTIONS.has(activeSection)) {
            const host = $(article, "[data-settings-subsystems]") ?? article;
            if (!$(article, `[data-settings-panel="${activeSection}"]`)) {
                const panels = $.clone(host, "#workspace-settings-subsystems");
                if (panels instanceof HTMLElement) {
                    const outlet = $(panels, "[data-schedule-panel-outlet]");
                    outlet?.remove();
                    for (const panel of $$(panels, "[data-settings-panel]")) {
                        if (panel instanceof HTMLElement) {
                            if (panel.dataset.settingsPanel !== activeSection) {
                                panel.remove();
                            } else {
                                panel.hidden = false;
                            }
                        }
                    }
                }
            }
        }

        if (activeSection === "env") {
            const envOutlet = $(article, "[data-ws-env-outlet]");
            if (envOutlet && !envPanel) {
                envPanel = $.clone(envOutlet, "#command-env");
                const envSetForm = $(envPanel, "form[data-env-set-form]");
                const envFormOutlet = $(article, "[data-ws-env-form-outlet]");
                if (envSetForm && envFormOutlet) {
                    envFormOutlet.replaceWith(envSetForm);
                }
            }
        }

        if (activeSection === "workspaces" || activeSection === "sessions") {
            const { mountWorkspaceAndSessionSettings } = await import("./workspace-settings-session.js");
            if (getContext().signal.aborted) return;
            sessionController = mountWorkspaceAndSessionSettings(article, {
                getContext,
                invoke,
                runMutation,
                invokeModelSearch,
                refreshSessionsSection: () => refreshActiveSection(false),
                refreshWorkspacesSection: () => refreshActiveSection(false),
                openCreate,
            });
        } else if (activeSection === "models" || activeSection === "help" || activeSection === "about") {
            const { mountModelsHelpAboutSections } = await import("./workspace-settings-models.js");
            if (getContext().signal.aborted) return;
            modelsHelpAboutController = mountModelsHelpAboutSections(article, {
                getContext,
                invoke,
                runMutation,
                setFeedback,
                invokeModelSearch,
                initialQuery,
                initialHelpFilter,
                onRefreshModels: () => refreshActiveSection(false),
            });
        } else if (FAMILY_SECTIONS.has(activeSection)) {
            const [{ mountFamilyAndEnvSections }, scheduleMod] = await Promise.all([
                import("./workspace-settings-families.js"),
                activeSection === "schedule" ? import("./schedule-panel.js") : Promise.resolve(null),
            ]);
            if (getContext().signal.aborted) return;
            if (activeSection === "schedule" && scheduleMod) {
                const schedulePanelEl = $(article, '[data-settings-panel="schedule"]');
                if (schedulePanelEl instanceof HTMLElement) {
                    schedulePanelController = scheduleMod.mountSchedulePanel(schedulePanelEl, {
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
            }
            familiesEnvController = mountFamilyAndEnvSections(article, {
                getContext,
                invoke,
                runMutation,
                setFeedback,
                isBusy: () => busy,
                invokeModelSearch,
                envPanel,
                activeFamily: activeSection,
                initialScope: initialScope ?? (activeSection === "env" ? initialEnvScope : undefined),
                onRenderScheduleList: (res) => { schedulePanelController?.renderList(res); },
                onRefreshSection: () => refreshActiveSection(false),
                onRefreshEnv: () => refreshActiveSection(false),
            });
        }

        const offPolicy = onDaemonPolicy(() => { syncPolicyVisibility(); });
        syncPolicyVisibility();

        const navigateClose = () => {
            const closeLink = $(article, "a[data-settings-close]");
            const href = closeLink instanceof HTMLAnchorElement ? closeLink.getAttribute("href") : null;
            if (href) location.assign(href);
        };

        const offEscape = on.target(document, "keydown", (event) => {
            if (!(event instanceof KeyboardEvent) || event.key !== "Escape" || event.defaultPrevented) return;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if ($("dialog[open]") || $(article, '[role="combobox"][aria-expanded="true"]')) return;
            const target = event.target;
            if (
                target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || target instanceof HTMLSelectElement
                || (target instanceof HTMLElement && target.isContentEditable)
            ) {
                return;
            }
            event.preventDefault();
            navigateClose();
        });

        const settingsMain = article.closest('main[data-page="settings"]');
        const offBackdrop = on.target(document, "click", (event) => {
            if (!(event instanceof MouseEvent) || event.button !== 0 || event.defaultPrevented) return;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (settingsMain && event.target === settingsMain) {
                navigateClose();
            }
        });

        on.target(getContext().signal, "abort", () => {
            offPolicy();
            offEscape();
            offBackdrop();
            sessionController?.dispose();
            modelsHelpAboutController?.dispose();
            familiesEnvController?.dispose();
            schedulePanelController?.dispose();
        });

        on(article, "click", "[data-feedback-dismiss]", () => {
            if (!busy) setFeedback(false, "", "", "idle");
        });

        on(article, "click", "details[data-family-disclosure] > summary", (_event, summary) => {
            if (!busy) setFeedback(false, "", "", "idle");
            const details = summary.parentElement;
            if (details instanceof HTMLDetailsElement && details.dataset.familyDisclosure === "schedule" && !details.open) {
                prefillScheduleTarget();
            }
        });
    }

    await ensureMounted();

    return {
        /** Hydrate the mounted active section and dispatch `plurnk:settings-section`. */
        open() {
            if (activeSection === "schedule") prefillScheduleTarget();
            const ctx = getContext();
            // {§web-settings-extensions} Notify host extension scripts of the active section alongside `data-active-section`.
            article.dispatchEvent(new CustomEvent("plurnk:settings-section", {
                detail: {
                    section: activeSection,
                    workspaceName: ctx.workspaceName,
                    sessionName: ctx.sessionName,
                },
            }));
            void refreshActiveSection(true);
        },
        /** @param {string} familyOrTopic */
        notifyChanged(familyOrTopic) {
            if (busy || !isSettingsSection(activeSection) || activeSection === "search" || activeSection === "help" || activeSection === "about") return;
            if (
                familyOrTopic === "resync"
                || familyOrTopic === activeSection
                || (familyOrTopic === "config" && activeSection === "models")
                || (familyOrTopic === "workspaces" && activeSection === "workspaces")
                || (familyOrTopic === "sessions" && activeSection === "sessions")
                || (familyOrTopic === "policy" && (activeSection === "sessions" || activeSection === "models"))
                || (familyOrTopic === "personas" && (activeSection === "sessions" || activeSection === "schedule"))
                || (familyOrTopic === "mcp" && activeSection === "schedule")
            ) {
                void refreshActiveSection(false);
            }
        },
    };
}

/**
 * {§web-workspace-settings} {§web-search} Path-based `/settings/<section>` hub entrypoint loaded over `/acp`.
 * @param {HTMLElement} main
 */
export default async function observeWorkspaceSettings(main) {
    const rawArticle = $(main, "#workspace-settings");
    if (!(rawArticle instanceof HTMLElement)) {
        throw new Error("Workspace settings article is missing.");
    }
    const article = rawArticle;

    const pageLifetime = new AbortController();
    on.target(window, "pagehide", (event) => {
        if (!(event instanceof PageTransitionEvent) || !event.persisted) {
            pageLifetime.abort();
        }
    });

    const queryParams = new URLSearchParams(location.search);
    const activeSection = article.dataset.activeSection || main.dataset.settingsSection || "search";
    const openCreate = main.dataset.openCreate === "true" || queryParams.get("new") === "1";
    const preseededWorkspaceId = main.dataset.workspaceId ?? "";
    const isPreseededFixture = /^[1-9]\d*$/u.test(preseededWorkspaceId) && main.dataset.live !== "true";
    const initialScope = parseScopeParam(queryParams.get("scope"))
        ?? (activeSection === "env" ? parseScopeParam(queryParams.get("envScope")) : undefined);
    const tracksInitialLoad = !isPreseededFixture && !(activeSection === "search" && (queryParams.get("workspace") ?? main.dataset.workspaceName ?? "") === "");
    if (tracksInitialLoad) {
        the(article, "ws-settings-loading", "true");
    }

    let workspaceId = isPreseededFixture ? Number(preseededWorkspaceId) : 0;
    let currentWorkspaceName = queryParams.get("workspace") ?? main.dataset.workspaceName ?? "";
    let sessionName = queryParams.get("session") || main.dataset.sessionName || null;
    /** @type {boolean | null} */
    let hasProjectRoot = main.dataset.hasProjectRoot === "false"
        ? false
        : main.dataset.hasProjectRoot === "true"
            ? true
            : null;
    /** @type {WorkspaceSummary[] | undefined} */
    let preloadedWorkspaces;

    const sectionLabel = $(article, `[data-settings-section="${activeSection}"]`)?.textContent?.trim() || activeSection;

    /**
     * @param {string} wsName
     * @param {string | null} sessName
     * @param {{ icon?: string, iconLabel?: string }} [marker]
     */
    function syncNavigationLinks(wsName, sessName, marker) {
        const searchHref = settingsPath("search", { workspace: wsName || null, session: sessName }) ?? "/settings/search";
        const searchNav = $('header a[data-nav="search"]');
        if (searchNav instanceof HTMLAnchorElement) {
            the(searchNav, { "search-settings-path": searchHref });
            if (activeSection === "search") searchNav.setAttribute("aria-current", "page");
            else searchNav.removeAttribute("aria-current");
        }
        for (const tabLink of $$(article, "ul[data-settings-nav] a[data-settings-section]")) {
            if (!(tabLink instanceof HTMLAnchorElement)) continue;
            const sec = tabLink.dataset.settingsSection;
            if (!sec) continue;
            const nextHref = settingsPath(sec, { workspace: wsName || null, session: sessName }) ?? `/settings/${sec}`;
            if (tabLink.getAttribute("href") !== nextHref) tabLink.setAttribute("href", nextHref);
        }
        const backLink = $("[data-settings-back]");
        const closeLink = $(article, "[data-settings-close]");
        if (wsName) {
            const backPath = sessName !== null
                ? directoryPath({ kind: "session", workspace: wsName, session: sessName })
                : directoryPath({ kind: "workspace", workspace: wsName });
            if (backPath !== null) {
                if (backLink) {
                    the(backLink, {
                        "workspace-name": wsName,
                        "workspace-back-path": backPath,
                        ...(marker?.icon ? { "workspace-icon": marker.icon } : {}),
                        ...(marker?.iconLabel ? { "workspace-icon-label": marker.iconLabel } : {}),
                    });
                }
                if (closeLink) {
                    the(closeLink, { "workspace-back-path": backPath });
                }
            }
            const backSess = backLink ? $(backLink, "[data-settings-back-session]") : null;
            if (sessName !== null && backSess instanceof HTMLElement) {
                backSess.hidden = false;
                the(backSess, "active-session-name", sessName);
            } else if (backSess instanceof HTMLElement) {
                backSess.hidden = true;
            }
        }
    }

    if (!isPreseededFixture && !(activeSection === "search" && currentWorkspaceName === "")) {
        if (currentWorkspaceName !== "" && directoryPath({ kind: "workspace", workspace: currentWorkspaceName }) === null) {
            renderInPageError(main, 404, "Workspace not found.");
            return;
        }
        try {
            const listedWorkspaces = parseWorkspaceList(
                await managementAction("workspace.list", { includeArchived: true }, "", pageLifetime.signal),
            );
            if (pageLifetime.signal.aborted) return;
            preloadedWorkspaces = listedWorkspaces;

            const matchedWorkspace = currentWorkspaceName !== ""
                ? listedWorkspaces.find(({ name }) => name === currentWorkspaceName)
                : (listedWorkspaces.find(({ archivedAt }) => archivedAt === null) ?? listedWorkspaces[0]);

            if (!matchedWorkspace) {
                const allowWithoutWorkspace = activeSection === "search"
                    || activeSection === "workspaces"
                    || activeSection === "models"
                    || activeSection === "help"
                    || activeSection === "about"
                    || (SERVICE_CAPABLE_SECTIONS.has(activeSection) && initialScope === "service")
                    || !isSettingsSection(activeSection);
                if (currentWorkspaceName !== "" || !allowWithoutWorkspace) {
                    renderInPageError(main, 404, "Workspace not found.");
                    return;
                }
                syncNavigationLinks("", null);
                const activeWsCard = $(article, "[data-active-workspace-card]");
                if (activeWsCard instanceof HTMLElement) activeWsCard.hidden = true;
            } else {
                workspaceId = matchedWorkspace.id;
                currentWorkspaceName = matchedWorkspace.name;
                hasProjectRoot = matchedWorkspace.projectRoot !== null;
                main.dataset.workspaceId = String(workspaceId);
                main.dataset.workspaceName = currentWorkspaceName;
                main.dataset.hasProjectRoot = String(hasProjectRoot);
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
                    }
                }
                const activeRow = sessionName
                    ? (rawRows.find((r) => isRecord(r) && r.name === sessionName && r.origin === "model") ?? null)
                    : null;
                if (!activeRow) sessionName = null;
                main.dataset.sessionName = sessionName ?? "";

                const explicitWorkspace = queryParams.get("workspace") !== null && queryParams.get("workspace") !== "";
                if (explicitWorkspace || activeSection !== "search") {
                    the("page-title", formatPageTitle(`${currentWorkspaceName} · ${sectionLabel}`));
                }
                syncNavigationLinks(currentWorkspaceName, sessionName, { icon: iconGlyph, iconLabel });

                const activeWsCard = $(article, "[data-active-workspace-card]");
                if (activeWsCard instanceof HTMLElement) activeWsCard.hidden = false;

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
                const addSessionDisclosure = $(article, "[data-settings-add-session]");
                if (addSessionDisclosure instanceof HTMLElement) addSessionDisclosure.hidden = wsArchived;

                for (const input of $$('input[name="workspace"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden" && !input.closest("[data-workspace-row-form]")) {
                        input.value = currentWorkspaceName;
                    }
                }
                for (const input of $$('input[name="session"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden" && !input.closest("[data-session-row-form]")) {
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
    } else {
        syncNavigationLinks(currentWorkspaceName, sessionName);
    }

    const controller = await createWorkspaceSettingsController(article, () => ({
        workspaceId,
        workspaceName: currentWorkspaceName,
        sessionName,
        hasProjectRoot,
        signal: pageLifetime.signal,
    }), {
        activeSection,
        initialQuery: queryParams.get("q") ?? "",
        initialHelpFilter: queryParams.get("cmd") ?? "",
        initialScope,
        initialEnvScope: parseScopeParam(queryParams.get("envScope")) ?? "workspace",
        initialLoading: tracksInitialLoad,
        openCreate,
        preloadedWorkspaces,
    });
    if (pageLifetime.signal.aborted) return;

    controller.open();

    if (activeSection === "search") {
        const searchPanel = $(article, '[data-settings-panel="search"]');
        if (searchPanel instanceof HTMLElement) {
            const { default: observeOverview } = await import("./overview.js");
            const overviewHandle = observeOverview(searchPanel, {
                connectionTarget: main,
                contextWorkspace: currentWorkspaceName,
                contextSession: sessionName,
            });
            on.target(pageLifetime.signal, "abort", () => {
                overviewHandle.dispose();
            });
        }
        return;
    }

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
                the("page-title", formatPageTitle(`${name} · ${sectionLabel}`));
                syncNavigationLinks(name, sessionName);
                for (const input of $$('input[name="workspace"]')) {
                    if (input instanceof HTMLInputElement && input.type === "hidden" && !input.closest("[data-workspace-row-form]")) {
                        input.value = name;
                    }
                }
                const nextSettingsPath = settingsPath(activeSection, { workspace: name, session: sessionName });
                if (nextSettingsPath !== null && typeof history === "object") {
                    history.replaceState(null, "", nextSettingsPath);
                }
                controller.notifyChanged("workspaces");
                return;
            }
            if (event === "config/changed") {
                controller.notifyChanged("config");
                return;
            }
            if (event === "workspace/created" || event === "workspace/archived") {
                controller.notifyChanged("workspaces");
                return;
            }
            if (event === "functionality/changed" && typeof data.family === "string" && notifWorkspaceId === null) {
                controller.notifyChanged(data.family);
                return;
            }
            if (notifWorkspaceId !== workspaceId && event !== "notifications/resync") return;
            if (event === "session/created" || event === "session/archived" || event === "session/deleted" || event === "session/titled") {
                controller.notifyChanged("sessions");
            } else if (event === "functionality/changed" && typeof data.family === "string") {
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
