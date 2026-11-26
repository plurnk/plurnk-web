import { $, $$, on, the } from "on_the_money";
import { attachModelCombobox } from "./combobox.js";
import { createModelEffortSync } from "./effort-select.js";
import { onServiceVersion, serviceVersion, webVersion } from "./endpoints.js";
import managementAction from "./management-action.js";
import { primaryModifierLabel } from "./session-commands.js";
import { createModelSearchCache, flattenSelectOptions, listModels, modelLabel, sessionConfigOption, sessionEffort, sessionModel } from "./session-models.js";
import { isRecord } from "./session-translator.js";
import { COLLECTION_PAGE_SIZE } from "./workspace-collection.js";

/** @typedef {import("./workspace-records.js").WorkspaceSettingsContext} WorkspaceSettingsContext */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

/**
 * {§web-workspace-settings} Mount `models` (active session model+effort form, aliases, paginated catalog), `help`, and `about` panels.
 * @param {HTMLElement} article
 * @param {{
 *   readonly getContext: () => WorkspaceSettingsContext,
 *   readonly invoke: (kind: string, params?: Record<string, unknown>, opts?: { requireSession?: boolean }) => Promise<unknown>,
 *   readonly runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   readonly invokeModelSearch: (kind: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
 *   readonly initialQuery?: string,
 *   readonly initialHelpFilter?: string,
 *   readonly onRefreshModels: () => Promise<void>,
 * }} host
 */
