import { $, $$, on, the } from "on_the_money";
import { attachModelCombobox } from "./combobox.js";
import { createModelEffortSync } from "./effort-select.js";
import { onServiceVersion, serviceVersion, webVersion } from "./endpoints.js";
import describeFailure from "./failure.js";
import managementAction from "./management-action.js";
import { primaryModifierLabel } from "./session-commands.js";
import {
    createModelSearchCache,
    flattenSelectOptions,
    formatContextExact,
    formatModelPrice,
    formatModelPriceDetail,
    listAliases,
    listModelProviders,
    listModels,
    modelLabel,
    sessionConfigOption,
    sessionEffort,
    sessionModel,
    setServiceConfig,
    unsetServiceConfig,
} from "./session-models.js";
import { isRecord } from "./session-translator.js";
import { COLLECTION_PAGE_SIZE } from "./workspace-collection.js";

/** @typedef {import("./workspace-records.js").WorkspaceSettingsContext} WorkspaceSettingsContext */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */
/** @typedef {import("./session-models.js").ModelCatalogSort} ModelCatalogSort */

const CATALOG_SEARCH_DEBOUNCE_MS = 180;
const VALID_SORTS = new Set(["selector", "cost-asc", "cost-desc", "context-desc"]);

/**
 * Parse a non-negative USD/1M price input field into a number or `undefined` when blank/invalid.
 * @param {string} raw
 * @returns {number | undefined}
 */
