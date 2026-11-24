/** @typedef {(kind: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>} Action */
/** @typedef {import("@plurnk/plurnk-contracts").ModelRoute} ModelRoute */
/** @typedef {import("@plurnk/plurnk-contracts").ModelCatalogEntry} ModelCatalogEntry */
/** @typedef {import("@plurnk/plurnk-contracts").ModelCatalogPage} ModelCatalogPage */
/** @typedef {ModelRoute & { readonly alias: string, readonly active: boolean }} ModelAliasEntry */
/**
 * @typedef {{
 *   readonly value: string,
 *   readonly kind: "inherit" | "alias" | "catalog",
 *   readonly primary: string,
 *   readonly secondary: string,
 *   readonly efforts: readonly string[],
 *   readonly defaultEffort: string,
 * }} ModelChoice
 */
/**
 * @typedef {{
 *   readonly efforts: readonly string[],
 *   readonly defaultEffort: string,
 * }} ResolvedModelEfforts
 */

const MODEL_SEARCH_CACHE_MAX = 48;

/** {§web-workspace-settings} {§web-session-commands} Shared validation for native forms and slash commands.
 * @param {ModelRoute | null} model
 */
export const modelLabel = (model) => model === null ? "Not selected" : `${model.alias ? `${model.alias} — ` : ""}${model.provider}/${model.model}`;

/**
 * Compact human-readable context size (e.g. `200k`, `1M`).
 * @param {number | null | undefined} tokens
 * @returns {string}
 */
export function formatContextTokens(tokens) {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
    if (tokens >= 1_000_000) {
        const millions = tokens / 1_000_000;
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
    }
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
    return String(tokens);
}

/**
 * @param {Action} call
 * @param {AbortSignal} [signal]
 * @returns {Promise<ModelAliasEntry[]>}
 */
export async function listAliases(call, signal) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const result = /** @type {{providers?: Array<{_meta?: {plurnk?: ModelRoute & {active: boolean}}}>}} */ (
        await call("providers/list", {}, signal)
    );
    if (!Array.isArray(result?.providers)) throw new Error("Alias listing is invalid.");
    return result.providers.map((entry) => {
        const alias = entry?._meta?.plurnk;
        if (typeof alias?.alias !== "string" || typeof alias?.active !== "boolean") {
            throw new Error("Alias listing is invalid.");
        }
        return {
            ...alias,
            ...Validator.assertModelRoute({
                alias: alias.alias,
                provider: alias.provider,
                model: alias.model,
                ...(alias.effort === undefined ? {} : { effort: alias.effort, effortSource: alias.effortSource }),
            }),
            alias: alias.alias,
            active: alias.active,
        };
    });
}

/**
 * Validate a `models.list` page while tolerating optional `providers` across contracts v9 and v10.
 * @param {unknown} raw
 * @param {(input: unknown) => ModelCatalogPage} assertPage
 * @returns {{ readonly catalog: ModelCatalogPage, readonly providers: readonly string[] }}
 */
function parseModelCatalogResponse(raw, assertPage) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { catalog: assertPage(raw), providers: [] };
    }
    const rec = /** @type {Record<string, unknown>} */ (raw);
    const providers = Array.isArray(rec.providers)
        ? rec.providers.filter((entry) => typeof entry === "string" && entry.length > 0)
        : [];
    const core = {
        items: rec.items,
        offset: rec.offset,
        total: rec.total,
        ...(rec.nextOffset !== undefined ? { nextOffset: rec.nextOffset } : {}),
    };
    return { catalog: assertPage(core), providers };
}

/**
 * @param {Action} call
 * @param {string} [search]
 * @param {{
 *   readonly offset?: number,
 *   readonly limit?: number,
 *   readonly provider?: string,
 *   readonly availability?: "configured" | "all",
 *   readonly signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ aliases: ModelAliasEntry[], catalog: ModelCatalogPage, providers: readonly string[] }>}
 */