export function mountModelsHelpAboutSections(article, {
    getContext,
    invoke,
    runMutation,
    invokeModelSearch,
    initialQuery = "",
    initialHelpFilter = "",
    onRefreshModels,
}) {
    const modelSearchCache = createModelSearchCache(invokeModelSearch);
    let modelsSearchQuery = initialQuery;
    let modelsProviderFilter = "";
    let modelsOffset = 0;
    /** @type {number | undefined} */
    let modelsNextOffset;
    /** @type {Set<string>} */
    const knownCatalogProviders = new Set();
    let helpFilterQuery = initialHelpFilter;
    /** @type {AbortController | null} */
    let modelsLookup = null;
    /** @type {{ model: string, effort: string }} */
    let currentSessionModelValues = { model: "", effort: "" };
    let hasPersistedSessionModel = false;

    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let modelsSessionCombobox = null;

    const sessionEffortSync = createModelEffortSync({
        getSelect: () => {
            const el = $(article, '[data-models-session-form] select[name="effort"]');
            return el instanceof HTMLSelectElement ? el : null;
        },
        getCache: () => modelSearchCache,
        getSelectedModel: () => modelsSessionCombobox?.getValue() ?? "",
        getSignal: () => getContext().signal,
    });

    const modelsSessionBox = $(article, '[data-models-session-form] [data-model-combobox="modelsSessionModel"]');
    if (modelsSessionBox instanceof HTMLElement) {
        modelsSessionCombobox = attachModelCombobox(modelsSessionBox, {
            getCache: () => modelSearchCache,
            signal: getContext().signal,
            onSelect: (selector, choice) => {
                const effortField = $(article, '[data-models-session-form] select[name="effort"]');
                if (effortField instanceof HTMLSelectElement) {
                    sessionEffortSync.sync(selector, effortField.value, choice?.efforts, choice?.defaultEffort);
                }
            },
            onInput: (selector) => {
                const effortField = $(article, '[data-models-session-form] select[name="effort"]');
                if (effortField instanceof HTMLSelectElement && selector) {
                    const cached = modelSearchCache.getCachedEfforts(selector);
                    if (cached) {
                        sessionEffortSync.sync(selector, effortField.value, cached.efforts, cached.defaultEffort);
                    }
                }
            },
        });
    }

    const shortcutsOutlet = $(article, "[data-help-shortcuts-outlet]");
    if (shortcutsOutlet && shortcutsOutlet.children.length === 0) {
        const shortcuts = $.clone(shortcutsOutlet, "#command-shortcuts");
        the(shortcuts, "shortcut-mod", primaryModifierLabel());
    }
    const commandsOutlet = $(article, "[data-help-commands-outlet]");
    if (commandsOutlet && commandsOutlet.children.length === 0) {
        $.clone(commandsOutlet, "#command-help");
    }
    const helpFilterInput = $(article, "[data-help-filter]");
    if (helpFilterInput instanceof HTMLInputElement && helpFilterQuery) {
        helpFilterInput.value = helpFilterQuery;
    }
    const modelsSearchInput = $(article, '[data-models-search-form] input[name="q"]');
    if (modelsSearchInput instanceof HTMLInputElement && modelsSearchQuery) {
        modelsSearchInput.value = modelsSearchQuery;
    }

    function applyHelpFilter() {
        const helpPanel = $(article, '[data-settings-panel="help"]');
        if (!helpPanel) return;
        const needle = helpFilterQuery.trim().replace(/^\//u, "").toLowerCase();
        for (const item of $$(helpPanel, "[data-command-name]")) {
            if (!(item instanceof HTMLElement)) continue;
            const name = (item.getAttribute("data-command-name") ?? "").toLowerCase();
            const summary = (item.textContent ?? "").toLowerCase();
            item.hidden = needle !== "" && !name.includes(needle) && !summary.includes(needle);
        }
    }

    function syncAboutPanel() {
        const aboutPanel = $(article, '[data-settings-panel="about"]');
        if (!(aboutPanel instanceof HTMLElement)) return;
        the(aboutPanel, "about-web-version", webVersion());
        const svc = serviceVersion();
        const svcTerm = $(aboutPanel, "[data-about-service-term]");
        const svcVal = $(aboutPanel, "[data-about-service-value]");
        if (svc !== null) {
            if (svcTerm instanceof HTMLElement) svcTerm.hidden = false;
            if (svcVal instanceof HTMLElement) svcVal.hidden = false;
            the(aboutPanel, "about-service-version", svc);
        }
        const desktopMatch = /\bplurnk-desktop\/([^\s;()]+)/iu.exec(globalThis.navigator?.userAgent ?? "");
        const desktopTerm = $(aboutPanel, "[data-about-desktop-term]");
        const desktopVal = $(aboutPanel, "[data-about-desktop-value]");
        if (desktopMatch?.[1]) {
            if (desktopTerm instanceof HTMLElement) desktopTerm.hidden = false;
            if (desktopVal instanceof HTMLElement) desktopVal.hidden = false;
            the(aboutPanel, "about-desktop-version", desktopMatch[1]);
        } else {
            if (desktopTerm instanceof HTMLElement) desktopTerm.hidden = true;
            if (desktopVal instanceof HTMLElement) desktopVal.hidden = true;
        }
    }

    /**
     * @param {unknown} sessionRes
     * @param {readonly import("./session-models.js").ModelAliasEntry[]} aliases
     */
    function renderModelsSessionForm(sessionRes, aliases) {
        const form = $(article, "form[data-models-session-form]");
        if (!(form instanceof HTMLFormElement) || !modelsSessionCombobox) return;
        if (getContext().sessionName === null || !isRecord(sessionRes) || !Array.isArray(sessionRes.configOptions)) {
            form.hidden = true;
            return;
        }
        const modelOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "model");
        const thoughtOption = sessionRes.configOptions.find((entry) => isRecord(entry) && entry.configId === "thought_level");
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
        modelsSessionCombobox.setValue(resolvedModel);

        const currentEffort = isRecord(thoughtOption) && typeof thoughtOption.currentValue === "string" ? thoughtOption.currentValue : "";
        const resolvedEffort = sessionEffortSync.sync(resolvedModel, currentEffort);

        currentSessionModelValues = {
            model: resolvedModel,
            effort: resolvedEffort,
        };
        form.hidden = false;
    }

    /**
     * @returns {Promise<{ abortedByNewerLookup: boolean }>}
     */
    async function loadModelsCatalog() {
        const ctx = getContext();
        modelsLookup?.abort();
        const req = modelsLookup = new AbortController();
        const signal = AbortSignal.any([ctx.signal, req.signal]);
        try {
            const callModels = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", signal, {
                    workspaceId: ctx.workspaceId,
                });
            const [{ aliases, catalog, providers }, sessionRes] = await Promise.all([
                listModels(callModels, modelsSearchQuery, {
                    offset: modelsOffset,
                    limit: COLLECTION_PAGE_SIZE,
                    ...(modelsProviderFilter ? { provider: modelsProviderFilter } : {}),
                    signal,
                }),
                ctx.sessionName !== null ? callModels("session/options").catch(() => null) : Promise.resolve(null),
            ]);
            signal.throwIfAborted();
            modelSearchCache.recordAliases(aliases);
            modelSearchCache.recordCatalogItems(catalog.items);
            modelSearchCache.recordProviders(providers);
            for (const name of modelSearchCache.getKnownProviders()) {
                knownCatalogProviders.add(name);
            }
            renderModelsSessionForm(sessionRes, aliases);
            modelsNextOffset = catalog.nextOffset;
            const modelsPanel = $(article, '[data-settings-panel="models"]');
            const aliasBody = modelsPanel ? $(modelsPanel, "[data-models-alias-rows]") : null;
            const catalogBody = modelsPanel ? $(modelsPanel, "[data-models-catalog-rows]") : null;
            const providerSelect = modelsPanel ? $(modelsPanel, '[data-models-search-form] select[name="provider"]') : null;
            if (providerSelect instanceof HTMLSelectElement) {
                const providerChoices = [
                    { value: "", label: "All providers" },
                    ...[...knownCatalogProviders].toSorted().map((name) => ({ value: name, label: name })),
                ];
                $.cloneEach(providerSelect, "#setting-option", providerChoices, (optEl, choice) => {
                    the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
                });
                providerSelect.value = modelsProviderFilter;
            }
            if (modelsPanel && aliasBody && catalogBody) {
                const sessionUsable = ctx.sessionName !== null ? "true" : "false";
                $.cloneEach(aliasBody, "#workspace-model-alias-row", aliases, (tr, item) => {
                    the(tr, {
                        "alias-name": item.alias,
                        "alias-route": `${item.provider}/${item.model}`,
                        "alias-effort": item.effort ?? "Unspecified",
                        "alias-active": item.active ? "Default" : "Configured",
                        "model-session-usable": sessionUsable,
                    });
                });
                $.cloneEach(catalogBody, "#command-model", catalog.items, (tr, model) => {
                    the(tr, {
                        "model-selector": model.selector,
                        "model-name": model.modelName,
                        "model-context": model.limits.contextTokens,
                        "model-efforts": model.capabilities.efforts.join(", "),
                        "model-readiness": model.readiness.ready ? "Configured" : "Not configured",
                        "model-session-usable": sessionUsable,
                        "model-ready": model.readiness.ready ? "true" : "false",
                    });
                });
                const prevBtn = $(modelsPanel, "[data-models-prev]");
                const nextBtn = $(modelsPanel, "[data-models-next]");
                if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = catalog.offset <= 0;
                if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = catalog.nextOffset === undefined;
                the(modelsPanel, {
                    "alias-count": aliases.length,
                    "model-offset": catalog.offset,
                    "model-count": catalog.items.length,
                    "model-total": catalog.total,
                    "model-more": catalog.nextOffset === undefined ? "" : "More matches are available; narrow the search.",
                });
            }
            return { abortedByNewerLookup: false };
        } catch (error) {
            if (req.signal.aborted && !ctx.signal.aborted) {
                return { abortedByNewerLookup: true };
            }
            throw error;
        }
    }

    applyHelpFilter();
    syncAboutPanel();
    const offSvc = onServiceVersion(() => { syncAboutPanel(); });

    on(article, "submit", "[data-models-session-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        modelsSessionCombobox?.close();
        const data = new FormData(form);
        const selectedModel = String(data.get("model") ?? "").trim();
        const selectedEffort = String(data.get("effort") ?? "").trim();
        void runMutation(async () => {
            const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                invoke(kind, params, { requireSession: true });
            const modelChanged = Boolean(
                selectedModel
                && selectedModel !== "none"
                && (selectedModel !== currentSessionModelValues.model || !hasPersistedSessionModel),
            );
            const effortChanged = Boolean(selectedEffort && selectedEffort !== currentSessionModelValues.effort);
            let summary = "Session model unchanged.";
            if (modelChanged) {
                const route = await sessionModel(callSession, selectedModel, selectedEffort || undefined);
                summary = `Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}.`;
            } else if (effortChanged) {
                const effRes = await sessionEffort(callSession, selectedEffort);
                summary = `Effort: ${effRes.effort ?? selectedEffort}.`;
            }
            await onRefreshModels();
            return summary;
        });
    });

    on(article, "submit", "[data-models-search-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const data = new FormData(form);
        modelsSearchQuery = String(data.get("q") ?? "").trim();
        modelsProviderFilter = String(data.get("provider") ?? "").trim();
        modelsOffset = 0;
        void onRefreshModels();
    });

    on(article, "input", '[data-models-search-form] input[name="q"]', (_event, input) => {
        if (!(input instanceof HTMLInputElement)) return;
        modelsSearchQuery = input.value.trim();
        modelsOffset = 0;
        void onRefreshModels();
    });

    on(article, "change", '[data-models-search-form] select[name="provider"]', (_event, select) => {
        if (!(select instanceof HTMLSelectElement)) return;
        modelsProviderFilter = select.value.trim();
        modelsOffset = 0;
        void onRefreshModels();
    });

    on(article, "click", "[data-models-prev]", () => {
        if (modelsOffset <= 0) return;
        modelsOffset = Math.max(0, modelsOffset - COLLECTION_PAGE_SIZE);
        void onRefreshModels();
    });

    on(article, "click", "[data-models-next]", () => {
        if (modelsNextOffset === undefined) return;
        modelsOffset = modelsNextOffset;
        void onRefreshModels();
    });

    on(article, "submit", "[data-model-alias-row-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const alias = String(new FormData(form).get("alias") ?? "").trim();
        if (!alias) return;
        void runMutation(async () => {
            const route = await sessionModel(
                (kind, params = {}) => invoke(kind, params, { requireSession: true }),
                alias,
            );
            await onRefreshModels();
            return `Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}.`;
        });
    });

    on(article, "submit", "[data-model-catalog-row-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "select";
        const selector = String(new FormData(form).get("selector") ?? "").trim();
        if (!selector) return;
        void runMutation(async () => {
            const callSession = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                invoke(kind, params, { requireSession: true });
            if (operation === "child") {
                const { currentValue } = await sessionConfigOption(callSession, "child", selector);
                await onRefreshModels();
                return `Child model: ${currentValue || selector}.`;
            }
            const route = await sessionModel(callSession, selector);
            await onRefreshModels();
            return `Model: ${modelLabel(route)}${route?.effort ? ` (${route.effort})` : ""}.`;
        });
    });

    on(article, "input", "[data-help-filter]", (_event, input) => {
        if (!(input instanceof HTMLInputElement)) return;
        helpFilterQuery = input.value;
        applyHelpFilter();
    });

    return {
        applyHelpFilter,
        syncAboutPanel,
        loadModelsCatalog,
        dispose() {
            offSvc();
            modelsLookup?.abort();
            sessionEffortSync.dispose();
            modelsSessionCombobox?.dispose();
        },
    };
}
