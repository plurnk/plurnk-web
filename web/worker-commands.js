import { $, $$, the } from "on_the_money";
import { listModels, workerModel, workerEffort, modelLabel } from "./worker-models.js";
import describeFailure from "./failure.js";

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

/** @typedef {import("./worker-models.js").Action} Action */

/** {§web-worker-commands} Native, literal results stay outside the observer's messages and state.
 * @param {Element} controls
 * @param {{call: Action, toggleYolo: () => Promise<boolean>, stop: () => Promise<string>}} actions
 */
export default function workerCommands(controls, actions) {
    const outlet = $.clone(controls, "#command-results");
    const list = $(outlet, "ul");
    if (!list) throw new Error("Command results template is incomplete.");
    /** @param {string} text @param {AbortSignal} signal */
    return async (text, signal) => {
        /** @type {Action} */
        const call = (kind, params) => actions.call(kind, params, signal);
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
                    const { aliases: matches, catalog } = await listModels(call, rest);
                    signal.throwIfAborted();
                    const result = $.clone(body, "#command-models");
                    const aliasList = $(result, "[data-model-aliases]");
                    const entries = $(result, "tbody");
                    if (!aliasList || !entries) throw new Error("Model catalog template is incomplete.");
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
                    const model = await workerModel(call, args[0], args[1]);
                    message = `Model: ${modelLabel(model)}${model?.effort === undefined ? "" : ` (${model.effort})`}.`;
                } else if (name === "effort") {
                    const { effort, source, supported } = await workerEffort(call, args[0]);
                    message = `Effort: ${effort ?? "Unavailable"} (${source}). Supported: ${supported.join(", ") || "None"}.`;
                } else if (name === "capabilities") {
                    if (rest) Validator.assertCapabilityPolicy(policy);
                    const result = /** @type {import("@plurnk/plurnk-contracts").CapabilityProjection} */ (
                        await call(rest ? "workspace.capabilities.set" : "workspace.capabilities.get", rest ? { policy } : {}));
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
            const { message, recovery, status } = await describeFailure(error);
            the(article, { commandState: "error", commandBusy: "false",
                commandMessage: signal.aborted ? "Response not confirmed." : message, commandRecovery: recovery, commandStatus: status });
            return false;
        }
    };
}
