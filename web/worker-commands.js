import { $, $$, the } from "on_the_money";

/** {§web-worker-commands} A presentation vocabulary, not daemon policy or a terminal dispatcher. */
const commands = new Set(["help", "models", "model", "effort", "capabilities", "yolo", "stop"]);

/** @param {string} text */
export const isCommand = (text) => text.trimStart().startsWith("/");

/** @param {string} text */
export function parseCommand(text) {
    const match = /^\/(\S*)\s*([\s\S]*)$/u.exec(text.trim());
    if (!match) throw new Error("Expected a slash command.");
    const name = match[1] || "help";
    if (!commands.has(name)) throw new Error(`Unknown command /${name}. Use /help.`);
    const rest = match[2].trim();
    const args = rest ? rest.split(/\s+/u) : [];
    if ((["yolo", "stop"].includes(name) && args.length)
        || (["help", "effort"].includes(name) && args.length > 1)
        || (name === "model" && args.length > 2)) throw new Error(`Too many arguments for /${name}. Use /help ${name}.`);
    let policy;
    if (name === "capabilities" && rest) {
        try { policy = JSON.parse(rest); }
        catch (cause) { throw new Error("Capability policy must be valid JSON.", { cause }); }
    }
    return { name, rest, args, policy };
}

/** @typedef {(kind: string, params?: Record<string, unknown>) => Promise<unknown>} Action */
/** @typedef {import("@plurnk/plurnk-contracts").ModelRoute} ModelRoute */
/** @param {ModelRoute | null} model */
const route = (model) => model === null ? "Not selected" : `${model.alias ? `${model.alias} — ` : ""}${model.provider}/${model.model}`;

/** {§web-worker-commands} Native, literal results stay outside the observer's messages and state.
 * @param {Element} controls
 * @param {{call: Action, toggleYolo: () => Promise<boolean>, stop: () => Promise<string>}} actions
 */