export async function listModels(call, search = "", options = {}) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const needle = search.trim().toLowerCase();
    const providerFilter = options.provider?.trim().toLowerCase() ?? "";
    const limit = Math.min(100, Math.max(1, options.limit ?? 100));
    const offset = Math.max(0, options.offset ?? 0);
    const [rawAliases, rawCatalog] = await Promise.all([
        listAliases(call, options.signal),
        call("models.list", {
            ...(needle ? { search: needle } : {}),
            ...(providerFilter ? { provider: providerFilter } : {}),
            ...(options.availability ? { availability: options.availability } : {}),
            ...(offset > 0 ? { offset } : {}),
            limit,
        }, options.signal),
    ]);
    const aliases = rawAliases.filter((alias) => {
        if (providerFilter && alias.provider.toLowerCase() !== providerFilter) return false;
        if (!needle) return true;
        return modelLabel(alias).toLowerCase().includes(needle)
            || alias.alias.toLowerCase().includes(needle)
            || `${alias.provider}/${alias.model}`.toLowerCase().includes(needle);
    });
    const { catalog, providers } = parseModelCatalogResponse(rawCatalog, (v) => Validator.assertModelCatalogPage(v));
    return { aliases, catalog, providers };
}

/**
 * Rank and deduplicate `inherit`, declared aliases, and ready catalog entries for combobox and slash completion.
 * @param {{
 *   readonly query?: string,
 *   readonly aliases?: readonly ModelAliasEntry[],
 *   readonly catalogItems?: readonly ModelCatalogEntry[],
 *   readonly includeInherit?: boolean,
 *   readonly effortsBySelector?: ReadonlyMap<string, ResolvedModelEfforts>,
 * }} input
 * @returns {ModelChoice[]}
 */
export function rankModelChoices({
    query = "",
    aliases = [],
    catalogItems = [],
    includeInherit = false,
    effortsBySelector,
}) {
    const needle = query.trim().toLowerCase();
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {ModelChoice[]} */
    const out = [];

    const pushUnique = (/** @type {ModelChoice} */ choice) => {
        if (!choice.value || seen.has(choice.value)) return;
        seen.add(choice.value);
        out.push(choice);
    };

    if (includeInherit && (!needle || "inherit".includes(needle) || "inherit session model".includes(needle))) {
        pushUnique({
            value: "inherit",
            kind: "inherit",
            primary: "inherit",
            secondary: "Inherit session model",
            efforts: [],
            defaultEffort: "",
        });
    }

    /** @type {Map<string, readonly string[]>} */
    const catalogEfforts = new Map();
    for (const item of catalogItems) {
        catalogEfforts.set(item.selector, item.capabilities.efforts);
    }

    /** @type {ModelAliasEntry[]} */
    const aliasPrefix = [];
    /** @type {ModelAliasEntry[]} */
    const aliasSubstring = [];
    for (const alias of aliases) {
        const aliasLower = alias.alias.toLowerCase();
        const routeLower = `${alias.provider}/${alias.model}`.toLowerCase();
        if (!needle || aliasLower.startsWith(needle) || routeLower.startsWith(needle)) {
            aliasPrefix.push(alias);
        } else if (aliasLower.includes(needle) || routeLower.includes(needle)) {
            aliasSubstring.push(alias);
        }
    }
    for (const alias of [...aliasPrefix, ...aliasSubstring]) {
        const route = `${alias.provider}/${alias.model}`;
        const cached = effortsBySelector?.get(alias.alias) ?? effortsBySelector?.get(route);
        const efforts = cached?.efforts.length
            ? cached.efforts
            : (catalogEfforts.get(route) ?? []);
        const secondaryParts = [route];
        if (alias.effort) secondaryParts.push(`effort: ${alias.effort}`);
        if (alias.active) secondaryParts.push("default");
        pushUnique({
            value: alias.alias,
            kind: "alias",
            primary: alias.alias,
            secondary: secondaryParts.join(" · "),
            efforts,
            defaultEffort: alias.effort ?? cached?.defaultEffort ?? "",
        });
    }

    const readyCatalog = catalogItems.filter((item) => item.readiness.ready);
    /** @type {ModelCatalogEntry[]} */
    const catalogExactOrPrefix = [];
    /** @type {ModelCatalogEntry[]} */
    const catalogModelPrefix = [];
    /** @type {ModelCatalogEntry[]} */
    const catalogSubstring = [];
    for (const item of readyCatalog) {
        if (!needle) {
            catalogExactOrPrefix.push(item);
            continue;
        }
        const selectorLower = item.selector.toLowerCase();
        const modelLower = item.model.toLowerCase();
        const nameLower = item.modelName.toLowerCase();
        if (selectorLower === needle || selectorLower.startsWith(needle)) {
            catalogExactOrPrefix.push(item);
        } else if (modelLower.startsWith(needle) || nameLower.startsWith(needle)) {
            catalogModelPrefix.push(item);
        } else if (
            selectorLower.includes(needle)
            || modelLower.includes(needle)
            || nameLower.includes(needle)
            || item.providerName.toLowerCase().includes(needle)
        ) {
            catalogSubstring.push(item);
        }
    }

    for (const item of [...catalogExactOrPrefix, ...catalogModelPrefix, ...catalogSubstring]) {
        const ctxLabel = formatContextTokens(item.limits.contextTokens);
        const secondaryParts = [];
        if (item.modelName && item.modelName !== item.selector && item.modelName !== item.model) {
            secondaryParts.push(item.modelName);
        }
        if (ctxLabel) secondaryParts.push(ctxLabel);
        pushUnique({
            value: item.selector,
            kind: "catalog",
            primary: item.selector,
            secondary: secondaryParts.join(" · "),
            efforts: item.capabilities.efforts,
            defaultEffort: "",
        });
    }

    return out;
}

