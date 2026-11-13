import { $, $$, on, the } from "on_the_money";
import { isRecord, parseFamilyCommand, Validator } from "@plurnk/plurnk-contracts";
import { listModels, sessionModel, sessionEffort, modelLabel } from "./session-models.js";
import describeFailure from "./failure.js";

/** @returns {"⌘" | "Ctrl"} */
export const primaryModifierLabel = () =>
    /\b(?:Macintosh|Mac OS|iPhone|iPad|iPod)\b/iu.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** {§web-session-commands} A presentation vocabulary, not daemon policy or a terminal dispatcher. */
const familyCommands = new Set(["mcp", "skills", "schedule", "personas", "env"]);
const commands = new Set(["help", "models", "model", "effort", "capabilities", "yolo", "stop", ...familyCommands]);
const helpCommands = new Set([...commands, "learn"]);

const LEARN_PROMPT = "Review this session's work and author or update a reusable workspace skill (`SKILL.md` under `.agents/skills/<name>/SKILL.md`), reading `skill://plurnk/recipes.md` for conventions if needed, then verify it via `plurnk.skills`.";

/** @param {string} text */
export function expandPromptCommand(text) {
    const match = /^\/learn(?:\s+([\s\S]*))?$/u.exec(text.trim());
    if (!match) return text;
    const focus = match[1]?.trim() ?? "";
    return focus ? `${LEARN_PROMPT}\n\nFocus: ${focus}` : LEARN_PROMPT;
}

/**
 * @param {string} text
 * @param {readonly { name: string }[]} [availableCommands]
 */
export function isCommand(text, availableCommands = []) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return false;
    const match = /^\/(\S*)/u.exec(trimmed);
    const name = match?.[1] ?? "";
    if (name === "learn") return false;
    if (!name || commands.has(name)) return true;
    return !availableCommands.some((entry) => entry?.name === name);
}

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

/**
 * @param {string} family
 * @param {import("@plurnk/plurnk-contracts").ParsedFamilyCommand} parsed
 * @param {unknown} res
 * @returns {{ message: string, literal?: string }}
 */
function formatFamilyResult(family, parsed, res) {
    if (isRecord(res)) {
        if (parsed.actionName === "workspace.mcp.oauth.begin" || parsed.actionName === "workspace.mcp.oauth.complete") {
            const alias = typeof res.alias === "string" ? res.alias
                : typeof parsed.params.alias === "string" ? parsed.params.alias : "";
            if (isRecord(res.authorization) && typeof res.authorization.url === "string") {
                return { message: `${alias}: authorization required.`, literal: res.authorization.url };
            }
            if (res.status === 202) return { message: `${alias}: Sign-in accepted; tools awaiting activation.` };
            if (res.status === 200) return { message: `${alias}  active` };
        }
        if (isRecord(res.completion) && Array.isArray(res.completion.values)) {
            const values = res.completion.values.filter((v) => typeof v === "string");
            return values.length === 0 ? { message: `${family} complete: none` } : { message: "", literal: values.join("\n") };
        }
        if (parsed.actionName === "workspace.mcp.skills") {
            if (isRecord(res.skill) && typeof res.skill.name === "string") {
                return { message: `${res.skill.name}  verified` };
            }
            if (Array.isArray(res.skills)) {
                if (res.skills.length === 0) return { message: "mcp skills: none" };
                const lines = res.skills.map((item) => {
                    if (!isRecord(item)) return String(item);
                    const name = typeof item.name === "string" ? item.name : "";
                    const summary = typeof item.description === "string" && item.description.length > 0 ? `  ${item.description}` : "";
                    return `${name}${summary}`;
                });
                return { message: "", literal: lines.join("\n") };
            }
        }
        if (Array.isArray(res.candidates)) {
            if (res.candidates.length === 0) return { message: `${family} discover: none` };
            const lines = res.candidates.map((item) => {
                if (!isRecord(item)) return String(item);
                const alias = typeof item.alias === "string" && item.alias.length > 0 ? item.alias : "";
                const summary = typeof item.summary === "string" && item.summary.length > 0 ? item.summary : "";
                return alias && summary ? `${alias}  ${summary}` : alias || summary;
            });
            return { message: "", literal: lines.join("\n") };
        }
        if (isRecord(res.definition) && typeof res.definition.alias === "string") {
            const state = typeof res.definition.state === "string" ? res.definition.state : "active";
            return { message: `${res.definition.alias}  ${state}` };
        }
        const definitions = Array.isArray(res.definitions) ? res.definitions
            : Array.isArray(res.items) ? res.items : null;
        if (definitions !== null) {
            if (definitions.length === 0) return { message: `${family}: none` };
            const lines = definitions.map((item) => {
                if (!isRecord(item)) return String(item);
                const name = typeof item.alias === "string" ? item.alias
                    : typeof item.name === "string" ? item.name : "";
                const state = typeof item.state === "string" ? item.state : "active";
                const provenance = isRecord(item.provenance) && typeof item.provenance.source === "string" && item.provenance.source.length > 0
                    ? `  source=${item.provenance.source}`
                    : "";
                return `${name}  ${state}${provenance}`;
            });
            return { message: "", literal: lines.join("\n") };
        }
    }
    return { message: `Executed /${family}.` };
}

