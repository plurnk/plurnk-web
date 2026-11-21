/** @typedef {(kind: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>} Action */
/** @typedef {import("@plurnk/plurnk-contracts").ModelRoute} ModelRoute */

/** {§web-session-settings} Shared validation for native forms and slash commands.
 * @param {ModelRoute | null} model
 */
export const modelLabel = (model) => model === null ? "Not selected" : `${model.alias ? `${model.alias} — ` : ""}${model.provider}/${model.model}`;

/** @param {Action} call @param {string} [search] */
export async function listModels(call, search = "") {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const result = /** @type {{providers?: Array<{_meta?: {plurnk?: ModelRoute & {active: boolean}}}>}} */ (await call("providers/list"));
    if (!Array.isArray(result?.providers)) throw new Error("Alias listing is invalid.");
    const aliases = result.providers.map((entry) => {
        const alias = entry?._meta?.plurnk;
        if (typeof alias?.alias !== "string" || typeof alias?.active !== "boolean") throw new Error("Alias listing is invalid.");
        return { ...alias, ...Validator.assertModelRoute({
            alias: alias.alias, provider: alias.provider, model: alias.model,
            ...(alias.effort === undefined ? {} : { effort: alias.effort, effortSource: alias.effortSource }),
        }), alias: alias.alias };
    }).filter((alias) => modelLabel(alias).toLowerCase().includes(search.toLowerCase()));
    const catalog = Validator.assertModelCatalogPage(await call("models.list", search ? { search } : {}));
    return { aliases, catalog };
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

/** @param {Action} call @param {string} [selection] */
export async function sessionEffort(call, selection) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const response = /** @type {{configOptions?: Array<{configId?: string, currentValue?: unknown, options?: Array<{value?: unknown}>}>, _meta?: {plurnk?: {status?: Record<string, unknown>, providers?: unknown}}}} */ (
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
    const supported = thought && Array.isArray(thought.options) && model !== null
        ? thought.options.map((option) => Validator.assertEffort(option?.value))
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

/** @param {Action} call @param {"persona" | "spawn_model" | "mode"} configId @param {string} [selection] */
export async function sessionConfigOption(call, configId, selection) {
    const response = /** @type {{configOptions?: Array<{configId?: string, currentValue?: unknown, options?: Array<{value?: unknown}>}>}} */ (
        await call(
            selection === undefined ? "session/resume" : "session/set_config_option",
            selection === undefined ? { replayFrom: null } : { configId, value: selection },
        )
    );
    if (!Array.isArray(response?.configOptions)) {
        throw new Error("Configuration options result is invalid.");
    }
    const option = response.configOptions.find((entry) => entry?.configId === configId);
    const currentValue = typeof option?.currentValue === "string" ? option.currentValue : "";
    const supported = Array.isArray(option?.options)
        ? option.options.flatMap((item) => typeof item?.value === "string" && item.value ? [item.value] : [])
        : [];
    return { currentValue, supported };
}