/**
 * {§web-workspace-settings} {§web-session-commands} Shared live model-search and effort-resolution cache.
 * @param {Action} call
 */
export function createModelSearchCache(call) {
    /** @type {ModelAliasEntry[] | null} */
    let cachedAliases = null;
    /** @type {Map<string, ModelCatalogPage>} */
    const catalogPages = new Map();
    /** @type {Map<string, ResolvedModelEfforts>} */
    const effortsBySelector = new Map();
    /** @type {Map<string, string>} */
    const aliasRouteByName = new Map();
    /** @type {Set<string>} */
    const knownProviders = new Set();

    /** @param {readonly string[]} providers */
    function recordProviders(providers) {
        for (const provider of providers) {
            if (provider) knownProviders.add(provider);
        }
    }

    /** @param {readonly ModelCatalogEntry[]} items */
    function recordCatalogItems(items) {
        for (const item of items) {
            if (item.provider) knownProviders.add(item.provider);
            effortsBySelector.set(item.selector, {
                efforts: item.capabilities.efforts,
                defaultEffort: "",
            });
        }
        for (const [aliasName, route] of aliasRouteByName) {
            const routeEntry = effortsBySelector.get(route);
            const existing = effortsBySelector.get(aliasName);
            if (routeEntry && routeEntry.efforts.length > 0 && (!existing || existing.efforts.length === 0)) {
                effortsBySelector.set(aliasName, {
                    efforts: routeEntry.efforts,
                    defaultEffort: existing?.defaultEffort ?? "",
                });
            }
        }
    }

    /** @param {readonly ModelAliasEntry[]} aliases */
    function recordAliases(aliases) {
        cachedAliases = [...aliases];
        aliasRouteByName.clear();
        for (const alias of aliases) {
            if (alias.provider) knownProviders.add(alias.provider);
            const route = `${alias.provider}/${alias.model}`;
            aliasRouteByName.set(alias.alias, route);
            const existing = effortsBySelector.get(alias.alias);
            const routeEntry = effortsBySelector.get(route);
            effortsBySelector.set(alias.alias, {
                efforts: existing?.efforts.length ? existing.efforts : (routeEntry?.efforts ?? []),
                defaultEffort: alias.effort ?? existing?.defaultEffort ?? "",
            });
        }
    }

    /**
     * @param {string} selector
     * @param {readonly string[]} efforts
     * @param {string} [defaultEffort]
     */
    function seedEfforts(selector, efforts, defaultEffort = "") {
        if (!selector || efforts.length === 0) return;
        const existing = effortsBySelector.get(selector);
        if (!existing || existing.efforts.length === 0) {
            effortsBySelector.set(selector, {
                efforts: [...efforts],
                defaultEffort: defaultEffort || existing?.defaultEffort || "",
            });
        }
    }

    /** @param {AbortSignal} [signal] @param {boolean} [force] */
    async function loadAliases(signal, force = false) {
        if (!force && cachedAliases !== null) return cachedAliases;
        const aliases = await listAliases(call, signal);
        recordAliases(aliases);
        return aliases;
    }

    /**
     * @param {string} query
     * @param {{ readonly limit?: number, readonly signal?: AbortSignal }} [options]
     * @returns {Promise<ModelCatalogPage>}
     */
    async function fetchCatalogPage(query, options = {}) {
        const { Validator } = await import("@plurnk/plurnk-contracts");
        const needle = query.trim().toLowerCase();
        const limit = Math.min(100, Math.max(1, options.limit ?? 50));
        const cacheKey = `${limit}\0${needle}`;
        const cached = catalogPages.get(cacheKey);
        if (cached !== undefined) return cached;
        const raw = await call("models.list", {
            ...(needle ? { search: needle } : {}),
            availability: "configured",
            limit,
        }, options.signal);
        const { catalog: page, providers } = parseModelCatalogResponse(raw, (v) => Validator.assertModelCatalogPage(v));
        recordProviders(providers);
        recordCatalogItems(page.items);
        if (catalogPages.size >= MODEL_SEARCH_CACHE_MAX) {
            const oldestKey = catalogPages.keys().next().value;
            if (oldestKey !== undefined) catalogPages.delete(oldestKey);
        }
        catalogPages.set(cacheKey, page);
        return page;
    }

    /**
     * @param {string} query
     * @param {{ readonly includeInherit?: boolean, readonly limit?: number, readonly signal?: AbortSignal }} [options]
     */
    async function search(query, options = {}) {
        const [aliases, page] = await Promise.all([
            loadAliases(options.signal),
            fetchCatalogPage(query, { limit: options.limit ?? 50, signal: options.signal }),
        ]);
        const items = rankModelChoices({
            query,
            aliases,
            catalogItems: page.items,
            includeInherit: options.includeInherit === true,
            effortsBySelector,
        });
        return {
            items,
            total: page.total,
            aliasesCount: aliases.length,
            hasMore: page.nextOffset !== undefined,
        };
    }

    /**
     * Return synchronous alias-only + cached choices before the network round-trip resolves.
     * @param {string} query
     * @param {{ readonly includeInherit?: boolean }} [options]
     */
    function searchCached(query, options = {}) {
        const needle = query.trim().toLowerCase();
        const cachedPage = catalogPages.get(`50\0${needle}`) ?? catalogPages.get(`100\0${needle}`);
        return rankModelChoices({
            query,
            aliases: cachedAliases ?? [],
            catalogItems: cachedPage?.items ?? [],
            includeInherit: options.includeInherit === true,
            effortsBySelector,
        });
    }

    /**
     * Resolve exact supported efforts for any alias or catalog selector, querying `models.list` if outside page 1.
     * @param {string} selector
     * @param {AbortSignal} [signal]
     * @returns {Promise<ResolvedModelEfforts>}
     */
    async function resolveEfforts(selector, signal) {
        const trimmed = selector.trim();
        if (!trimmed || trimmed === "none" || trimmed === "inherit") {
            return { efforts: [], defaultEffort: "" };
        }
        if (cachedAliases === null) {
            await loadAliases(signal).catch(() => []);
        }
        const existing = effortsBySelector.get(trimmed);
        if (existing && existing.efforts.length > 0) return existing;
        const route = aliasRouteByName.get(trimmed) ?? trimmed;
        const routeExisting = effortsBySelector.get(route);
        if (routeExisting && routeExisting.efforts.length > 0) {
            const resolved = { efforts: routeExisting.efforts, defaultEffort: existing?.defaultEffort ?? "" };
            effortsBySelector.set(trimmed, resolved);
            return resolved;
        }
        if (route.includes("/")) {
            await fetchCatalogPage(route, { limit: 20, signal }).catch(() => null);
            const afterFetch = effortsBySelector.get(route);
            if (afterFetch && afterFetch.efforts.length > 0) {
                const resolved = { efforts: afterFetch.efforts, defaultEffort: existing?.defaultEffort ?? "" };
                effortsBySelector.set(trimmed, resolved);
                return resolved;
            }
        }
        return existing ?? { efforts: [], defaultEffort: "" };
    }

    /** @param {string} selector */
    function getCachedEfforts(selector) {
        const trimmed = selector.trim();
        if (!trimmed) return undefined;
        const direct = effortsBySelector.get(trimmed);
        if (direct && direct.efforts.length > 0) return direct;
        const route = aliasRouteByName.get(trimmed);
        if (route) {
            const byRoute = effortsBySelector.get(route);
            if (byRoute && byRoute.efforts.length > 0) {
                return { efforts: byRoute.efforts, defaultEffort: direct?.defaultEffort ?? "" };
            }
        }
        return direct;
    }

    function invalidate() {
        cachedAliases = null;
        catalogPages.clear();
    }

    return {
        loadAliases,
        recordAliases,
        recordCatalogItems,
        recordProviders,
        getKnownProviders: () => [...knownProviders].toSorted(),
        seedEfforts,
        search,
        searchCached,
        resolveEfforts,
        getCachedEfforts,
        invalidate,
        effortsBySelector,
    };
}

