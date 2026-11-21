import { $, $$, on, the } from "on_the_money";
import { directoryPath, workspaceSettingsPath } from "../src/directory-addresses.js";
import { isRecord } from "./session-translator.js";
import { listModels, sessionConfigOption, sessionEffort, sessionModel, modelLabel } from "./session-models.js";
import { allowOptionId, rejectOptionId } from "./session-review.js";
import { populateEnvPanel } from "./env-panel.js";
import describeFailure from "./failure.js";

/** @returns {"⌘" | "Ctrl"} */
export const primaryModifierLabel = () =>
    /\b(?:Macintosh|Mac OS|iPhone|iPad|iPod)\b/iu.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** {§web-session-commands} A presentation vocabulary, not daemon policy or a terminal dispatcher. */
const familyCommands = new Set(["mcp", "skills", "schedule", "personas", "members", "env"]);
const commands = new Set([
    "help",
    "models",
    "model",
    "effort",
    "yolo",
    "stop",
    ...familyCommands,
    "persona",
    "child",
    "mode",
    "fork",
    "rollback",
    "share",
    "update",
    "workspaces",
    "workspace",
    "rename",
    "sessions",
    "session",
    "parent",
    "enter",
    "older",
    "newer",
    "loops",
    "loop",
    "script",
    "review",
    "accept",
    "approve",
    "reject",
    "cancel",
    "edit",
    "answer",
    "onboard",
]);
const helpCommands = new Set([...commands, "learn"]);

export const SLASH_COMMAND_NAMES = Object.freeze([
    "/help",
    "/model",
    "/models",
    "/effort",
    "/yolo",
    "/fork",
    "/session",
    "/sessions",
    "/workspace",
    "/workspaces",
    "/rename",
    "/mcp",
    "/skills",
    "/schedule",
    "/personas",
    "/members",
    "/env",
    "/learn",
    "/review",
    "/accept",
    "/reject",
    "/edit",
    "/answer",
    "/stop",
    "/loops",
    "/loop",
    "/rollback",
    "/share",
    "/update",
    "/onboard",
    "/persona",
    "/child",
    "/mode",
    "/parent",
    "/enter",
    "/older",
    "/newer",
    "/script",
]);

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isLocalExec(text) {
    if (text.trimStart().startsWith(": ")) return false;
    const trimmed = text.trimStart();
    return trimmed.startsWith("!") || /^(?:await\s+)?plurnk\.[a-zA-Z0-9_]+\s*\(/u.test(trimmed);
}

/**
 * @param {string} promptText
 * @param {string | null | undefined} projectRoot
 * @returns {string[]}
 */
export function extractOpenPaths(promptText, projectRoot) {
    if (projectRoot === null) return [];
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const paths = [];
    for (const match of promptText.matchAll(/(?:^|\s)@([^\s]+)/gu)) {
        const raw = (match[1] ?? "").replace(/[.,;:!?)]+$/u, "");
        if (!raw || raw.startsWith("/") || raw.includes(":")) continue;
        const segments = raw.split("/");
        if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) continue;
        if (!raw.includes("/") && !/\.[A-Za-z0-9]+$/u.test(raw)) continue;
        if (!seen.has(raw)) {
            seen.add(raw);
            paths.push(raw);
        }
    }
    return paths;
}

/**
 * @param {string} text
 * @param {{ readonly projectRoot?: string | null }} [options]
 * @returns {{ readonly ok: true, readonly scope: "project" | "plurnk", readonly prompt: string } | { readonly ok: false, readonly error: string } | null}
 */
