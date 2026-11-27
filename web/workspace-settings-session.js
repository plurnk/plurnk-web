import { $, on, the } from "on_the_money";
import { directoryPath, nextSequentialName } from "../src/directory-addresses.js";
import { attachModelCombobox } from "./combobox.js";
import { createModelEffortSync } from "./effort-select.js";
import managementAction from "./management-action.js";
import { createModelSearchCache, flattenSelectOptions, listModels, modelLabel, sessionConfigOption, sessionEffort, sessionModel } from "./session-models.js";
import { isUntouchedDraftSession, orderByReply } from "./session-selection.js";
import { isRecord } from "./session-translator.js";
import { COLLECTION_PAGE_SIZE, mountCollectionBar } from "./workspace-collection.js";
import { parseWorkspaceList, wireWorkspaceCreateForm } from "./workspace-records.js";

/** @typedef {import("./workspace-records.js").WorkspaceSettingsContext} WorkspaceSettingsContext */
/** @typedef {import("./workspace-records.js").WorkspaceSummary} WorkspaceSummary */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

/**
 * @typedef {{
 *   readonly id: number,
 *   readonly name: string,
 *   readonly title: string | null,
 *   readonly kind: "root" | "work" | "fork",
 *   readonly lifecycle: string,
 *   readonly parentName: string | null,
 *   readonly archived: boolean,
 * }} SessionDirectoryRow
 */

const ARCHIVE_STATE_OPTIONS = Object.freeze([
    { value: "active", label: "Active" },
    { value: "archived", label: "Archived" },
    { value: "all", label: "All" },
]);

/**
 * @template T
 * @param {readonly T[]} items
 * @param {ReturnType<typeof mountCollectionBar>} bar
 * @returns {readonly T[]}
 */
function paginateLocalCollection(items, bar) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const params = bar.getParams();
        const rawOffset = typeof params.offset === "number" ? params.offset : 0;
        const limit = typeof params.limit === "number" ? params.limit : COLLECTION_PAGE_SIZE;
        const page = items.slice(rawOffset, rawOffset + limit);
        const nextOffset = rawOffset + page.length < items.length ? rawOffset + page.length : undefined;
        const applied = bar.applyResult({
            definitions: page,
            offset: rawOffset,
            total: items.length,
            ...(nextOffset !== undefined ? { nextOffset } : {}),
        });
        if (!applied.clamped) return page;
    }
    return items.slice(0, COLLECTION_PAGE_SIZE);
}

/**
 * {§web-workspace-settings} {§web-workspace-creation} {§web-workspace-rename} {§web-workspace-archive} {§web-session-creation} {§web-session-archive}
 * Mount the standardized `workspaces` and `sessions` panels (inline creation disclosure, active-item card, and filterable/paginated table).
 * @param {HTMLElement} article
 * @param {{
 *   readonly getContext: () => WorkspaceSettingsContext,
 *   readonly invoke: (kind: string, params?: Record<string, unknown>, opts?: { requireSession?: boolean }) => Promise<unknown>,
 *   readonly runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   readonly invokeModelSearch: (kind: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
 *   readonly refreshSessionsSection: () => Promise<void>,
 *   readonly refreshWorkspacesSection: () => Promise<void>,
 *   readonly openCreate?: boolean,
 * }} host
 */