/**
 * @param {unknown} providers
 * @param {(input: unknown) => ModelRoute} assertModelRoute
 * @returns {ModelRoute | null}
 */
function activeProviderRoute(providers, assertModelRoute) {
    if (!Array.isArray(providers)) return null;
    const active = providers.find((entry) => entry?.active === true && typeof entry.provider === "string" && typeof entry.model === "string");
    if (!active) return null;
    return assertModelRoute({
        ...(typeof active.alias === "string" && active.alias ? { alias: active.alias } : {}),
        provider: active.provider,
        model: active.model,
        ...(typeof active.effort === "string" && active.effort
            ? { effort: active.effort, effortSource: active.effortSource ?? "default" }
            : {}),
    });
}

/** @param {Action} call @param {string} [selector] @param {string} [effort] */
export async function sessionModel(call, selector, effort) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    let response;
    if (selector === undefined) {
        response = await call("session/resume", { replayFrom: null });
    } else {
        response = await call("session/set_config_option", { configId: "model", value: selector });
        if (effort !== undefined) {
            response = await call("session/set_config_option", { configId: "thought_level", value: effort });
        }
    }
    const plurnk = /** @type {{_meta?: {plurnk?: {status?: Record<string, unknown>, providers?: unknown}}}} */ (response)?._meta?.plurnk;
    const status = plurnk?.status;
    if (!status || !Object.hasOwn(status, "model")) throw new Error("Model result is invalid.");
    if (selector !== undefined) return Validator.assertModelRoute(status.model);
    return status.model !== null
        ? Validator.assertModelRoute(status.model)
        : activeProviderRoute(plurnk?.providers, Validator.assertModelRoute);
}