/**
 * @param {unknown} res
 * @param {"session" | "workspace"} fallbackOrigin
 */
function extractEnvEntries(res, fallbackOrigin) {
    if (!isRecord(res)) return [];
    const list = Array.isArray(res.definitions) ? res.definitions
        : Array.isArray(res.items) ? res.items : [];
    return list.flatMap((item) => {
        if (!isRecord(item)) return [];
        const alias = typeof item.alias === "string" ? item.alias
            : typeof item.name === "string" ? item.name : "";
        if (!alias) return [];
        const origin = item.origin === "session" || item.origin === "workspace" || item.origin === "service"
            ? item.origin
            : fallbackOrigin;
        const state = typeof item.state === "string" ? item.state : "active";
        const source = isRecord(item.provenance) && typeof item.provenance.source === "string" && item.provenance.source.length > 0
            ? item.provenance.source
            : "";
        return [{ alias, origin, state, source }];
    });
}

/**
 * @param {Element} panel
 * @param {unknown} res
 * @param {"session" | "workspace"} listScope
 */
function populateEnvPanel(panel, res, listScope) {
    const tbody = $(panel, "tbody");
    if (!tbody) throw new Error("Environment panel template is incomplete.");
    const entries = extractEnvEntries(res, listScope);
    $.cloneEach(tbody, "#command-env-row", entries, (tr, entry) => {
        the(tr, {
            envAlias: entry.alias,
            envOrigin: entry.origin,
            envStatus: entry.source ? `${entry.state} (${entry.source})` : entry.state,
            envRemovable: entry.origin === "session" || entry.origin === "workspace" ? "true" : "false",
            envEnabled: entry.state !== "disabled" ? "true" : "false",
        });
    });
    the(panel, { envCount: entries.length, envBusy: null });
    return entries.length;
}

/** @typedef {import("./session-models.js").Action} Action */

/** {§web-session-commands} Native, literal results stay outside the observer's messages and state.
 * @param {Element} controls
 * @param {{call: Action, toggleYolo: () => Promise<boolean>, stop: () => Promise<string>}} actions
 */