export default function workerCommands(controls, actions) {
    const outlet = $.clone(controls, "#command-results", { position: "afterbegin" });
    const list = $(outlet, "ol");
    if (!list) throw new Error("Command results template is incomplete.");
    /** @param {string} text @param {AbortSignal} signal */
    return async (text, signal) => {
        const row = $.clone(list, "#worker-command-result");
        const article = $(row, "article");
        const input = $(row, "header code");
        const body = $(row, "[data-command-output]");
        if (!article || !input || !body) throw new Error("Command result template is incomplete.");
        input.textContent = text;
        the(article, { commandState: "pending", commandBusy: "true", commandMessage: "Running…", commandRecovery: "" });
        try {
            signal.throwIfAborted();
            const { name, rest, args, policy } = parseCommand(text);
            /** @type {string} */
            let message = "";
            if (name === "help") {
                const selected = rest.replace(/^\//u, "");
                if (selected && !commands.has(selected)) throw new Error(`Unknown command ${rest}. Use /help.`);
                const help = $.clone(body, "#command-help");
                for (const item of $$(help, "[data-command-name]")) {
                    if (selected && the(item, "command-name") !== selected) item.remove();
                }
            } else if (name === "yolo") {
                message = `Approvals: ${await actions.toggleYolo() ? "Automatic" : "Manual"}.`;
            } else if (name === "stop") {
                message = await actions.stop();
            } else {
                const { Validator } = await import("@plurnk/plurnk-contracts");
                signal.throwIfAborted();
                if (name === "models") {
                    const aliases = /** @type {{aliases: Array<ModelRoute & {active: boolean}>}} */ (await actions.call("providers.list"));
                    if (!Array.isArray(aliases?.aliases)) throw new Error("Alias listing is invalid.");
                    const catalog = Validator.assertModelCatalogPage(await actions.call("models.list", rest ? { search: rest } : {}));
                    signal.throwIfAborted();
                    const result = $.clone(body, "#command-models");
                    const aliasList = $(result, "[data-model-aliases]");
                    const entries = $(result, "tbody");
                    if (!aliasList || !entries) throw new Error("Model catalog template is incomplete.");
                    const matches = aliases.aliases.map((alias) => {
                        if (typeof alias.alias !== "string" || typeof alias.active !== "boolean") throw new Error("Alias listing is invalid.");
                        return { ...alias, ...Validator.assertModelRoute({
                            alias: alias.alias, provider: alias.provider, model: alias.model,
                            ...(alias.effort === undefined ? {} : { effort: alias.effort, effortSource: alias.effortSource }),
                        }), alias: alias.alias };
                    }).filter((alias) => route(alias).toLowerCase().includes(rest.toLowerCase()));
                    $.cloneEach(aliasList, "#command-alias", matches, (item, alias) => the(item, {
                        aliasName: alias.alias, aliasRoute: `${alias.provider}/${alias.model}`,
                        aliasEffort: alias.effort ?? "Unspecified", aliasActive: alias.active ? "Default" : "",
                    }));
                    $.cloneEach(entries, "#command-model", catalog.items, (item, model) => the(item, {
                        modelSelector: model.selector, modelName: model.modelName, modelContext: model.limits.contextTokens,
                        modelEfforts: model.capabilities.efforts.join(", "), modelReadiness: model.readiness.ready ? "Configured" : "Not configured",
                    }));
                    the(result, { aliasCount: matches.length, modelTotal: catalog.total, modelCount: catalog.items.length,
                        modelOffset: catalog.offset, modelMore: catalog.nextOffset === undefined ? "" : "More matches are available; narrow the search." });
                } else if (name === "model") {
                    const result = await actions.call(rest ? "worker.model.set" : "worker.model.get",
                        rest ? { selector: args[0], ...(args[1] === undefined ? {} : { effort: args[1] }) } : {});
                    const projection = /** @type {{model: unknown}} */ (result);
                    const model = rest ? Validator.assertModelRoute(result) : projection?.model === null ? null : Validator.assertModelRoute(projection?.model);
                    message = `Model: ${route(model)}${model?.effort === undefined ? "" : ` (${model.effort})`}.`;
                } else if (name === "effort") {
                    const result = /** @type {{effort: unknown, source: unknown, supportedEfforts: unknown[]}} */ (
                        await actions.call(rest ? "worker.effort.set" : "worker.effort.get", rest ? { effort: rest } : {}));
                    if (!["default", "explicit"].includes(String(result?.source)) || !Array.isArray(result?.supportedEfforts)) throw new Error("Effort result is invalid.");
                    const effort = result.effort === null ? "Unavailable" : Validator.assertEffort(result.effort);
                    const supported = result.supportedEfforts.map((value) => Validator.assertEffort(value));
                    message = `Effort: ${effort} (${result.source}). Supported: ${supported.join(", ") || "None"}.`;
                } else if (name === "capabilities") {
                    if (rest) Validator.assertCapabilityPolicy(policy);
                    const result = /** @type {import("@plurnk/plurnk-contracts").CapabilityProjection} */ (
                        await actions.call(rest ? "workspace.capabilities.set" : "workspace.capabilities.get", rest ? { policy } : {}));
                    for (const layer of ["service", "workspace", "effective"]) Validator.assertCapabilityPolicy(Reflect.get(Object(result), layer));
                    signal.throwIfAborted();
                    const projection = $.clone(body, "#command-capabilities");
                    for (const layer of /** @type {const} */ (["service", "workspace", "effective"])) {
                        const content = $(projection, `[data-capability="${layer}"]`);
                        if (!content) throw new Error("Capability template has no policy outlet.");
                        content.textContent = JSON.stringify(result[layer], null, 2);
                    }
                }
            }
            signal.throwIfAborted();
            the(article, { commandState: "done", commandBusy: "false", commandMessage: message });
            return true;
        } catch (error) {
            const cause = error instanceof Error ? error.cause : undefined;
            let recovery = "";
            let status = null;
            if (cause && typeof cause === "object" && !(cause instanceof Error)) {
                const { Validator } = await import("@plurnk/plurnk-contracts");
                if (Validator.validateProblemDetails(cause).valid) {
                    const problem = Validator.assertProblemDetails(cause);
                    recovery = typeof problem.recovery === "string" ? problem.recovery : "";
                    status = problem.status;
                }
            }
            the(article, { commandState: "error", commandBusy: "false",
                commandMessage: signal.aborted ? "Response not confirmed." : error instanceof Error ? error.message : String(error),
                commandRecovery: recovery, commandStatus: status });
            return false;
        }
    };
}
