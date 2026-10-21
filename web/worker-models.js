/** @typedef {(kind: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>} Action */
/** @typedef {import("@plurnk/plurnk-contracts").ModelRoute} ModelRoute */

/** {§web-worker-settings} Shared validation for native forms and slash commands.
 * @param {ModelRoute | null} model
 */
export const modelLabel = (model) => model === null ? "Not selected" : `${model.alias ? `${model.alias} — ` : ""}${model.provider}/${model.model}`;

/** @param {Action} call @param {string} [search] */
export async function listModels(call, search = "") {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const result = /** @type {{aliases: Array<ModelRoute & {active: boolean}>}} */ (await call("providers.list"));
    if (!Array.isArray(result?.aliases)) throw new Error("Alias listing is invalid.");
    const aliases = result.aliases.map((alias) => {
        if (typeof alias.alias !== "string" || typeof alias.active !== "boolean") throw new Error("Alias listing is invalid.");
        return { ...alias, ...Validator.assertModelRoute({
            alias: alias.alias, provider: alias.provider, model: alias.model,
            ...(alias.effort === undefined ? {} : { effort: alias.effort, effortSource: alias.effortSource }),
        }), alias: alias.alias };
    }).filter((alias) => modelLabel(alias).toLowerCase().includes(search.toLowerCase()));
    const catalog = Validator.assertModelCatalogPage(await call("models.list", search ? { search } : {}));
    return { aliases, catalog };
}

/** @param {Action} call @param {string} [selector] @param {string} [effort] */
export async function workerModel(call, selector, effort) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const result = await call(selector === undefined ? "worker.model.get" : "worker.model.set",
        selector === undefined ? {} : { selector, ...(effort === undefined ? {} : { effort }) });
    const projection = /** @type {{model: unknown}} */ (result);
    return selector !== undefined ? Validator.assertModelRoute(result)
        : projection?.model === null ? null : Validator.assertModelRoute(projection?.model);
}

/** @param {Action} call @param {string} [selection] */
export async function workerEffort(call, selection) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const result = /** @type {{effort: unknown, source: unknown, supportedEfforts: unknown[]}} */ (
        await call(selection === undefined ? "worker.effort.get" : "worker.effort.set", selection === undefined ? {} : { effort: selection }));
    if (!["default", "explicit"].includes(String(result?.source)) || !Array.isArray(result?.supportedEfforts)) throw new Error("Effort result is invalid.");
    return { effort: result.effort === null ? null : Validator.assertEffort(result.effort), source: String(result.source),
        supported: result.supportedEfforts.map((value) => Validator.assertEffort(value)) };
}