export function mountWorkspaceAndSessionSettings(article, {
    getContext,
    invoke,
    runMutation,
    invokeModelSearch,
    refreshSessionsSection,
    refreshWorkspacesSection,
    openCreate = false,
}) {
    const modelSearchCache = createModelSearchCache(invokeModelSearch);
    const wsPanel = $(article, '[data-settings-panel="workspaces"]');
    const sessionsPanel = $(article, '[data-settings-panel="sessions"]');

    /** @type {WorkspaceSummary[]} */
    let cachedWorkspaces = [];
    /** @type {SessionDirectoryRow[]} */
    let cachedSessions = [];
    /** @type {Set<string>} */
    const knownSessionNames = new Set();

    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let sessionModelCombobox = null;
    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let sessionSpawnCombobox = null;
    /** @type {{ model: string, effort: string, childModel: string, persona: string, mode: string }} */
    let currentSessionValues = { model: "", effort: "", childModel: "inherit", persona: "none", mode: "review" };
    let lastSelectedComboboxModel = "";
    let hasPersistedSessionModel = false;

    const offWsCreate = wsPanel instanceof HTMLElement
        ? wireWorkspaceCreateForm(wsPanel, {
            signal: getContext().signal,
            getKnownWorkspaceNames: () => cachedWorkspaces.map(({ name }) => name),
            runMutation,
        })
        : () => {};

    const wsCollectionBar = wsPanel instanceof HTMLElement
        ? mountCollectionBar(wsPanel, {
            label: "workspaces",
            stateOptions: ARCHIVE_STATE_OPTIONS,
            initialState: "active",
            onChange: () => { renderWorkspacesTable(); },
            signal: getContext().signal,
        })
        : null;

    const sessCollectionBar = sessionsPanel instanceof HTMLElement
        ? mountCollectionBar(sessionsPanel, {
            label: "sessions",
            stateOptions: ARCHIVE_STATE_OPTIONS,
            initialState: "active",
            onChange: () => { renderSessionsTable(); },
            signal: getContext().signal,
        })
        : null;

    const effortSync = createModelEffortSync({
        getSelect: () => {
            const el = $(article, '[data-session-config-form] select[name="effort"]');
            return el instanceof HTMLSelectElement ? el : null;
        },
        getCache: () => modelSearchCache,
        getSelectedModel: () => sessionModelCombobox?.getValue() ?? "",
        getSignal: () => getContext().signal,
    });

    const sessionModelBox = $(article, '[data-session-config-form] [data-model-combobox="model"]');
    if (sessionModelBox instanceof HTMLElement) {
        sessionModelCombobox = attachModelCombobox(sessionModelBox, {
            getCache: () => modelSearchCache,
            signal: getContext().signal,
            onSelect: (selector, choice) => {
                const effortField = $(article, '[data-session-config-form] select[name="effort"]');
                if (effortField instanceof HTMLSelectElement) {
                    const preferred = selector === lastSelectedComboboxModel ? effortField.value : "";
                    lastSelectedComboboxModel = selector;
                    effortSync.sync(selector, preferred, choice?.efforts, choice?.defaultEffort);
                }
            },
        });
    }

    const sessionSpawnBox = $(article, '[data-session-config-form] [data-model-combobox="childModel"]');
    if (sessionSpawnBox instanceof HTMLElement) {
        sessionSpawnCombobox = attachModelCombobox(sessionSpawnBox, {
            getCache: () => modelSearchCache,
            includeInherit: true,
            signal: getContext().signal,
        });
    }

    function focusCreateDisclosureIfRequested() {
        if (!openCreate) return;
        if (wsPanel instanceof HTMLElement) {
            const disclosure = $(wsPanel, 'details[data-family-disclosure="workspaces"]');
            const input = $(wsPanel, 'form#workspace-create input[name="name"]');
            if (disclosure instanceof HTMLDetailsElement && !disclosure.hidden) {
                disclosure.open = true;
                if (input instanceof HTMLInputElement) input.focus();
            }
        }
        if (sessionsPanel instanceof HTMLElement) {
            const disclosure = $(sessionsPanel, 'details[data-family-disclosure="sessions"]');
            const input = $(sessionsPanel, 'form#session-create input[name="name"]');
            if (disclosure instanceof HTMLDetailsElement && !disclosure.hidden) {
                disclosure.open = true;
                if (input instanceof HTMLInputElement) input.focus();
            }
        }
    }

    function renderWorkspacesTable() {
        if (!(wsPanel instanceof HTMLElement) || !wsCollectionBar) return;
        const tbody = $(wsPanel, "[data-workspaces-rows]");
        if (!tbody) return;
        const ctx = getContext();
        const params = wsCollectionBar.getParams();
        const stateFilter = typeof params.state === "string" ? params.state : "active";
        const needle = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";

        const filtered = cachedWorkspaces.filter((ws) => {
            const isArchived = ws.archivedAt !== null;
            if (stateFilter === "active" && isArchived) return false;
            if (stateFilter === "archived" && !isArchived) return false;
            if (!needle) return true;
            const hay = `${ws.name}\n${ws.projectLabel ?? ""}\n${ws.projectRoot ?? ""}`.toLowerCase();
            return hay.includes(needle);
        });
        const page = paginateLocalCollection(filtered, wsCollectionBar);
        $.cloneEach(tbody, "#workspace-directory-row", page, (tr, ws) => {
            const isArchived = ws.archivedAt !== null;
            const effectiveFolder = ws.projectLabel ?? ws.projectRoot;
            const wsPath = directoryPath({ kind: "workspace", workspace: ws.name }) ?? "/";
            the(tr, {
                "ws-row-id": String(ws.id),
                "ws-row-name": ws.name,
                "ws-row-glyph": effectiveFolder !== null ? "🗂️" : "☁️",
                "ws-row-path": wsPath,
                "ws-row-folder": effectiveFolder ?? "Folderless",
                "ws-row-state": isArchived ? "Archived" : "Active",
                "ws-row-archived": isArchived ? "true" : "false",
                "ws-row-current": ws.name === ctx.workspaceName ? "true" : "false",
            });
        });
        the(wsPanel, { "collection-count": page.length });
    }

    /** @param {readonly WorkspaceSummary[]} [preloaded] */
    async function loadWorkspacesSection(preloaded) {
        if (!(wsPanel instanceof HTMLElement)) return;
        const ctx = getContext();
        const workspaces = preloaded !== undefined
            ? [...preloaded]
            : parseWorkspaceList(await managementAction("workspace.list", { includeArchived: true }, "", ctx.signal));
        ctx.signal.throwIfAborted();
        cachedWorkspaces = workspaces;
        const current = cachedWorkspaces.find(({ id, name }) =>
            (ctx.workspaceId > 0 && id === ctx.workspaceId) || (ctx.workspaceName !== "" && name === ctx.workspaceName));
        if (current) {
            const wsArchived = current.archivedAt !== null;
            if (wsArchived) article.dataset.workspaceArchived = "true";
            else delete article.dataset.workspaceArchived;
            const wsArchBtn = $(wsPanel, "[data-workspace-archive-btn]");
            const wsUnarchBtn = $(wsPanel, "[data-workspace-unarchive-btn]");
            if (wsArchBtn instanceof HTMLElement) wsArchBtn.hidden = wsArchived;
            if (wsUnarchBtn instanceof HTMLElement) wsUnarchBtn.hidden = !wsArchived;
        }
        renderWorkspacesTable();
    }

    function renderSessionsTable() {
        if (!(sessionsPanel instanceof HTMLElement) || !sessCollectionBar) return;
        const tbody = $(sessionsPanel, "[data-sessions-rows]");
        if (!tbody) return;
        const ctx = getContext();
        const params = sessCollectionBar.getParams();
        const stateFilter = typeof params.state === "string" ? params.state : "active";
        const needle = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";

        const filtered = cachedSessions.filter((row) => {
            if (stateFilter === "active" && row.archived) return false;
            if (stateFilter === "archived" && !row.archived) return false;
            if (!needle) return true;
            const hay = `#${row.name}\n${row.name}\n${row.title ?? ""}\n${row.kind}\n${row.lifecycle}`.toLowerCase();
            return hay.includes(needle);
        });
        const page = paginateLocalCollection(filtered, sessCollectionBar);
        $.cloneEach(tbody, "#session-directory-row", page, (tr, row) => {
            const label = row.title ? `${row.title} (#${row.name})` : `#${row.name}`;
            const details = [
                row.kind !== "root" ? row.kind : "",
                row.parentName ? `parent: #${row.parentName}` : "",
            ].filter(Boolean).join(" · ") || "root";
            const sessPath = directoryPath({ kind: "session", workspace: ctx.workspaceName, session: row.name }) ?? "/";
            the(tr, {
                "sess-row-name": row.name,
                "sess-row-label": label,
                "sess-row-path": sessPath,
                "sess-row-details": details,
                "sess-row-state": row.archived ? "archived" : row.lifecycle,
                "sess-row-archived": row.archived ? "true" : "false",
                "sess-row-current": row.name === ctx.sessionName ? "true" : "false",
                "session-kind": row.kind,
            });
        });
        the(sessionsPanel, { "collection-count": page.length });
    }

    /**
     * @param {unknown} sessionRes
     * @param {readonly import("./session-models.js").ModelAliasEntry[]} aliases
     * @param {readonly import("@plurnk/plurnk-contracts").ModelCatalogEntry[]} catalogItems
     */
    function renderSessionConfigControls(sessionRes, aliases, catalogItems) {
        const form = $(article, "form[data-session-config-form]");
        const effortSelect = form ? $(form, 'select[name="effort"]') : null;
        const personaSelect = form ? $(form, 'select[name="persona"]') : null;
        const modeSelect = form ? $(form, 'select[name="mode"]') : null;
        if (!(form instanceof HTMLFormElement)
            || !sessionModelCombobox
            || !sessionSpawnCombobox
            || !(effortSelect instanceof HTMLSelectElement)
            || !(personaSelect instanceof HTMLSelectElement)
            || !(modeSelect instanceof HTMLSelectElement)) {
            return;
        }
        if (getContext().sessionName === null || !isRecord(sessionRes) || !Array.isArray(sessionRes.configOptions)) {
            form.hidden = true;
            return;
        }
        const modelOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "model");
        const thoughtOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "thought_level");
        const childOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "child");
        const personaOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "persona");
        const modeOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "mode");

        modelSearchCache.recordAliases(aliases);
        modelSearchCache.recordCatalogItems(catalogItems);

        const thoughtSupported = isRecord(thoughtOption)
            ? flattenSelectOptions(thoughtOption.options).flatMap((entry) => typeof entry.value === "string" && entry.value ? [entry.value] : [])
            : [];
        const currentModel = isRecord(modelOption) && typeof modelOption.currentValue === "string" && modelOption.currentValue && modelOption.currentValue !== "none"
            ? modelOption.currentValue
            : "";
        if (currentModel && thoughtSupported.length > 0) {
            modelSearchCache.seedEfforts(currentModel, thoughtSupported);
        }

        const plurnkMeta = isRecord(sessionRes._meta) && isRecord(sessionRes._meta.plurnk) ? sessionRes._meta.plurnk : null;
        const metaStatus = isRecord(plurnkMeta?.status) ? plurnkMeta.status : null;
        hasPersistedSessionModel = metaStatus !== null && Object.hasOwn(metaStatus, "model")
            ? metaStatus.model !== null
            : Boolean(currentModel);

        const resolvedModel = currentModel || (aliases.find((a) => a.active)?.alias ?? aliases[0]?.alias ?? "");
        lastSelectedComboboxModel = resolvedModel;
        sessionModelCombobox.setValue(resolvedModel);

        const currentEffort = isRecord(thoughtOption) && typeof thoughtOption.currentValue === "string" ? thoughtOption.currentValue : "";
        const resolvedEffort = effortSync.sync(resolvedModel, currentEffort);

        const currentChild = isRecord(childOption) && typeof childOption.currentValue === "string" && childOption.currentValue
            ? childOption.currentValue
            : "inherit";
        sessionSpawnCombobox.setValue(currentChild);

        const rawPersonaOptions = isRecord(personaOption) ? flattenSelectOptions(personaOption.options) : [];
        const personaChoices = rawPersonaOptions.length > 0
            ? rawPersonaOptions.flatMap((entry) => {
                if (typeof entry.value !== "string" || typeof entry.name !== "string") return [];
                const desc = typeof entry.description === "string" && entry.description.length > 0 ? ` — ${entry.description}` : "";
                return [{ value: entry.value, label: `${entry.name}${desc}` }];
            })
            : [{ value: "none", label: "None (default)" }];
        const currentPersona = isRecord(personaOption) && typeof personaOption.currentValue === "string" && personaOption.currentValue
            ? personaOption.currentValue
            : "none";
        $.cloneEach(personaSelect, "#setting-option", personaChoices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        personaSelect.value = personaChoices.some((c) => c.value === currentPersona) ? currentPersona : "none";

        const fallbackModes = [
            { value: "review", label: "Ask before external mutations (review)" },
            { value: "accept", label: "Auto-approve all operations (accept)" },
            { value: "reject", label: "Deny gated operations (reject)" },
        ];
        const rawModeOptions = isRecord(modeOption) ? flattenSelectOptions(modeOption.options) : [];
        const modeChoices = rawModeOptions.length > 0
            ? rawModeOptions.flatMap((entry) =>
                typeof entry.value === "string" && typeof entry.name === "string"
                    ? [{ value: entry.value, label: `${entry.name} (${entry.value})` }]
                    : [])
            : fallbackModes;
        $.cloneEach(modeSelect, "#setting-option", modeChoices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        const currentMode = isRecord(modeOption) && typeof modeOption.currentValue === "string" && modeOption.currentValue
            ? modeOption.currentValue
            : "review";
        const resolvedMode = modeChoices.some((c) => c.value === currentMode) ? currentMode : (modeChoices[0]?.value ?? "review");
        modeSelect.value = resolvedMode;

        currentSessionValues = {
            model: resolvedModel,
            effort: resolvedEffort,
            childModel: currentChild,
            persona: personaSelect.value,
            mode: resolvedMode,
        };
        form.hidden = false;
    }

    async function hydrateSessionConfig() {
        const ctx = getContext();
        if (ctx.sessionName === null) {
            renderSessionConfigControls(null, [], []);
            return;
        }
        const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
            managementAction(kind, params, `${ctx.workspaceId}#${ctx.sessionName}`, ctx.signal, {
                workspaceId: ctx.workspaceId,
            });
        const [{ aliases, catalog }, sessionRes] = await Promise.all([
            listModels(callSession),
            callSession("session/options"),
        ]);
        ctx.signal.throwIfAborted();
        renderSessionConfigControls(sessionRes, aliases, catalog.items);
    }

    async function loadSessionsSection() {
        if (!(sessionsPanel instanceof HTMLElement)) return;
        const ctx = getContext();
        if (ctx.workspaceId <= 0) {
            cachedSessions = [];
            renderSessionsTable();
            renderSessionConfigControls(null, [], []);
            return;
        }
        const [sessionsRes] = await Promise.all([
            managementAction("workspace.sessions", {
                workspaceId: ctx.workspaceId,
                includeArchived: true,
            }, "", ctx.signal, { workspaceId: ctx.workspaceId }),
            ctx.sessionName !== null ? hydrateSessionConfig() : Promise.resolve(),
        ]);
        ctx.signal.throwIfAborted();
        const rawRows = isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions) ? sessionsRes.sessions : [];
        /** @type {Map<number, Record<string, unknown>>} */
        const rowById = new Map();
        knownSessionNames.clear();
        for (const row of rawRows) {
            if (isRecord(row) && typeof row.id === "number") {
                rowById.set(row.id, row);
                if (typeof row.name === "string") knownSessionNames.add(row.name);
            }
        }
        /** @type {SessionDirectoryRow[]} */
        const nextSessions = [];
        for (const row of rawRows) {
            if (!isRecord(row) || typeof row.id !== "number" || typeof row.name !== "string") continue;
            if (row.origin !== "model") continue;
            const parentId = typeof row.parentSessionId === "number" ? row.parentSessionId : null;
            const parentRow = parentId !== null ? rowById.get(parentId) : undefined;
            const rawKind = row.kind === "root" || row.kind === "work" || row.kind === "fork"
                ? row.kind
                : (parentId === null ? "root" : "work");
            nextSessions.push({
                id: row.id,
                name: row.name,
                title: typeof row.title === "string" && row.title.trim() !== "" ? row.title.trim() : null,
                kind: rawKind,
                lifecycle: typeof row.lifecycle === "string" ? row.lifecycle : "idle",
                parentName: isRecord(parentRow) && typeof parentRow.name === "string" ? parentRow.name : null,
                archived: row.archivedAt !== null && row.archivedAt !== undefined,
            });
        }
        cachedSessions = nextSessions.toSorted((a, b) => b.id - a.id);
        const activeRow = ctx.sessionName !== null ? cachedSessions.find(({ name }) => name === ctx.sessionName) : null;
        if (activeRow) {
            const sessArchBtn = $(sessionsPanel, "[data-session-archive-btn]");
            const sessUnarchBtn = $(sessionsPanel, "[data-session-unarchive-btn]");
            if (sessArchBtn instanceof HTMLElement) sessArchBtn.hidden = activeRow.archived;
            if (sessUnarchBtn instanceof HTMLElement) sessUnarchBtn.hidden = !activeRow.archived;
        }
        renderSessionsTable();
    }

    on(article, "submit", "form#workspace-rename", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const newName = String(new FormData(form).get("name") ?? "").trim();
        if (!newName) return;
        void runMutation(async () => {
            const ctx = getContext();
            const renamed = await invoke("workspace.rename", { workspaceId: ctx.workspaceId, name: newName });
            const resolvedName = isRecord(renamed) && typeof renamed.name === "string" && renamed.name !== ""
                ? renamed.name
                : newName;
            const dest = ctx.sessionName !== null
                ? directoryPath({ kind: "session", workspace: resolvedName, session: ctx.sessionName })
                : directoryPath({ kind: "workspace", workspace: resolvedName });
            if (dest === null) throw new Error("The daemon returned a workspace name without a directory address.");
            location.assign(dest);
            return `Renamed workspace to ${resolvedName}.`;
        });
    });

    on(article, "submit", "form#workspace-archive", (event) => {
        event.preventDefault();
        void runMutation(async () => {
            const ctx = getContext();
            await invoke("workspace.archive", { workspaceId: ctx.workspaceId, archived: true });
            location.assign("/");
            return "Workspace archived.";
        });
    });

    on(article, "submit", "form#workspace-unarchive", (event) => {
        event.preventDefault();
        void runMutation(async () => {
            const ctx = getContext();
            await invoke("workspace.archive", { workspaceId: ctx.workspaceId, archived: false });
            location.assign(directoryPath({ kind: "workspace", workspace: ctx.workspaceName }) ?? "/settings/search");
            return "Workspace unarchived.";
        });
    });

    on(article, "submit", "form[data-workspace-row-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "";
        if (operation !== "archive" && operation !== "unarchive") return;
        const data = new FormData(form);
        const wsId = Number(data.get("workspaceId") ?? "0");
        const wsName = String(data.get("workspace") ?? "").trim();
        if (!Number.isFinite(wsId) || wsId <= 0 || !wsName) return;
        void runMutation(async (mutSignal) => {
            const archived = operation === "archive";
            await managementAction("workspace.archive", { workspaceId: wsId, archived }, "", mutSignal, { workspaceId: wsId });
            await refreshWorkspacesSection();
            return `${wsName}  ${archived ? "archived" : "unarchived"}`;
        });
    });

    on(article, "submit", "form#session-create", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const data = new FormData(form);
        const rawName = String(data.get("name") ?? "").trim();
        const rawTitle = String(data.get("title") ?? "").trim();
        void runMutation(async (mutSignal) => {
            const ctx = getContext();
            if (!ctx.workspaceName) throw new Error("No workspace selected.");
            /** @type {unknown} */
            let created;
            if (rawName) {
                const existingSessions = await managementAction("workspace.sessions", {
                    workspace: ctx.workspaceName,
                    includeArchived: true,
                }, "", mutSignal, { workspace: ctx.workspaceName });
                const rows = isRecord(existingSessions) && Array.isArray(existingSessions.sessions) ? existingSessions.sessions : [];
                if (rows.some((row) => isRecord(row) && row.name === rawName)) {
                    throw Object.assign(new Error(`Session '${rawName}' is already in use in workspace '${ctx.workspaceName}'.`), { status: 409 });
                }
                created = await managementAction("session/new", {
                    _meta: { plurnk: { workspace: ctx.workspaceName, sessionName: rawName } },
                }, "", mutSignal);
            } else {
                const seen = new Set(knownSessionNames);
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    const candidate = nextSequentialName("session", seen);
                    try {
                        created = await managementAction("session/new", {
                            _meta: { plurnk: { workspace: ctx.workspaceName, sessionName: candidate } },
                        }, "", mutSignal);
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
            const freshName = rawSessionId.includes("#") ? (rawSessionId.split("#")[1] ?? "") : rawName;
            if (freshName && rawTitle && ctx.workspaceId > 0) {
                await managementAction("session/set_title", { title: rawTitle }, `${ctx.workspaceId}#${freshName}`, mutSignal);
            }
            const dest = freshName
                ? directoryPath({ kind: "session", workspace: ctx.workspaceName, session: freshName })
                : directoryPath({ kind: "workspace", workspace: ctx.workspaceName });
            location.assign(dest ?? "/");
            return freshName ? `Created #${freshName}.` : "Session created.";
        });
    });

    on(article, "submit", "form#session-archive", (event) => {
        event.preventDefault();
        void runMutation(async () => {
            const ctx = getContext();
            if (!ctx.sessionName) throw new Error("No active session selected.");
            await invoke("session/archive", {}, { requireSession: true });
            const [overviewRes, sessionsRes] = await Promise.all([
                managementAction("session/list", {
                    archived: "exclude",
                    _meta: { plurnk: { workspaceId: ctx.workspaceId, limit: 1000 } },
                }, "", ctx.signal, { workspaceId: ctx.workspaceId }).catch(() => null),
                managementAction("workspace.sessions", {
                    workspaceId: ctx.workspaceId,
                    includeArchived: true,
                }, "", ctx.signal, { workspaceId: ctx.workspaceId }).catch(() => null),
            ]);
            /** @type {Map<number, { kind?: string, gates: number, title?: string, reply: { id: number } | null }>} */
            const overviewById = new Map();
            const rawOverview = isRecord(overviewRes) && Array.isArray(overviewRes.sessions) ? overviewRes.sessions : [];
            for (const item of rawOverview) {
                if (!isRecord(item)) continue;
                const meta = isRecord(item._meta) && isRecord(item._meta.plurnk) ? item._meta.plurnk : null;
                if (!meta || typeof meta.id !== "number") continue;
                const replyId = isRecord(meta.reply) && typeof meta.reply.id === "number" ? meta.reply.id : null;
                overviewById.set(meta.id, {
                    ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
                    gates: typeof meta.gates === "number" ? meta.gates : 0,
                    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
                    reply: replyId !== null ? { id: replyId } : null,
                });
            }
            const rawRows = isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions) ? sessionsRes.sessions : [];
            /** @type {Set<string>} */
            const seenSessionNames = new Set();
            const unarchived = rawRows
                .filter((row) => {
                    if (isRecord(row) && typeof row.name === "string") seenSessionNames.add(row.name);
                    return isRecord(row)
                        && typeof row.id === "number"
                        && typeof row.name === "string"
                        && row.origin === "model"
                        && (row.archivedAt === null || row.archivedAt === undefined);
                })
                .map((row) => {
                    const r = /** @type {Record<string, unknown>} */ (row);
                    const id = /** @type {number} */ (r.id);
                    const info = overviewById.get(id);
                    const parentSessionId = typeof r.parentSessionId === "number" ? r.parentSessionId : null;
                    const resolvedTitle = info?.title ?? (typeof r.title === "string" ? r.title : undefined);
                    return {
                        id,
                        name: /** @type {string} */ (r.name),
                        parentSessionId,
                        kind: info?.kind ?? (typeof r.kind === "string" ? r.kind : (parentSessionId === null ? "root" : "work")),
                        lifecycle: typeof r.lifecycle === "string" ? r.lifecycle : "idle",
                        gates: info?.gates ?? 0,
                        ...(typeof resolvedTitle === "string" ? { title: resolvedTitle } : {}),
                        reply: info?.reply ?? null,
                    };
                })
                .toSorted((a, b) => orderByReply(a, b) || a.id - b.id);
            const childParents = new Set(unarchived.flatMap(({ parentSessionId }) => parentSessionId === null ? [] : [parentSessionId]));
            const nonDraft = unarchived.filter((entry) => !isUntouchedDraftSession(entry, childParents.has(entry.id)));
            const topLevelNonDraft = nonDraft.filter((entry) => entry.parentSessionId === null || entry.kind === "fork");
            const remaining = topLevelNonDraft.length > 0 ? topLevelNonDraft : nonDraft.length > 0 ? nonDraft : unarchived;
            if (remaining.length > 0) {
                const nextPath = directoryPath({ kind: "session", workspace: ctx.workspaceName, session: remaining[0].name });
                if (nextPath !== null) {
                    location.assign(nextPath);
                    return "Session archived.";
                }
            }
            const candidate = nextSequentialName("session", seenSessionNames);
            const fresh = await managementAction("session/new", {
                _meta: { plurnk: { workspace: ctx.workspaceName, sessionName: candidate } },
            }, "", ctx.signal).catch(() => null);
            const freshId = isRecord(fresh) && typeof fresh.sessionId === "string" ? fresh.sessionId : "";
            const freshName = freshId.includes("#") ? (freshId.split("#")[1] || candidate) : null;
            if (freshName) {
                const freshPath = directoryPath({ kind: "session", workspace: ctx.workspaceName, session: freshName });
                if (freshPath !== null) {
                    location.assign(freshPath);
                    return "Session archived.";
                }
            }
            location.assign("/");
            return "Session archived.";
        });
    });

    on(article, "submit", "form#session-unarchive", (event) => {
        event.preventDefault();
        void runMutation(async () => {
            const ctx = getContext();
            if (!ctx.sessionName) throw new Error("No active session selected.");
            await invoke("session/unarchive", {}, { requireSession: true });
            if (article.dataset.workspaceArchived === "true") {
                await invoke("workspace.archive", { workspaceId: ctx.workspaceId, archived: false });
            }
            location.assign(directoryPath({ kind: "session", workspace: ctx.workspaceName, session: ctx.sessionName }) ?? "/settings/search");
            return "Session unarchived.";
        });
    });

    on(article, "submit", "form[data-session-row-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "";
        if (operation !== "archive" && operation !== "unarchive") return;
        const targetSession = String(new FormData(form).get("session") ?? "").trim();
        if (!targetSession) return;
        void runMutation(async (mutSignal) => {
            const ctx = getContext();
            if (ctx.workspaceId <= 0) throw new Error("No workspace selected.");
            if (operation === "unarchive" && article.dataset.workspaceArchived === "true") {
                await managementAction("workspace.archive", { workspaceId: ctx.workspaceId, archived: false }, "", mutSignal, { workspaceId: ctx.workspaceId });
                delete article.dataset.workspaceArchived;
            }
            await managementAction(
                operation === "archive" ? "session/archive" : "session/unarchive",
                {},
                `${ctx.workspaceId}#${targetSession}`,
                mutSignal,
                { workspaceId: ctx.workspaceId },
            );
            await refreshSessionsSection();
            return `#${targetSession}  ${operation === "archive" ? "archived" : "unarchived"}`;
        });
    });

    on(article, "submit", "form[data-session-title-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const rawTitle = String(new FormData(form).get("title") ?? "").trim();
        if (!rawTitle) return;
        void runMutation(async () => {
            await invoke("session/set_title", { title: rawTitle }, { requireSession: true });
            await refreshSessionsSection();
            return `Title: ${rawTitle}.`;
        });
    });

    on(article, "click", "[data-session-fork]", () => {
        void runMutation(async () => {
            const forked = await invoke("session/fork", {}, { requireSession: true });
            const rawId = isRecord(forked) && typeof forked.sessionId === "string" ? forked.sessionId : "";
            const forkedName = rawId.includes("#") ? (rawId.split("#")[1] ?? "") : "";
            const ctx = getContext();
            if (forkedName) {
                const dest = directoryPath({ kind: "session", workspace: ctx.workspaceName, session: forkedName });
                if (dest !== null) {
                    location.assign(dest);
                    return `Forked #${forkedName}.`;
                }
            }
            return "Session forked.";
        });
    });

    on(article, "submit", "[data-session-config-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        sessionModelCombobox?.close();
        sessionSpawnCombobox?.close();
        const data = new FormData(form);
        const selectedModel = String(data.get("model") ?? "").trim();
        const selectedEffort = String(data.get("effort") ?? "").trim();
        const selectedChild = String(data.get("childModel") ?? "inherit").trim() || "inherit";
        const selectedPersona = String(data.get("persona") ?? "none").trim() || "none";
        const selectedMode = String(data.get("mode") ?? "review").trim() || "review";
        void runMutation(async () => {
            const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                invoke(kind, params, { requireSession: true });
            /** @type {string[]} */
            const summaries = [];
            const modelChanged = Boolean(
                selectedModel
                && selectedModel !== "none"
                && (selectedModel !== currentSessionValues.model || !hasPersistedSessionModel),
            );
            const effortChanged = Boolean(selectedEffort && selectedEffort !== currentSessionValues.effort);
            if (modelChanged) {
                const route = await sessionModel(callSession, selectedModel, selectedEffort || undefined);
                summaries.push(`Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}`);
            } else if (effortChanged) {
                const effRes = await sessionEffort(callSession, selectedEffort);
                summaries.push(`Effort: ${effRes.effort ?? selectedEffort}`);
            }
            if (selectedChild !== currentSessionValues.childModel) {
                const { currentValue } = await sessionConfigOption(callSession, "child", selectedChild);
                summaries.push(`Child model: ${currentValue || selectedChild}`);
            }
            if (selectedPersona !== currentSessionValues.persona) {
                const { currentValue } = await sessionConfigOption(callSession, "persona", selectedPersona);
                summaries.push(`Persona: ${currentValue || selectedPersona}`);
            }
            if (selectedMode !== currentSessionValues.mode) {
                const { currentValue } = await sessionConfigOption(callSession, "mode", selectedMode);
                summaries.push(`Approval policy: ${currentValue || selectedMode}`);
            }
            await refreshSessionsSection();
            return summaries.length > 0 ? `${summaries.join(" · ")}.` : "Session settings saved.";
        });
    });

    focusCreateDisclosureIfRequested();

    return {
        renderSessionConfigControls,
        hydrateSessionConfig,
        loadWorkspacesSection,
        loadSessionsSection,
        dispose() {
            offWsCreate();
            wsCollectionBar?.dispose();
            sessCollectionBar?.dispose();
            effortSync.dispose();
            sessionModelCombobox?.dispose();
            sessionSpawnCombobox?.dispose();
        },
    };
}