export function resolvePromptCommand(text, options) {
    const trimmed = text.trim();
    if (trimmed !== "/learn" && !trimmed.startsWith("/learn ")) return null;
    const restText = trimmed.slice("/learn".length).trim();
    const tokens = restText.length > 0 ? restText.split(/\s+/u) : [];
    /** @type {string | undefined} */
    let explicitScope;
    /** @type {string[]} */
    const instructionTokens = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i] ?? "";
        if (tok === "--scope") {
            const next = tokens[i + 1];
            if (next === undefined || next.startsWith("--")) {
                return { ok: false, error: "Missing /learn --scope value: expected 'project' or 'plurnk'." };
            }
            explicitScope = next;
            i += 1;
        } else if (tok.startsWith("--scope=")) {
            explicitScope = tok.slice("--scope=".length);
        } else {
            instructionTokens.push(tok);
        }
    }
    if (explicitScope !== undefined && explicitScope !== "project" && explicitScope !== "plurnk") {
        return { ok: false, error: `Invalid /learn scope '${explicitScope}': expected 'project' or 'plurnk'.` };
    }
    if (explicitScope === "project" && options?.projectRoot === null) {
        return {
            ok: false,
            error: "This workspace has no project folder; use /learn --scope plurnk to save under $XDG_CONFIG_HOME/plurnk/skills.",
        };
    }
    /** @type {"project" | "plurnk"} */
    const scope = explicitScope === "plurnk"
        ? "plurnk"
        : explicitScope === "project"
          ? "project"
          : options?.projectRoot === null
            ? "plurnk"
            : "project";
    const targetPath = scope === "plurnk"
        ? "${XDG_CONFIG_HOME:-~/.config}/plurnk/skills/<name>/SKILL.md"
        : ".agents/skills/<name>/SKILL.md";
    const focus = instructionTokens.join(" ");
    const basePrompt = `Distill reusable workflow, setup, or domain knowledge from this session into an Agent Skill at \`${targetPath}\` (read \`mcp:///plurnk/skills.json\` first, write a concise \`SKILL.md\` with YAML frontmatter \`name\` and \`description\`, and verify discovery with the \`skills\` tool).`;
    return {
        ok: true,
        scope,
        prompt: focus ? `${basePrompt}\n\nFocus: ${focus}` : basePrompt,
    };
}

/**
 * @param {string} text
 * @param {{ readonly projectRoot?: string | null }} [options]
 */
export function expandPromptCommand(text, options) {
    const resolved = resolvePromptCommand(text, options);
    return resolved?.ok === true ? resolved.prompt : text;
}

/**
 * @param {string} rawText
 * @param {{ readonly projectRoot?: string | null }} [options]
 * @returns {{ readonly ok: true, readonly prompt: string, readonly forceReview: boolean, readonly openPaths: readonly string[] } | { readonly ok: false, readonly error: string }}
 */
export function prepareComposerPrompt(rawText, options) {
    const trimmedStart = rawText.trimStart();
    if (trimmedStart.startsWith(": ")) {
        const prompt = trimmedStart.slice(2);
        if (!prompt.trim()) return { ok: false, error: "Usage: : <message>" };
        return { ok: true, prompt, forceReview: false, openPaths: extractOpenPaths(prompt, options?.projectRoot) };
    }
    const learn = resolvePromptCommand(rawText, options);
    if (learn !== null) {
        if ("error" in learn) return { ok: false, error: learn.error };
        return { ok: true, prompt: learn.prompt, forceReview: false, openPaths: [] };
    }
    const trimmed = rawText.trim();
    if (trimmed.startsWith("?")) {
        const prompt = trimmed.slice(1).trimStart();
        if (!prompt) return { ok: false, error: "Usage: ? <message>" };
        return { ok: true, prompt, forceReview: true, openPaths: extractOpenPaths(prompt, options?.projectRoot) };
    }
    if (trimmed.startsWith("...")) {
        const prompt = trimmed.slice(3).trimStart();
        if (!prompt) return { ok: false, error: "Usage: ... <message>" };
        return { ok: true, prompt, forceReview: false, openPaths: extractOpenPaths(prompt, options?.projectRoot) };
    }
    return { ok: true, prompt: rawText, forceReview: false, openPaths: extractOpenPaths(rawText, options?.projectRoot) };
}