function parsePriceBound(raw) {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * @param {string} raw
 * @returns {ModelCatalogSort}
 */
function parseCatalogSort(raw) {
    return VALID_SORTS.has(raw) ? /** @type {ModelCatalogSort} */ (raw) : "selector";
}

/**
 * {§web-workspace-settings} Mount `models` (active session model+effort form, aliases, paginated catalog), `help`, and `about` panels.
 * @param {HTMLElement} article
 * @param {{
 *   readonly getContext: () => WorkspaceSettingsContext,
 *   readonly invoke: (kind: string, params?: Record<string, unknown>, opts?: { requireSession?: boolean }) => Promise<unknown>,
 *   readonly runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   readonly setFeedback: (busy: boolean, message?: string, recovery?: string, level?: "idle" | "info" | "success" | "warning" | "error") => void,
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
    setFeedback,
    invokeModelSearch,
    initialQuery = "",
    initialHelpFilter = "",
    onRefreshModels,
}) {
    const modelSearchCache = createModelSearchCache(invokeModelSearch);
    let modelsSearchQuery = initialQuery;
    let modelsProviderFilter = "";
    /** @type {number | undefined} */
    let modelsMinPrice;
    /** @type {number | undefined} */
    let modelsMaxPrice;
    /** @type {ModelCatalogSort} */
    let modelsSort = "selector";
    let modelsOffset = 0;
    /** @type {number | undefined} */
    let modelsNextOffset;
    /** @type {Set<string>} */
    const knownCatalogProviders = new Set();
    let helpFilterQuery = initialHelpFilter;
    /** @type {AbortController | null} */
    let modelsLookup = null;
    /** @type {AbortController | null} */
    let catalogLookup = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let catalogDebounceTimer = null;
    /** @type {{ model: string, effort: string }} */
    let currentSessionModelValues = { model: "", effort: "" };
    let lastSelectedComboboxModel = "";
    let hasPersistedSessionModel = false;
    let autoOpenedProviders = false;

    /** @type {ReturnType<typeof attachModelCombobox> | null} */
    let modelsSessionCombobox = null;

    function clearCatalogDebounce() {
        if (catalogDebounceTimer !== null) {
            clearTimeout(catalogDebounceTimer);
            catalogDebounceTimer = null;
        }
    }

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
                    const preferred = selector === lastSelectedComboboxModel ? effortField.value : "";
                    lastSelectedComboboxModel = selector;
                    sessionEffortSync.sync(selector, preferred, choice?.efforts, choice?.defaultEffort);
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
        lastSelectedComboboxModel = resolvedModel;
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
     * @param {import("./session-models.js").ModelCatalogPage} catalog
     * @param {readonly string[]} providers
     */
    function renderCatalogTable(catalog, providers) {
        const ctx = getContext();
        modelSearchCache.recordCatalogItems(catalog.items);
        modelSearchCache.recordProviders(providers);
        for (const name of modelSearchCache.getKnownProviders()) {
            knownCatalogProviders.add(name);
        }
        modelsNextOffset = catalog.nextOffset;
        const modelsPanel = $(article, '[data-settings-panel="models"]');
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
        if (modelsPanel && catalogBody) {
            const sessionUsable = ctx.sessionName !== null ? "true" : "false";
            $.cloneEach(catalogBody, "#command-model", catalog.items, (tr, model) => {
                the(tr, {
                    "model-selector": model.selector,
                    "model-name": model.modelName,
                    "model-context": formatContextExact(model.limits.contextTokens),
                    "model-price": formatModelPrice(model.cost),
                    "model-price-title": formatModelPriceDetail(model.cost),
                    "model-session-usable": sessionUsable,
                });
            });
            const prevBtn = $(modelsPanel, "[data-models-prev]");
            const nextBtn = $(modelsPanel, "[data-models-next]");
            if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = catalog.offset <= 0;
            if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = catalog.nextOffset === undefined;
            const hasFilter = Boolean(
                modelsSearchQuery
                || modelsProviderFilter
                || modelsMinPrice !== undefined
                || modelsMaxPrice !== undefined,
            );
            const emptyMessage = hasFilter
                ? "No matching configured models."
                : "No configured models available. Set a provider API key in the daemon environment.";
            the(modelsPanel, {
                "catalog-count": catalog.items.length,
                "model-empty": emptyMessage,
                "model-offset": catalog.offset,
                "model-count": catalog.items.length,
                "model-total": catalog.total,
                "model-more": catalog.nextOffset === undefined ? "" : "More matches are available; narrow the search.",
            });
        }
    }

    /**
     * Fetch only the configured catalog page so typing, filtering, sorting, and paging never shake
     * the Aliases table, active session form, or feedback callout above the catalog search bar.
     */
    async function loadCatalogOnly() {
        const ctx = getContext();
        catalogLookup?.abort();
        const req = catalogLookup = new AbortController();
        const signal = AbortSignal.any([ctx.signal, req.signal]);
        try {
            const callModels = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", signal, {
                    workspaceId: ctx.workspaceId,
                });
            const { catalog, providers } = await listModels(callModels, modelsSearchQuery, {
                offset: modelsOffset,
                limit: COLLECTION_PAGE_SIZE,
                availability: "configured",
                includeAliases: false,
                ...(modelsProviderFilter ? { provider: modelsProviderFilter } : {}),
                ...(modelsMinPrice !== undefined ? { minInputPer1M: modelsMinPrice } : {}),
                ...(modelsMaxPrice !== undefined ? { maxInputPer1M: modelsMaxPrice } : {}),
                ...(modelsSort !== "selector" ? { sort: modelsSort } : {}),
                signal,
            });
            signal.throwIfAborted();
            renderCatalogTable(catalog, providers);
        } catch (error) {
            if (req.signal.aborted && !ctx.signal.aborted) return;
            const { message, recovery } = await describeFailure(error);
            setFeedback(false, ctx.signal.aborted ? "Response not confirmed." : message, recovery, "error");
        }
    }

    function scheduleCatalogRefresh() {
        clearCatalogDebounce();
        catalogDebounceTimer = setTimeout(() => {
            catalogDebounceTimer = null;
            if (!getContext().signal.aborted) void loadCatalogOnly();
        }, CATALOG_SEARCH_DEBOUNCE_MS);
    }

    /**
     * @param {readonly import("./session-models.js").ModelProviderSummary[] | null} providers
     * @param {boolean} hasConfiguredModels
     */
    function renderProvidersList(providers, hasConfiguredModels) {
        const modelsPanel = $(article, '[data-settings-panel="models"]');
        const disclosure = modelsPanel ? $(modelsPanel, "details[data-providers-disclosure]") : null;
        const list = disclosure ? $(disclosure, "[data-providers-list]") : null;
        if (!(disclosure instanceof HTMLDetailsElement) || !list) return;
        if (providers === null || providers.length === 0) {
            disclosure.hidden = true;
            return;
        }
        disclosure.hidden = false;
        const readyCount = providers.filter((item) => item.ready).length;
        the(disclosure, "providers-ready-summary", `(${readyCount}/${providers.length} ready)`);
        if (!autoOpenedProviders && !hasConfiguredModels) {
            autoOpenedProviders = true;
            disclosure.open = true;
        }
        $.cloneEach(list, "#provider-credential-row", providers, (card, provider) => {
            const statusText = provider.ready ? "Ready" : (provider.readiness || "Not configured");
            the(card, {
                "provider-name": provider.providerName,
                "provider-status": statusText,
                "provider-ready": provider.ready ? "true" : "false",
            });
            const keysBox = $(card, "[data-provider-keys]");
            if (!keysBox) return;
            const keys = [
                ...provider.credentialKeys,
                ...(provider.baseUrlKey ? [provider.baseUrlKey] : []),
            ];
            $.cloneEach(keysBox, "#provider-key-form", keys, (formEl, keyInfo) => {
                const sourceTag = keyInfo.configured
                    ? (keyInfo.origin ? `(${keyInfo.origin})` : "(configured)")
                    : "";
                const placeholder = keyInfo.secret
                    ? (keyInfo.configured ? "Configured — enter new key to replace" : "Enter API key…")
                    : "https://…";
                the(formEl, {
                    "provider-key-name": keyInfo.key,
                    "provider-key-source": sourceTag,
                    "provider-key-aria": `${provider.providerName} ${keyInfo.key}`,
                    "provider-key-placeholder": placeholder,
                    "key-configured": keyInfo.configured ? "true" : "false",
                    "key-editable": keyInfo.editable ? "true" : "false",
                });
                const input = $(formEl, "input[data-provider-key-input]");
                if (input instanceof HTMLInputElement) {
                    input.type = keyInfo.secret ? "password" : "url";
                    input.value = keyInfo.secret ? "" : (keyInfo.value ?? "");
                    input.disabled = !keyInfo.editable;
                }
            });
        });
    }

    /**
     * @returns {Promise<{ abortedByNewerLookup: boolean }>}
     */
    async function loadModelsCatalog() {
        const ctx = getContext();
        clearCatalogDebounce();
        modelsLookup?.abort();
        catalogLookup?.abort();
        const req = modelsLookup = new AbortController();
        const signal = AbortSignal.any([ctx.signal, req.signal]);
        try {
            const callModels = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) =>
                managementAction(kind, params, ctx.sessionName !== null ? `${ctx.workspaceId}#${ctx.sessionName}` : "", signal, {
                    workspaceId: ctx.workspaceId,
                });
            const [aliases, { catalog, providers }, providerStatuses, sessionRes] = await Promise.all([
                listAliases(callModels, signal),
                listModels(callModels, modelsSearchQuery, {
                    offset: modelsOffset,
                    limit: COLLECTION_PAGE_SIZE,
                    availability: "configured",
                    includeAliases: false,
                    ...(modelsProviderFilter ? { provider: modelsProviderFilter } : {}),
                    ...(modelsMinPrice !== undefined ? { minInputPer1M: modelsMinPrice } : {}),
                    ...(modelsMaxPrice !== undefined ? { maxInputPer1M: modelsMaxPrice } : {}),
                    ...(modelsSort !== "selector" ? { sort: modelsSort } : {}),
                    signal,
                }),
                listModelProviders(callModels, signal).catch(() => null),
                ctx.sessionName !== null ? callModels("session/options").catch(() => null) : Promise.resolve(null),
            ]);
            signal.throwIfAborted();
            modelSearchCache.recordAliases(aliases);
            renderProvidersList(providerStatuses, aliases.length > 0 || catalog.total > 0);
            renderCatalogTable(catalog, providers);
            renderModelsSessionForm(sessionRes, aliases);
            const modelsPanel = $(article, '[data-settings-panel="models"]');
            const aliasBody = modelsPanel ? $(modelsPanel, "[data-models-alias-rows]") : null;
            if (modelsPanel && aliasBody) {
                const sessionUsable = ctx.sessionName !== null ? "true" : "false";
                $.cloneEach(aliasBody, "#workspace-model-alias-row", aliases, (tr, item) => {
                    the(tr, {
                        "alias-name": item.alias,
                        "alias-route": `${item.provider}/${item.model}`,
                        "alias-effort": item.effort ?? "Unspecified",
                        "alias-active": item.active ? "Default" : "Configured",
                        "alias-default": item.active ? "true" : "false",
                        "model-session-usable": sessionUsable,
                    });
                });
                the(modelsPanel, { "alias-count": aliases.length });
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
        clearCatalogDebounce();
        const data = new FormData(form);
        modelsSearchQuery = String(data.get("q") ?? "").trim();
        modelsProviderFilter = String(data.get("provider") ?? "").trim();
        modelsMinPrice = parsePriceBound(String(data.get("minPrice") ?? ""));
        modelsMaxPrice = parsePriceBound(String(data.get("maxPrice") ?? ""));
        modelsSort = parseCatalogSort(String(data.get("sort") ?? "selector"));
        modelsOffset = 0;
        void loadCatalogOnly();
    });

    on(article, "input", '[data-models-search-form] input[name="q"]', (_event, input) => {
        if (!(input instanceof HTMLInputElement)) return;
        modelsSearchQuery = input.value.trim();
        modelsOffset = 0;
        scheduleCatalogRefresh();
    });

    on(article, "input", '[data-models-search-form] input[name="minPrice"]', (_event, input) => {
        if (!(input instanceof HTMLInputElement)) return;
        modelsMinPrice = parsePriceBound(input.value);
        modelsOffset = 0;
        scheduleCatalogRefresh();
    });

    on(article, "input", '[data-models-search-form] input[name="maxPrice"]', (_event, input) => {
        if (!(input instanceof HTMLInputElement)) return;
        modelsMaxPrice = parsePriceBound(input.value);
        modelsOffset = 0;
        scheduleCatalogRefresh();
    });

    on(article, "change", '[data-models-search-form] select[name="provider"]', (_event, select) => {
        if (!(select instanceof HTMLSelectElement)) return;
        clearCatalogDebounce();
        modelsProviderFilter = select.value.trim();
        modelsOffset = 0;
        void loadCatalogOnly();
    });

    on(article, "change", '[data-models-search-form] select[name="sort"]', (_event, select) => {
        if (!(select instanceof HTMLSelectElement)) return;
        clearCatalogDebounce();
        modelsSort = parseCatalogSort(select.value);
        modelsOffset = 0;
        void loadCatalogOnly();
    });

    on(article, "click", "[data-models-prev]", () => {
        if (modelsOffset <= 0) return;
        clearCatalogDebounce();
        modelsOffset = Math.max(0, modelsOffset - COLLECTION_PAGE_SIZE);
        void loadCatalogOnly();
    });

    on(article, "click", "[data-models-next]", () => {
        if (modelsNextOffset === undefined) return;
        clearCatalogDebounce();
        modelsOffset = modelsNextOffset;
        void loadCatalogOnly();
    });

    on(article, "submit", "[data-provider-key-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "set";
        const data = new FormData(form);
        const key = String(data.get("key") ?? "").trim();
        const value = String(data.get("value") ?? "").trim();
        if (!key) return;
        if (operation === "set" && !value) {
            setFeedback(false, `Enter a value for ${key}.`, "", "error");
            return;
        }
        void runMutation(async () => {
            const callDaemon = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) => invoke(kind, params);
            if (operation === "unset") {
                await unsetServiceConfig(callDaemon, key);
            } else {
                await setServiceConfig(callDaemon, key, value);
                const input = $(form, "input[data-provider-key-input]");
                if (input instanceof HTMLInputElement && input.type === "password") input.value = "";
            }
            modelSearchCache.invalidate();
            await onRefreshModels();
            return operation === "unset" ? `Cleared ${key}.` : `Saved ${key}.`;
        });
    });

    on(article, "submit", "[data-model-alias-save-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const data = new FormData(form);
        const alias = String(data.get("alias") ?? "").trim();
        const route = String(data.get("route") ?? "").trim();
        if (!/^[a-zA-Z0-9_-]+$/u.test(alias)) {
            setFeedback(false, "Alias names use letters, digits, hyphens, or underscores.", "", "error");
            return;
        }
        if (!route.includes("/") || route.startsWith("/") || route.endsWith("/")) {
            setFeedback(false, "Enter a route as provider/model.", "", "error");
            return;
        }
        void runMutation(async () => {
            const callDaemon = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) => invoke(kind, params);
            await setServiceConfig(callDaemon, `PLURNK_MODEL_${alias}`, route);
            modelSearchCache.invalidate();
            await onRefreshModels();
            for (const input of $$(form, "input")) {
                if (input instanceof HTMLInputElement) input.value = "";
            }
            const disclosure = form.closest("details");
            if (disclosure instanceof HTMLDetailsElement) disclosure.open = false;
            return `Saved alias ${alias} → ${route}.`;
        });
    });

    on(article, "submit", "[data-model-alias-row-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "select";
        const alias = String(new FormData(form).get("alias") ?? "").trim();
        if (!alias) return;
        void runMutation(async () => {
            const callDaemon = (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ params = {}) => invoke(kind, params);
            if (operation === "default") {
                await setServiceConfig(callDaemon, "PLURNK_MODEL", alias);
                modelSearchCache.invalidate();
                await onRefreshModels();
                return `Default model: ${alias}.`;
            }
            if (operation === "remove") {
                await unsetServiceConfig(callDaemon, `PLURNK_MODEL_${alias}`);
                modelSearchCache.invalidate();
                await onRefreshModels();
                return `Removed alias ${alias}.`;
            }
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
            clearCatalogDebounce();
            modelsLookup?.abort();
            catalogLookup?.abort();
            sessionEffortSync.dispose();
            modelsSessionCombobox?.dispose();
        },
    };
}
