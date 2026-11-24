import { $, on, the } from "on_the_money";
import { directoryPath, nextSequentialName } from "../src/directory-addresses.js";
import { attachModelCombobox } from "./combobox.js";
import { createModelEffortSync } from "./effort-select.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import { flattenSelectOptions, listModels, modelLabel, sessionConfigOption, sessionEffort, sessionModel } from "./session-models.js";
import { isUntouchedDraftSession, orderByReply } from "./session-selection.js";
import { isRecord } from "./session-translator.js";

/** @typedef {import("./workspace-dialogs.js").WorkspaceSettingsContext} WorkspaceSettingsContext */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

/**
 * {§web-workspace-settings} {§web-workspace-rename} {§web-workspace-archive} {§web-session-archive}
 * Mount `#workspace` and `#session` lifecycle forms plus active-session policy controls.
 * @param {HTMLElement} article
 * @param {{
 *   readonly getContext: () => WorkspaceSettingsContext,
 *   readonly invoke: (kind: string, params?: Record<string, unknown>, opts?: { requireSession?: boolean }) => Promise<unknown>,
 *   readonly runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   readonly modelSearchCache: ModelSearchCache,
 *   readonly refreshSessionSection: () => Promise<void>,
 * }} host
 */
export function mountWorkspaceAndSessionSettings(article, {
    getContext,
    invoke,
    runMutation,
    modelSearchCache,
    refreshSessionSection,
}) {
    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let sessionModelCombobox = null;
    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let sessionSpawnCombobox = null;
    /** @type {{ model: string, effort: string, childModel: string, persona: string, mode: string }} */
    let currentSessionValues = { model: "", effort: "", childModel: "inherit", persona: "none", mode: "review" };
    let hasPersistedSessionModel = false;

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
                    effortSync.sync(selector, effortField.value, choice?.efforts, choice?.defaultEffort);
                }
            },
            onInput: (selector) => {
                const effortField = $(article, '[data-session-config-form] select[name="effort"]');
                if (effortField instanceof HTMLSelectElement && selector) {
                    const cached = modelSearchCache.getCachedEfforts(selector);
                    if (cached) {
                        effortSync.sync(selector, effortField.value, cached.efforts, cached.defaultEffort);
                    }
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
            location.assign(directoryPath({ kind: "workspace", workspace: ctx.workspaceName }) ?? "/search/");
            return "Workspace unarchived.";
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
            location.assign(directoryPath({ kind: "session", workspace: ctx.workspaceName, session: ctx.sessionName }) ?? "/search/");
            return "Session unarchived.";
        });
    });

    on(article, "submit", "form[data-session-title-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const rawTitle = String(new FormData(form).get("title") ?? "").trim();
        if (!rawTitle) return;
        void runMutation(async () => {
            await invoke("session/set_title", { title: rawTitle }, { requireSession: true });
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
            await refreshSessionSection();
            return summaries.length > 0 ? `${summaries.join(" · ")}.` : "Session settings saved.";
        });
    });

    return {
        renderSessionConfigControls,
        hydrateSessionConfig,
        dispose() {
            effortSync.dispose();
            sessionModelCombobox?.dispose();
            sessionSpawnCombobox?.dispose();
        },
    };
}

/**
 * {§web-session-creation} Wire `#dialog-session-create` on `/settings/` to create and optionally title a session over `/acp`.
 * @param {{
 *   readonly signal: AbortSignal,
 *   readonly getWorkspaceId: () => number,
 *   readonly getWorkspaceName: () => string,
 *   readonly getKnownSessionNames: () => Iterable<string>,
 * }} options
 */
export function wireSettingsSessionCreateDialog({ signal, getWorkspaceId, getWorkspaceName, getKnownSessionNames }) {
    const sessionDialog = $("#dialog-session-create");
    if (!(sessionDialog instanceof HTMLElement)) return;
    let newSessionBusy = false;
    on(sessionDialog, "submit", "form#session-create", (event, form) => {
        const currentWorkspaceName = getWorkspaceName();
        if (!(form instanceof HTMLFormElement) || !currentWorkspaceName) return;
        event.preventDefault();
        if (newSessionBusy) return;
        newSessionBusy = true;
        the(sessionDialog, "session-create-error", "");
        const data = new FormData(form);
        const rawName = String(data.get("name") ?? "").trim();
        const rawTitle = String(data.get("title") ?? "").trim();
        void (async () => {
            try {
                /** @type {unknown} */
                let created;
                if (rawName) {
                    const existingSessions = await managementAction("workspace.sessions", {
                        workspace: currentWorkspaceName,
                        includeArchived: true,
                    }, "", signal, { workspace: currentWorkspaceName });
                    const rows = isRecord(existingSessions) && Array.isArray(existingSessions.sessions) ? existingSessions.sessions : [];
                    if (rows.some((row) => isRecord(row) && row.name === rawName)) {
                        throw Object.assign(new Error(`Session '${rawName}' is already in use in workspace '${currentWorkspaceName}'.`), { status: 409 });
                    }
                    created = await managementAction("session/new", {
                        _meta: { plurnk: { workspace: currentWorkspaceName, sessionName: rawName } },
                    }, "", signal);
                } else {
                    const seen = new Set(getKnownSessionNames());
                    for (let attempt = 0; attempt < 8; attempt += 1) {
                        const candidate = nextSequentialName("session", seen);
                        try {
                            created = await managementAction("session/new", {
                                _meta: { plurnk: { workspace: currentWorkspaceName, sessionName: candidate } },
                            }, "", signal);
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
                const workspaceId = getWorkspaceId();
                if (freshName && rawTitle && workspaceId > 0) {
                    await managementAction("session/set_title", { title: rawTitle }, `${workspaceId}#${freshName}`, signal);
                }
                if (sessionDialog instanceof HTMLDialogElement && sessionDialog.open) sessionDialog.close();
                const dest = freshName
                    ? directoryPath({ kind: "session", workspace: currentWorkspaceName, session: freshName })
                    : directoryPath({ kind: "workspace", workspace: currentWorkspaceName });
                location.assign(dest ?? "/");
            } catch (error) {
                const { message, recovery } = await describeFailure(error);
                the(sessionDialog, "session-create-error", [message, recovery].filter(Boolean).join(" "));
            } finally {
                newSessionBusy = false;
            }
        })();
    });
}