/**
 * @param {string} text
 * @param {readonly { readonly name: string, readonly type?: string }[]} [availableCommands]
 */
export function isCommand(text, availableCommands = []) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith(": ") || !trimmed.startsWith("/")) return false;
    const match = /^\/(\S*)/u.exec(trimmed);
    const name = match?.[1] ?? "";
    if (name === "learn") return false;
    if (!name || commands.has(name)) return true;
    return !availableCommands.some((entry) => entry?.type !== "skill" && entry?.name === name);
}

/** @param {string} text */
export function parseCommand(text) {
    const match = /^\/(\S*)\s*([\s\S]*)$/u.exec(text.trim());
    if (!match) throw new Error("Expected a slash command.");
    const name = match[1] || "help";
    if (!commands.has(name)) throw new Error(`Unknown command /${name}. Use /help.`);
    const rest = match[2].trim();
    const args = rest ? rest.split(/\s+/u) : [];
    const zeroArg = new Set([
        "yolo", "stop", "update", "workspaces", "sessions", "loops",
        "parent", "enter", "older", "newer", "review", "onboard",
    ]);
    const singleOptionalArg = new Set([
        "help", "effort", "persona", "child", "mode", "fork", "workspace", "session", "loop",
    ]);
    const singleRequiredArg = new Set(["rollback", "rename"]);
    if ((zeroArg.has(name) && args.length > 0)
        || (singleOptionalArg.has(name) && args.length > 1)
        || (singleRequiredArg.has(name) && args.length !== 1)
        || (name === "model" && args.length > 2)
        || (name === "loop" && args[0] !== undefined && !/^[1-9]\d*$/u.test(args[0]))
        || ((name === "share" || name === "script") && rest.length === 0)) {
        throw new Error(`Invalid arguments for /${name}. Use /help ${name}.`);
    }
    return { name, rest, args };
}