/** @param {unknown} options @returns {Record<string, unknown>[]} */
export function flattenSelectOptions(options) {
    if (!Array.isArray(options)) return [];
    return options.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const rec = /** @type {Record<string, unknown>} */ (entry);
        if (Array.isArray(rec.options)) {
            return rec.options.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item));
        }
        return [rec];
    });
}

/** @param {Action} call @param {string} [selection] */
export async function sessionEffort(call, selection) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const response = /** @type {{configOptions?: Array<{configId?: string, currentValue?: unknown, options?: unknown}>, _meta?: {plurnk?: {status?: Record<string, unknown>, providers?: unknown}}}} */ (
        await call(
            selection === undefined ? "session/resume" : "session/set_config_option",
            selection === undefined ? { replayFrom: null } : { configId: "thought_level", value: selection },
        )
    );
    const thought = Array.isArray(response?.configOptions)
        ? response.configOptions.find((option) => option?.configId === "thought_level")
        : undefined;
    const status = response?._meta?.plurnk?.status;
    if (!Array.isArray(response?.configOptions) || !status || !Object.hasOwn(status, "model")) {
        throw new Error("Effort result is invalid.");
    }
    const model = status.model !== null
        ? Validator.assertModelRoute(status.model)
        : activeProviderRoute(response?._meta?.plurnk?.providers, Validator.assertModelRoute);
    const supported = thought && model !== null
        ? flattenSelectOptions(thought.options).map((option) => Validator.assertEffort(option.value))
        : [];
    const rawEffort = model?.effort ?? (typeof thought?.currentValue === "string" && thought.currentValue ? thought.currentValue : undefined);
    if (model === null || rawEffort === undefined) {
        return { effort: null, source: "default", supported };
    }
    return {
        effort: Validator.assertEffort(rawEffort),
        source: model.effortSource ?? "default",
        supported,
    };
}

/** @param {Action} call @param {"persona" | "child" | "mode"} configId @param {string} [selection] */
export async function sessionConfigOption(call, configId, selection) {
    const response = /** @type {{configOptions?: Array<{configId?: string, currentValue?: unknown, options?: unknown}>}} */ (
        await call(
            selection === undefined ? "session/options" : "session/set_config_option",
            selection === undefined ? {} : { configId, value: selection },
        )
    );
    if (!Array.isArray(response?.configOptions)) {
        throw new Error("Configuration options result is invalid.");
    }
    const option = response.configOptions.find((entry) => entry?.configId === configId);
    const currentValue = typeof option?.currentValue === "string" ? option.currentValue : "";
    const supported = flattenSelectOptions(option?.options)
        .flatMap((item) => typeof item.value === "string" && item.value ? [item.value] : []);
    return { currentValue, supported };
}