export default function sessionCommands(controls, actions) {
    const outlet = $.clone(controls, "#command-results");
    const list = $(outlet, "ul");
    if (!list) throw new Error("Command results template is incomplete.");
    /** @type {WeakMap<Element, { listScope: "session" | "workspace", signal: AbortSignal }>} */
    const envPanels = new WeakMap();
    on(outlet, "click", "[data-dismiss-command]", (_event, target) => {
        const row = target.closest("li");
        const article = row ? $(row, "article") : null;
        if (!row || !article || article.getAttribute("aria-busy") === "true") return;
        row.remove();
    });
    on(outlet, "input", '[data-env-set-form] input[name="alias"]', (_event, target) => {
        if (target instanceof HTMLInputElement) target.setCustomValidity("");
    });
    on(outlet, "submit", "[data-env-row-form]", async (event, target) => {
        event.preventDefault();
        if (!(target instanceof HTMLFormElement)) return;
        const panel = target.closest("[data-env-panel]");
        const article = target.closest("article");
        const ctx = panel ? envPanels.get(panel) : undefined;
        if (!panel || !article || !ctx || article.getAttribute("aria-busy") === "true") return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "";
        if (operation !== "enable" && operation !== "disable" && operation !== "remove") return;
        const data = new FormData(target);
        const alias = typeof data.get("alias") === "string" ? /** @type {string} */ (data.get("alias")).trim() : "";
        const origin = data.get("origin");
        if (!alias) return;
        const targetScope = operation === "remove"
            ? (origin === "workspace" ? "workspace" : "session")
            : ctx.listScope;
        the(article, { commandState: "pending", commandBusy: "true", commandMessage: "Running…", commandRecovery: "" });
        the(panel, "env-busy", "");
        try {
            ctx.signal.throwIfAborted();
            await actions.call(`${targetScope}.env.${operation}`, { alias }, ctx.signal);
            const fresh = await actions.call(`${ctx.listScope}.env.list`, {}, ctx.signal);
            ctx.signal.throwIfAborted();
            populateEnvPanel(panel, fresh, ctx.listScope);
            const verbLabel = operation === "remove" ? "unset" : `${operation}d`;
            the(article, { commandState: "done", commandBusy: "false", commandMessage: `${alias}  ${verbLabel}`, commandRecovery: "" });
        } catch (error) {
            const { message, recovery, status } = await describeFailure(error);
            the(panel, "env-busy", null);
            the(article, { commandState: "error", commandBusy: "false",
                commandMessage: ctx.signal.aborted ? "Response not confirmed." : message, commandRecovery: recovery, commandStatus: status });
        }
    });
    on(outlet, "submit", "[data-env-set-form]", async (event, target) => {
        event.preventDefault();
        if (!(target instanceof HTMLFormElement)) return;
        const panel = target.closest("[data-env-panel]");
        const article = target.closest("article");
        const ctx = panel ? envPanels.get(panel) : undefined;
        if (!panel || !article || !ctx || article.getAttribute("aria-busy") === "true") return;
        const aliasInput = $(target, 'input[name="alias"]');
        const valueInput = $(target, 'input[name="value"]');
        const scopeSelect = $(target, 'select[name="scope"]');
        if (!(aliasInput instanceof HTMLInputElement) || !(valueInput instanceof HTMLInputElement)) return;
        const alias = aliasInput.value.trim();
        if (!alias) {
            aliasInput.setCustomValidity("Enter a variable name.");
            aliasInput.reportValidity();
            return;
        }
        const value = valueInput.value;
        const targetScope = scopeSelect instanceof HTMLSelectElement && scopeSelect.value === "workspace"
            ? "workspace"
            : "session";
        the(article, { commandState: "pending", commandBusy: "true", commandMessage: "Running…", commandRecovery: "" });
        the(panel, "env-busy", "");
        try {
            ctx.signal.throwIfAborted();
            await actions.call(`${targetScope}.env.replace`, { alias, value }, ctx.signal);
            const fresh = await actions.call(`${ctx.listScope}.env.list`, {}, ctx.signal);
            ctx.signal.throwIfAborted();
            populateEnvPanel(panel, fresh, ctx.listScope);
            aliasInput.value = "";
            valueInput.value = "";
            the(article, { commandState: "done", commandBusy: "false", commandMessage: `${alias}  active`, commandRecovery: "" });
        } catch (error) {
            const { message, recovery, status } = await describeFailure(error);
            the(panel, "env-busy", null);
            the(article, { commandState: "error", commandBusy: "false",
                commandMessage: ctx.signal.aborted ? "Response not confirmed." : message, commandRecovery: recovery, commandStatus: status });
        }
    });
    /** @param {string} text @param {AbortSignal} signal */
    const execute = async (text, signal) => {
        /** @type {Action} */
        const call = (kind, params) => actions.call(kind, params, signal);
        const row = $.clone(list, "#session-command-result");
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
                if (selected && !helpCommands.has(selected)) throw new Error(`Unknown command ${rest}. Use /help.`);
                const help = $.clone(body, "#command-help");
                for (const item of $$(help, "[data-command-name]")) {
                    if (selected && the(item, "command-name") !== selected) item.remove();
                }
                if (!selected) {
                    const shortcuts = $.clone(body, "#command-shortcuts");
                    the(shortcuts, "shortcut-mod", primaryModifierLabel());
                }
            } else if (name === "yolo") {
                message = `Approvals: ${await actions.toggleYolo() ? "Automatic" : "Manual"}.`;
            } else if (name === "stop") {
                message = await actions.stop();
            } else if (familyCommands.has(name)) {
                const parsed = parseFamilyCommand(name, args);
                let params = parsed.params;
                if (parsed.actionName === "workspace.mcp.oauth.begin") {
                    const alias = typeof params.alias === "string" ? params.alias : "";
                    const listed = await call("workspace.mcp.list", {}).catch(() => null);
                    if (isRecord(listed)) {
                        const defs = Array.isArray(listed.definitions) ? listed.definitions
                            : Array.isArray(listed.items) ? listed.items : [];
                        const entry = defs.find((d) => isRecord(d) && d.alias === alias);
                        const def = isRecord(entry) && isRecord(entry.definition) ? entry.definition : null;
                        const auth = def?.type === "streamable-http" && isRecord(def.authorization) ? def.authorization : null;
                        if (auth?.type === "oauth" && typeof auth.redirectUrl === "string" && auth.redirectUrl.length > 0) {
                            params = { ...params, redirectUrl: auth.redirectUrl };
                        }
                    }
                }
                const res = await call(parsed.actionName, params);
                signal.throwIfAborted();
                if (name === "env" && parsed.sub === "list") {
                    const panel = $.clone(body, "#command-env");
                    const scopeSelect = $(panel, 'select[name="scope"]');
                    if (scopeSelect instanceof HTMLSelectElement) scopeSelect.value = parsed.scopePrefix;
                    envPanels.set(panel, { listScope: parsed.scopePrefix, signal });
                    const count = populateEnvPanel(panel, res, parsed.scopePrefix);
                    message = count === 0 ? "env: none" : "";
                } else {
                    const formatted = formatFamilyResult(name, parsed, res);
                    message = formatted.message;
                    if (formatted.literal) {
                        const literal = $.clone(body, "#conversation-literal");
                        literal.textContent = formatted.literal;
                    }
                }
            } else {
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
                    const model = await sessionModel(call, args[0], args[1]);
                    message = `Model: ${modelLabel(model)}${model?.effort === undefined ? "" : ` (${model.effort})`}.`;
                } else if (name === "effort") {
                    const { effort, source, supported } = await sessionEffort(call, args[0]);
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
    const dismissAll = () => {
        const settled = $$(list, ":scope > li").filter((item) => $(item, "article")?.getAttribute("aria-busy") !== "true");
        if (settled.length === 0) return false;
        for (const item of settled) item.remove();
        return true;
    };
    /** @param {AbortSignal} signal */
    const showHelp = async (signal) => {
        for (const item of $$(list, ":scope > li")) {
            const code = $(item, "header code")?.textContent?.trim();
            if ((code === "/help" || code === "/") && $(item, "article")?.getAttribute("aria-busy") !== "true") {
                item.remove();
            }
        }
        return execute("/help", signal);
    };
    return Object.assign(execute, { dismissAll, showHelp });
}