/** @param {unknown} rawResult @returns {string} */
function formatExecResults(rawResult) {
    if (!isRecord(rawResult) || !Array.isArray(rawResult.results)) return "";
    return rawResult.results.map((item) => {
        if (!isRecord(item)) return String(item);
        if (typeof item.content === "string" && item.content.length > 0) return item.content;
        if (typeof item.message === "string" && item.message.length > 0) return item.message;
        if (isRecord(item.problem) && typeof item.problem.detail === "string" && item.problem.detail.length > 0) {
            return item.problem.detail;
        }
        if (typeof item.content === "string") return item.content;
        return String(item.status ?? 200);
    }).join("\n");
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
        if (res.removed === true && typeof res.alias === "string") {
            return { message: `${res.alias}  removed` };
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

/** @typedef {import("./session-models.js").Action} Action */
/** @typedef {import("./session-agent.js").SessionGate} SessionGate */
/** @typedef {import("./session-agent.js").GateResolution} GateResolution */

/**
 * @param {readonly SessionGate[]} gates
 * @param {string | undefined} rawTarget
 * @param {string} cmdName
 * @returns {SessionGate}
 */
function selectGate(gates, rawTarget, cmdName) {
    if (rawTarget && rawTarget.startsWith("@") && rawTarget.length >= 2) {
        const id = rawTarget.slice(1);
        const exact = gates.find((g) => g.id === id);
        if (exact) return exact;
        throw new Error(`No pending gate with id @${id}.`);
    }
    if (!rawTarget && gates.length === 1 && gates[0]) {
        return gates[0];
    }
    if (gates.length === 0) {
        throw new Error("No pending gates.");
    }
    throw new Error(`Specify @<id> for /${cmdName}; inspect pending gates with /review.`);
}

/** {§web-session-commands} Native, literal results stay outside the observer's messages and state.
 * @param {Element} controls
 * @param {{
 *   call: Action,
 *   toggleYolo: () => Promise<boolean>,
 *   stop: () => Promise<string>,
 *   getContext?: () => { workspaceName: string, sessionName: string },
 *   getPendingGates?: () => readonly SessionGate[],
 *   resolveGate?: (resolution: GateResolution) => Promise<void> | void,
 *   navigate?: (path: string) => void,
 *   openOnboarding?: () => Promise<void> | void,
 * }} actions
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
        the(article, { "command-state": "pending", "command-busy": "true", "command-message": "Running…", "command-recovery": "" });
        the(panel, "env-busy", "");
        try {
            ctx.signal.throwIfAborted();
            await actions.call(`${targetScope}.env.${operation}`, { alias }, ctx.signal);
            const fresh = await actions.call(`${ctx.listScope}.env.list`, {}, ctx.signal);
            ctx.signal.throwIfAborted();
            populateEnvPanel(panel, fresh, ctx.listScope);
            const verbLabel = operation === "remove" ? "unset" : `${operation}d`;
            the(article, { "command-state": "done", "command-busy": "false", "command-message": `${alias}  ${verbLabel}`, "command-recovery": "" });
        } catch (error) {
            const { message, recovery, status } = await describeFailure(error);
            the(panel, "env-busy", null);
            the(article, { "command-state": "error", "command-busy": "false",
                "command-message": ctx.signal.aborted ? "Response not confirmed." : message, "command-recovery": recovery, "command-status": status });
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
        the(article, { "command-state": "pending", "command-busy": "true", "command-message": "Running…", "command-recovery": "" });
        the(panel, "env-busy", "");
        try {
            ctx.signal.throwIfAborted();
            await actions.call(`${targetScope}.env.replace`, { alias, value }, ctx.signal);
            const fresh = await actions.call(`${ctx.listScope}.env.list`, {}, ctx.signal);
            ctx.signal.throwIfAborted();
            populateEnvPanel(panel, fresh, ctx.listScope);
            aliasInput.value = "";
            valueInput.value = "";
            the(article, { "command-state": "done", "command-busy": "false", "command-message": `${alias}  active`, "command-recovery": "" });
        } catch (error) {
            const { message, recovery, status } = await describeFailure(error);
            the(panel, "env-busy", null);
            the(article, { "command-state": "error", "command-busy": "false",
                "command-message": ctx.signal.aborted ? "Response not confirmed." : message, "command-recovery": recovery, "command-status": status });
        }
    });

    const readIdentity = () => {
        if (actions.getContext) return actions.getContext();
        const workspaceName = $('#session-workspace [data-text="workspace-name"]')?.textContent?.trim()
            || $("#session-workspace")?.textContent?.trim()
            || "default";
        const sessionName = $("#session-status")?.getAttribute("data-session-name") || "session1";
        return { workspaceName, sessionName };
    };

    /** @param {Element} body @param {string} content */
    const appendLiteral = (body, content) => {
        const literal = $.clone(body, "#conversation-literal");
        literal.textContent = content;
    };

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
        the(article, { "command-state": "pending", "command-busy": "true", "command-message": "Running…", "command-recovery": "" });
        try {
            signal.throwIfAborted();
            if (isLocalExec(text)) {
                const trimmed = text.trimStart();
                const stmt = trimmed.startsWith("!")
                    ? (() => {
                        const shellCmd = trimmed.replace(/^!+\s*/u, "");
                        if (!shellCmd) throw new Error("Usage: ! <command>.");
                        return `plurnk.sh(${JSON.stringify({ command: shellCmd })})`;
                    })()
                    : text.trim();
                const res = await call("op.exec", { text: stmt });
                signal.throwIfAborted();
                const out = formatExecResults(res);
                if (out) appendLiteral(body, out);
                the(article, { "command-state": "done", "command-busy": "false", "command-message": out ? "" : "Completed." });
                return true;
            }
            const { name, rest, args } = parseCommand(text);
            if (familyCommands.has(name)) {
                const { workspaceName, sessionName } = readIdentity();
                const settingsUrl = workspaceSettingsPath(workspaceName, sessionName, name);
                const header = $(row, "header");
                const dismiss = header ? $(header, "[data-dismiss-command]") : null;
                if (settingsUrl !== null && header && dismiss) {
                    const openLink = $.clone(header, "#workspace-open-settings");
                    openLink.setAttribute("href", settingsUrl);
                    openLink.setAttribute("data-open-workspace-settings", name);
                    header.insertBefore(openLink, dismiss);
                }
            }
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
            } else if (name === "onboard") {
                await actions.openOnboarding?.();
                message = "Opened model setup.";
            } else if (familyCommands.has(name)) {
                const { parseFamilyCommand } = await import("@plurnk/plurnk-contracts");
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
                    if (formatted.literal) appendLiteral(body, formatted.literal);
                }
            } else if (name === "models") {
                const { aliases: matches, catalog } = await listModels(call, rest);
                signal.throwIfAborted();
                const result = $.clone(body, "#command-models");
                const aliasList = $(result, "[data-model-aliases]");
                const entries = $(result, "tbody");
                if (!aliasList || !entries) throw new Error("Model catalog template is incomplete.");
                $.cloneEach(aliasList, "#command-alias", matches, (item, alias) => the(item, {
                    "alias-name": alias.alias, "alias-route": `${alias.provider}/${alias.model}`,
                    "alias-effort": alias.effort ?? "Unspecified", "alias-active": alias.active ? "Default" : "",
                }));
                $.cloneEach(entries, "#command-model", catalog.items, (item, model) => the(item, {
                    "model-selector": model.selector, "model-name": model.modelName, "model-context": model.limits.contextTokens,
                    "model-efforts": model.capabilities.efforts.join(", "), "model-readiness": model.readiness.ready ? "Configured" : "Not configured",
                }));
                the(result, { "alias-count": matches.length, "model-total": catalog.total, "model-count": catalog.items.length,
                    "model-offset": catalog.offset, "model-more": catalog.nextOffset === undefined ? "" : "More matches are available; narrow the search." });
            } else if (name === "model") {
                const model = await sessionModel(call, args[0], args[1]);
                message = `Model: ${modelLabel(model)}${model?.effort === undefined ? "" : ` (${model.effort})`}.`;
            } else if (name === "effort") {
                const { effort, source, supported } = await sessionEffort(call, args[0]);
                message = `Effort: ${effort ?? "Unavailable"} (${source}). Supported: ${supported.join(", ") || "None"}.`;
            } else if (name === "persona") {
                const { currentValue, supported } = await sessionConfigOption(call, "persona", args[0]);
                message = `Persona: ${currentValue || "none"}. Supported: ${supported.join(", ") || "none"}.`;
            } else if (name === "child") {
                const { currentValue } = await sessionConfigOption(call, "spawn_model", args[0]);
                message = `Child model: ${currentValue || "inherit"}.`;
            } else if (name === "mode") {
                const { currentValue } = await sessionConfigOption(call, "mode", args[0]);
                message = `Approval policy: ${currentValue || "review"}.`;
            } else if (name === "update") {
                const [{ formatServiceUpdateReport }, res] = await Promise.all([
                    import("@plurnk/plurnk-contracts"),
                    call("service.update", {}),
                ]);
                signal.throwIfAborted();
                const report = formatServiceUpdateReport(isRecord(res) ? res : {});
                appendLiteral(body, report);
            } else if (name === "share") {
                const res = await call("workspace.share", { folder: rest });
                const folder = isRecord(res) && typeof res.folder === "string" ? res.folder : rest;
                message = `Shared digest: ${folder}.`;
            } else if (name === "rollback") {
                const res = await call("session.rollback", { to: args[0] });
                const restored = isRecord(res) && Array.isArray(res.restored) ? res.restored.length : 0;
                const skipped = isRecord(res) && Array.isArray(res.skipped) ? res.skipped.length : 0;
                const to = isRecord(res) && typeof res.to === "string" ? res.to : args[0];
                message = `Rolled back to ${to} (${restored} restored, ${skipped} skipped).`;
            } else if (name === "script") {
                const res = await call("op.exec", { text: rest });
                signal.throwIfAborted();
                const out = formatExecResults(res);
                if (out) appendLiteral(body, out);
                message = out ? "" : "Completed.";
            } else if (name === "workspaces") {
                const res = await call("workspace.list", {});
                signal.throwIfAborted();
                const items = isRecord(res) && Array.isArray(res.workspaces) ? res.workspaces : [];
                if (items.length === 0) {
                    message = "workspaces: none";
                } else {
                    const lines = items.map((w) => {
                        if (!isRecord(w)) return String(w);
                        const wsName = typeof w.name === "string" ? w.name : "";
                        const root = typeof w.project_root === "string" ? w.project_root
                            : typeof w.projectRoot === "string" ? w.projectRoot : "(folderless)";
                        return `${wsName}  ${root}`;
                    });
                    appendLiteral(body, lines.join("\n"));
                }
            } else if (name === "workspace") {
                const { workspaceName } = readIdentity();
                if (!args[0]) {
                    message = `Workspace: ${workspaceName}.`;
                } else {
                    const targetPath = directoryPath({ kind: "workspace", workspace: args[0] });
                    if (!targetPath) throw new Error(`Invalid workspace address: ${args[0]}.`);
                    message = `Workspace: ${args[0]}.`;
                    actions.navigate?.(targetPath);
                }
            } else if (name === "rename") {
                const { workspaceName, sessionName } = readIdentity();
                const res = await call("workspace.rename", { from: workspaceName, name: args[0] });
                const nextName = isRecord(res) && typeof res.name === "string" ? res.name : args[0];
                message = `Workspace: ${nextName}.`;
                const targetPath = directoryPath({ kind: "session", workspace: nextName, session: sessionName });
                if (targetPath) actions.navigate?.(targetPath);
            } else if (name === "sessions") {
                const { sessionName } = readIdentity();
                const res = await call("workspace.sessions", {});
                signal.throwIfAborted();
                const items = isRecord(res) && Array.isArray(res.sessions) ? res.sessions : [];
                if (items.length === 0) {
                    message = `● ${sessionName}`;
                } else {
                    const lines = items.map((s) => {
                        if (!isRecord(s)) return String(s);
                        const sName = typeof s.name === "string" ? s.name : "";
                        const mark = sName === sessionName ? "●" : "○";
                        const lc = typeof s.lifecycle === "string" && s.lifecycle !== "idle" && s.lifecycle !== "completed"
                            ? ` (${s.lifecycle})`
                            : "";
                        return `${mark} ${sName}${lc}`;
                    });
                    appendLiteral(body, lines.join("\n"));
                }
            } else if (name === "session") {
                const { workspaceName, sessionName } = readIdentity();
                if (!args[0]) {
                    const curPath = directoryPath({ kind: "session", workspace: workspaceName, session: sessionName }) ?? "";
                    message = `Session: ${sessionName}${curPath ? ` (${curPath})` : ""}.`;
                } else {
                    await call("session/new", { _meta: { plurnk: { workspace: workspaceName, session: args[0] } } });
                    const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: args[0] });
                    message = `Session: ${args[0]}.`;
                    if (targetPath) actions.navigate?.(targetPath);
                }
            } else if (name === "fork") {
                const { workspaceName } = readIdentity();
                const res = await call("session/fork", args[0] ? { name: args[0] } : {});
                const rawSessionId = isRecord(res) && typeof res.sessionId === "string" ? res.sessionId : "";
                const forkedName = rawSessionId.includes("#") ? (rawSessionId.split("#")[1] ?? "") : (args[0] ?? "");
                if (!forkedName) throw new Error("Fork response returned no session name.");
                message = `Forked session: ${forkedName}.`;
                const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: forkedName });
                if (targetPath) actions.navigate?.(targetPath);
            } else if (name === "parent" || name === "enter" || name === "older" || name === "newer") {
                const { workspaceName, sessionName } = readIdentity();
                const res = await call("workspace.sessions", {});
                signal.throwIfAborted();
                const rawSessions = isRecord(res) && Array.isArray(res.sessions) ? res.sessions : [];
                const sessions = rawSessions.filter((s) => isRecord(s) && s.origin !== "maintenance" && s.origin !== "scratch");
                const current = sessions.find((s) => isRecord(s) && s.name === sessionName);
                const parentIdOf = (/** @type {unknown} */ s) => isRecord(s) && typeof s.parentSessionId === "number" ? s.parentSessionId : null;
                /** @type {string | null} */
                let targetName = null;
                if (name === "parent") {
                    const pid = parentIdOf(current);
                    const parent = pid !== null ? sessions.find((s) => isRecord(s) && s.id === pid) : undefined;
                    if (!isRecord(parent) || typeof parent.name !== "string") {
                        message = "(at the root: no parent)";
                    } else {
                        targetName = parent.name;
                    }
                } else if (name === "enter") {
                    const curId = isRecord(current) && typeof current.id === "number" ? current.id : null;
                    const children = curId !== null ? sessions.filter((s) => parentIdOf(s) === curId) : [];
                    const newest = children.at(-1);
                    if (!isRecord(newest) || typeof newest.name !== "string") {
                        message = "(no children)";
                    } else {
                        targetName = newest.name;
                    }
                } else {
                    const pid = parentIdOf(current);
                    const siblings = sessions.filter((s) => parentIdOf(s) === pid);
                    if (siblings.length <= 1) {
                        message = "(no siblings)";
                    } else {
                        const idx = siblings.findIndex((s) => isRecord(s) && s.name === sessionName);
                        const nextIdx = name === "older"
                            ? (idx - 1 + siblings.length) % siblings.length
                            : (idx + 1) % siblings.length;
                        const chosen = siblings[nextIdx];
                        if (isRecord(chosen) && typeof chosen.name === "string") targetName = chosen.name;
                    }
                }
                if (targetName) {
                    message = `Session: ${targetName}.`;
                    const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: targetName });
                    if (targetPath) actions.navigate?.(targetPath);
                }
            } else if (name === "loops" || name === "loop") {
                const reqSeq = name === "loop" && args[0] ? Number.parseInt(args[0], 10) : undefined;
                const res = await call("session.loops", reqSeq !== undefined ? { loopSeq: reqSeq } : {});
                signal.throwIfAborted();
                const items = (isRecord(res) && Array.isArray(res.items) ? res.items : [])
                    .filter(isRecord)
                    .toSorted((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
                if (items.length === 0) {
                    message = "(no loops yet)";
                } else if (name === "loops") {
                    const lines = items.map((l) => {
                        const seq = String(l.sequence ?? "");
                        const rawPrompt = typeof l.prompt === "string" ? l.prompt : "";
                        const firstLine = rawPrompt.split(/\r?\n/u).map((s) => s.trim()).find(Boolean) ?? "";
                        const clipped = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
                        return `${seq}: ${clipped}`;
                    });
                    appendLiteral(body, lines.join("\n"));
                } else {
                    const targetSeq = reqSeq ?? Number(items.at(-1)?.sequence ?? 1);
                    const targetLoop = items.find((i) => Number(i.sequence) === targetSeq);
                    if (!targetLoop) {
                        message = `(no loop ${targetSeq}; /loops lists them)`;
                    } else {
                        const detail = reqSeq !== undefined ? res : await call("session.loops", { loopSeq: targetSeq });
                        const updates = isRecord(detail) && Array.isArray(detail.updates) ? detail.updates : [];
                        const lines = [`── loop ${targetSeq} ──`];
                        if (typeof targetLoop.prompt === "string" && targetLoop.prompt) {
                            lines.push(`> ${targetLoop.prompt}`);
                        }
                        for (const u of updates) {
                            if (!isRecord(u)) continue;
                            if (u.sessionUpdate === "tool_call_update" && typeof u.title === "string") {
                                lines.push(u.title);
                            } else if (u.sessionUpdate === "agent_message" && Array.isArray(u.content)) {
                                const msgText = u.content
                                    .map((c) => isRecord(c) && typeof c.text === "string" ? c.text : "")
                                    .join("");
                                if (msgText) lines.push(msgText);
                            }
                        }
                        appendLiteral(body, lines.join("\n"));
                    }
                }
            } else if (name === "review") {
                const gates = actions.getPendingGates?.() ?? [];
                if (gates.length === 0) {
                    message = "review: none";
                } else {
                    const lines = gates.map((g) => {
                        if (g.method === "session/request_permission") {
                            const facts = g._meta?.plurnk?.proposal;
                            const label = facts ? `${facts.session} ${facts.op}` : "permission";
                            return `@${g.id}  permission  ${label}`;
                        }
                        return `@${g.id}  elicitation  ${g.message ?? "input required"}`;
                    });
                    appendLiteral(body, lines.join("\n"));
                }
            } else if (name === "accept" || name === "approve" || name === "reject" || name === "cancel" || name === "edit" || name === "answer") {
                if (!actions.resolveGate) throw new Error("Gate resolution is unavailable outside an active session.");
                const gates = actions.getPendingGates?.() ?? [];
                const hasExplicitId = args[0]?.startsWith("@") === true;
                const gate = selectGate(gates, hasExplicitId ? args[0] : undefined, name);
                if (name === "edit") {
                    if (gate.method !== "session/request_permission") {
                        throw new Error(`Gate @${gate.id} is not a permission proposal.`);
                    }
                    const bodyMatch = hasExplicitId
                        ? /^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim())
                        : /^\/\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim());
                    const editedBody = bodyMatch?.[1] ?? "";
                    if (!editedBody) throw new Error("Usage: /edit [@id] <body...>.");
                    await actions.resolveGate({
                        id: gate.id,
                        method: "session/request_permission",
                        response: {
                            outcome: { outcome: "selected", optionId: allowOptionId(gate) },
                            _meta: { plurnk: { body: editedBody } },
                        },
                    });
                    message = `Submitted edited proposal @${gate.id}.`;
                } else if (name === "answer") {
                    if (gate.method !== "elicitation/create") {
                        throw new Error(`Gate @${gate.id} is not an elicitation request.`);
                    }
                    const payloadMatch = hasExplicitId
                        ? /^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim())
                        : /^\/\S+(?:\r?\n|[ \t])([\s\S]*)$/u.exec(text.trim());
                    const rawPayload = (payloadMatch?.[1] ?? "").trim();
                    /** @type {Record<string, unknown>} */
                    let content = {};
                    if (rawPayload) {
                        try {
                            const parsedJson = /** @type {unknown} */ (JSON.parse(rawPayload));
                            content = isRecord(parsedJson) ? parsedJson : { answer: parsedJson };
                        } catch {
                            content = { answer: rawPayload };
                        }
                    }
                    await actions.resolveGate({
                        id: gate.id,
                        method: "elicitation/create",
                        response: { action: "accept", content },
                    });
                    message = `Submitted answer for @${gate.id}.`;
                } else if (name === "cancel") {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "cancelled" } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "cancel" } });
                    message = `Cancelled @${gate.id}.`;
                } else if (name === "reject") {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: rejectOptionId(gate) } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "decline" } });
                    message = `Rejected @${gate.id}.`;
                } else {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: allowOptionId(gate) } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "accept" } });
                    message = `Accepted @${gate.id}.`;
                }
            }
            signal.throwIfAborted();
            the(article, { "command-state": "done", "command-busy": "false", "command-message": message });
            return true;
        } catch (error) {
            const { message, recovery, status } = await describeFailure(error);
            the(article, { "command-state": "error", "command-busy": "false",
                "command-message": signal.aborted ? "Response not confirmed." : message, "command-recovery": recovery, "command-status": status });
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
