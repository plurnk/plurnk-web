import { $, on, the } from "on_the_money";
import { directoryPath, workspaceSettingsPath } from "../src/directory-addresses.js";
import { isRecord } from "./session-translator.js";
import { sessionConfigOption, sessionEffort, sessionModel, modelLabel } from "./session-models.js";
import { allowOptionId, rejectOptionId } from "./session-review.js";
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
    "/approve",
    "/reject",
    "/cancel",
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

const ZERO_ARG_COMMANDS = new Set([
    "/yolo",
    "/stop",
    "/onboard",
    "/update",
    "/workspaces",
    "/sessions",
    "/loops",
    "/review",
    "/parent",
    "/enter",
    "/older",
    "/newer",
]);

const FAMILY_SUBCOMMANDS = Object.freeze({
    mcp: ["list", "enable", "disable", "remove", "oauth", "discover", "add", "replace", "skills", "complete"],
    skills: ["list", "enable", "disable", "remove", "discover", "add", "replace"],
    schedule: ["list", "run", "enable", "disable", "done", "reopen", "remove", "discover", "add", "replace"],
    personas: ["list", "enable", "disable", "remove", "discover", "add", "replace"],
    members: ["list", "enable", "disable", "remove", "discover", "add"],
    env: ["list", "set", "unset", "enable", "disable", "remove", "--scope"],
});

const FAMILY_ALIAS_SUBS = new Set(["enable", "disable", "remove", "oauth", "run", "done", "reopen", "unset"]);

/**
 * @typedef {{
 *   readonly availableCommands?: readonly { readonly name: string, readonly type?: string }[],
 *   readonly promptSuggestions?: readonly string[],
 *   readonly models?: readonly string[],
 *   readonly efforts?: readonly string[],
 *   readonly personas?: readonly string[],
 *   readonly childModels?: readonly string[],
 *   readonly modes?: readonly string[],
 *   readonly workspaces?: readonly string[],
 *   readonly sessions?: readonly string[],
 *   readonly loops?: readonly string[],
 *   readonly gateIds?: readonly string[],
 *   readonly familyAliases?: Partial<Record<"mcp" | "skills" | "schedule" | "personas" | "members" | "env", readonly string[]>>,
 * }} SuggestionSources
 */

/**
 * @param {readonly string[]} candidates
 * @param {string} partial
 * @param {boolean} terminal
 * @returns {readonly string[]}
 */
function filterCandidates(candidates, partial, terminal) {
    const seen = new Set();
    /** @type {string[]} */
    const unique = [];
    for (const raw of candidates) {
        if (typeof raw !== "string" || !raw || seen.has(raw)) continue;
        seen.add(raw);
        unique.push(raw);
    }
    const needle = partial.toLowerCase();
    if (!needle) return unique;
    const prefixMatches = unique.filter((item) => item.toLowerCase().startsWith(needle));
    const substringMatches = unique.filter((item) => !item.toLowerCase().startsWith(needle) && item.toLowerCase().includes(needle));
    const combined = [...prefixMatches, ...substringMatches];
    if (terminal && combined.length === 1 && combined[0] === partial) {
        return [];
    }
    return combined;
}

/**
 * @param {string} cmd
 * @param {readonly string[]} completedArgs
 * @param {SuggestionSources} sources
 * @returns {{ candidates: readonly string[], advances: boolean }}
 */
function resolveArgumentStage(cmd, completedArgs, sources) {
    if (cmd === "model") {
        if (completedArgs.length === 0) {
            return { candidates: sources.models ?? [], advances: (sources.efforts?.length ?? 0) > 0 };
        }
        if (completedArgs.length === 1) {
            return { candidates: sources.efforts ?? [], advances: false };
        }
        return { candidates: [], advances: false };
    }
    if (cmd === "effort") {
        return completedArgs.length === 0
            ? { candidates: sources.efforts ?? [], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "persona") {
        return completedArgs.length === 0
            ? { candidates: sources.personas ?? ["none"], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "child") {
        return completedArgs.length === 0
            ? { candidates: ["inherit", ...(sources.childModels ?? sources.models ?? [])], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "mode") {
        return completedArgs.length === 0
            ? { candidates: sources.modes ?? ["review", "accept", "reject"], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "workspace") {
        return completedArgs.length === 0
            ? { candidates: sources.workspaces ?? [], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "session") {
        return completedArgs.length === 0
            ? { candidates: sources.sessions ?? [], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "loop") {
        return completedArgs.length === 0
            ? { candidates: sources.loops ?? [], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "help") {
        return completedArgs.length === 0
            ? { candidates: [...helpCommands], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "learn") {
        if (completedArgs.length === 0) {
            return { candidates: ["--scope"], advances: true };
        }
        if (completedArgs.length === 1 && completedArgs[0] === "--scope") {
            return { candidates: ["project", "plurnk"], advances: true };
        }
        return { candidates: [], advances: false };
    }
    if (cmd === "accept" || cmd === "approve" || cmd === "reject" || cmd === "cancel") {
        return completedArgs.length === 0
            ? { candidates: sources.gateIds ?? [], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "edit" || cmd === "answer") {
        return completedArgs.length === 0
            ? { candidates: sources.gateIds ?? [], advances: true }
            : { candidates: [], advances: false };
    }
    if (cmd === "env") {
        const envVars = sources.familyAliases?.env ?? [];
        if (completedArgs[0] === "--scope") {
            if (completedArgs.length === 1) return { candidates: ["session", "workspace"], advances: true };
            if (completedArgs.length === 2) return { candidates: ["list", "set", "unset", "enable", "disable", "remove"], advances: true };
            if (completedArgs.length === 3 && FAMILY_ALIAS_SUBS.has(completedArgs[2] ?? "")) {
                return { candidates: envVars, advances: false };
            }
            return { candidates: [], advances: false };
        }
        if (completedArgs.length === 0) {
            return { candidates: FAMILY_SUBCOMMANDS.env, advances: true };
        }
        if (completedArgs.length === 1 && FAMILY_ALIAS_SUBS.has(completedArgs[0] ?? "")) {
            return { candidates: envVars, advances: false };
        }
        return { candidates: [], advances: false };
    }
    if (cmd === "mcp" || cmd === "skills" || cmd === "schedule" || cmd === "personas" || cmd === "members") {
        if (completedArgs.length === 0) {
            return { candidates: FAMILY_SUBCOMMANDS[cmd], advances: true };
        }
        const sub = completedArgs[0] ?? "";
        if (completedArgs.length === 1 && FAMILY_ALIAS_SUBS.has(sub)) {
            const aliases = sources.familyAliases?.[cmd] ?? [];
            return { candidates: aliases, advances: sub === "oauth" };
        }
        if (cmd === "mcp" && completedArgs.length === 2 && sub === "oauth") {
            return { candidates: ["begin", "complete"], advances: false };
        }
        return { candidates: [], advances: false };
    }
    return { candidates: [], advances: false };
}

/**
 * {§web-session-commands} {§web-session-input} Compute live-narrowing pill candidates across command and argument stages.
 * @param {string} rawInput
 * @param {SuggestionSources} [sources]
 * @param {{ readonly allowPromptSuggestions?: boolean }} [options]
 * @returns {{ readonly kind: "command" | "arg" | "skill" | "prompt", readonly items: readonly string[], readonly advances: boolean }}
 */
export function computeCommandSuggestions(rawInput, sources = {}, options = {}) {
    const available = sources.availableCommands ?? [];
    const slashMatch = /^\s*\/([a-z0-9_-]*)$/iu.exec(rawInput);
    if (slashMatch) {
        const typed = (slashMatch[1] ?? "").toLowerCase();
        const prefix = `/${typed}`;
        const dynamic = available
            .filter((c) => c.type !== "skill" && typeof c.name === "string" && c.name.length > 0)
            .map((c) => `/${c.name}`);
        const skills = typed === ""
            ? available
                .filter((c) => c.type === "skill" && typeof c.name === "string" && c.name.length > 0)
                .map((c) => `$${c.name}`)
            : [];
        const all = [...new Set([...SLASH_COMMAND_NAMES, ...dynamic])];
        const matches = all.filter((cmd) => cmd.toLowerCase().startsWith(prefix));
        if (matches.length === 1 && matches[0] === prefix && ZERO_ARG_COMMANDS.has(prefix)) {
            return { kind: "command", items: [], advances: false };
        }
        return { kind: "command", items: [...matches, ...skills], advances: true };
    }

    const trimmedStart = rawInput.trimStart();
    if (!trimmedStart.startsWith(": ") && !rawInput.includes("\n")) {
        const argMatch = /^\/([a-z0-9_-]+)\s+([\s\S]*)$/iu.exec(trimmedStart);
        if (argMatch) {
            const cmd = (argMatch[1] ?? "").toLowerCase();
            const restRaw = argMatch[2] ?? "";
            const endsWithSpace = restRaw === "" || /\s$/u.test(restRaw);
            const parts = restRaw.trim() ? restRaw.trim().split(/\s+/u) : [];
            const completedArgs = endsWithSpace ? parts : parts.slice(0, -1);
            const partial = endsWithSpace ? "" : (parts.at(-1) ?? "");
            const { candidates, advances } = resolveArgumentStage(cmd, completedArgs, sources);
            const items = filterCandidates(candidates, partial, !advances);
            if (items.length > 0) {
                return { kind: "arg", items, advances };
            }
        }
    }

    const skillMatch = /(?:^|\s)\$([a-z0-9_-]*)$/iu.exec(rawInput);
    if (skillMatch) {
        const prefix = (skillMatch[1] ?? "").toLowerCase();
        const skills = available
            .filter((c) => c.type === "skill" && typeof c.name === "string" && c.name.toLowerCase().startsWith(prefix))
            .map((c) => `$${c.name}`);
        if (skills.length > 0) return { kind: "skill", items: skills, advances: true };
    }

    const prompts = rawInput === "" && options.allowPromptSuggestions === true
        ? (sources.promptSuggestions ?? [])
        : [];
    return { kind: "prompt", items: prompts, advances: false };
}

/**
 * {§web-session-commands} {§web-session-input} Apply a chosen pill or `Tab` completion to `rawInput`.
 * @param {string} rawInput
 * @param {string} suggestion
 * @param {SuggestionSources} [sources]
 * @returns {string}
 */
export function acceptCommandSuggestion(rawInput, suggestion, sources = {}) {
    const text = suggestion.trim();
    if (!text) return rawInput;
    if (text.startsWith("$") && /(?:^|\s)\$[a-z0-9_-]*$/iu.test(rawInput)) {
        return rawInput.replace(/\$[a-z0-9_-]*$/iu, `${text} `);
    }
    if (text.startsWith("$") && /^\s*\/$/u.test(rawInput)) {
        return `${text} `;
    }
    if (text.startsWith("/") && /^\s*\/[a-z0-9_-]*$/iu.test(rawInput)) {
        return ZERO_ARG_COMMANDS.has(text) ? text : `${text} `;
    }
    const trimmedStart = rawInput.trimStart();
    if (!trimmedStart.startsWith(": ") && !rawInput.includes("\n")) {
        const argMatch = /^\/([a-z0-9_-]+)\s+([\s\S]*)$/iu.exec(trimmedStart);
        if (argMatch) {
            const cmd = (argMatch[1] ?? "").toLowerCase();
            const restRaw = argMatch[2] ?? "";
            const endsWithSpace = restRaw === "" || /\s$/u.test(restRaw);
            const parts = restRaw.trim() ? restRaw.trim().split(/\s+/u) : [];
            const completedArgs = endsWithSpace ? parts : parts.slice(0, -1);
            const { advances } = resolveArgumentStage(cmd, completedArgs, sources);
            const nextSubAdvances = (cmd === "mcp" || cmd === "skills" || cmd === "schedule" || cmd === "personas" || cmd === "members" || cmd === "env")
                && completedArgs.length === 0
                ? text !== "list"
                : advances;
            const prefixTokens = [`/${argMatch[1]}`, ...completedArgs, text].join(" ");
            return nextSubAdvances ? `${prefixTokens} ` : prefixTokens;
        }
    }
    return text;
}

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
        "help", "effort", "persona", "child", "mode", "fork", "session", "loop",
    ]);
    const singleRequiredArg = new Set(["rollback"]);
    if ((zeroArg.has(name) && args.length > 0)
        || (singleOptionalArg.has(name) && args.length > 1)
        || (singleRequiredArg.has(name) && args.length !== 1)
        || (name === "rename" && rest.length === 0)
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
            const verb = family === "env" ? "unset" : "removed";
            return { message: `${res.alias}  ${verb}` };
        }
        if (isRecord(res.definition) && typeof res.definition.alias === "string") {
            const state = typeof res.definition.state === "string" ? res.definition.state : "active";
            return { message: `${res.definition.alias}  ${state}` };
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

/**
 * {§web-session-commands} Route inspection commands to canonical UI surfaces, mutations to `#session-feedback`, and multi-line CLI output to `#dialog-command-output`.
 * @param {Element} main
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
export default function sessionCommands(main, actions) {
    const ensureFeedback = () => {
        const existing = $(main, '[aria-label="Message feedback"]');
        if (existing instanceof HTMLElement) return existing;
        const cloned = $.clone(main, "#session-feedback");
        if (!(cloned instanceof HTMLElement)) throw new Error("Session feedback template is incomplete.");
        return cloned;
    };

    /** @type {HTMLDialogElement | null} */
    let outputDialog = null;
    const ensureOutputDialog = () => {
        if (outputDialog && outputDialog.isConnected) return outputDialog;
        const existing = $("#dialog-command-output");
        if (existing instanceof HTMLDialogElement) {
            outputDialog = existing;
            return outputDialog;
        }
        const cloned = $.clone(document.body, "#command-output-dialog");
        if (!(cloned instanceof HTMLDialogElement)) throw new Error("Command output dialog template is incomplete.");
        on(cloned, "click", "[data-dialog-close]", () => {
            if (cloned.open) cloned.close();
        });
        outputDialog = cloned;
        return cloned;
    };

    /**
     * @param {string} title
     * @param {string} literal
     * @param {string} [message]
     */
    const showOutputModal = (title, literal, message = "") => {
        const dialog = ensureOutputDialog();
        the(dialog, {
            "command-title": title,
            "command-message": message,
            "command-literal": literal,
        });
        if (!dialog.open) dialog.showModal();
    };

    /** @param {string} message */
    const showStatus = (message) => {
        const feedback = ensureFeedback();
        the(feedback, { "message-status": message, "command-error": "" });
    };

    /** @param {string} errorText */
    const showError = (errorText) => {
        const feedback = ensureFeedback();
        the(feedback, { "message-status": "", "command-error": errorText });
    };

    const readIdentity = () => {
        if (actions.getContext) return actions.getContext();
        const workspaceName = $('#session-workspace [data-text="workspace-name"]')?.textContent?.trim()
            || $("#session-workspace")?.textContent?.trim()
            || "default";
        const sessionName = $("#session-status")?.getAttribute("data-session-name") || "session1";
        return { workspaceName, sessionName };
    };

    /**
     * @param {string} section
     * @param {Readonly<Record<string, string | null | undefined>>} [extra]
     */
    const navigateToSettings = (section, extra = undefined) => {
        const { workspaceName, sessionName } = readIdentity();
        const targetPath = workspaceSettingsPath(workspaceName, sessionName, section, extra);
        if (!targetPath) throw new Error(`Invalid workspace settings address: ${workspaceName}.`);
        if (actions.navigate) {
            actions.navigate(targetPath);
        } else {
            location.assign(targetPath);
        }
    };

    /** @param {string} text @param {AbortSignal} signal */
    const execute = async (text, signal) => {
        /** @type {Action} */
        const call = (kind, params) => actions.call(kind, params, signal);
        const feedback = ensureFeedback();
        the(feedback, { "command-error": "" });
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
                if (out) {
                    showOutputModal(trimmed, out);
                } else {
                    showStatus("Completed.");
                }
                return true;
            }

            const { name, rest, args } = parseCommand(text);
            if (name === "help") {
                const selected = rest.replace(/^\//u, "");
                if (selected && !helpCommands.has(selected)) throw new Error(`Unknown command ${rest}. Use /help.`);
                navigateToSettings("help", selected ? { cmd: selected } : undefined);
                return true;
            }
            if (name === "onboard") {
                if (actions.openOnboarding) {
                    await actions.openOnboarding();
                } else {
                    navigateToSettings("models", { setup: "1" });
                }
                return true;
            }
            if (name === "models") {
                navigateToSettings("models", rest ? { q: rest } : undefined);
                return true;
            }
            if (name === "yolo") {
                showStatus(`Approvals: ${await actions.toggleYolo() ? "Automatic" : "Manual"}.`);
                return true;
            }
            if (name === "stop") {
                showStatus(await actions.stop());
                return true;
            }
            if (familyCommands.has(name)) {
                const { parseFamilyCommand } = await import("@plurnk/plurnk-contracts");
                const parsed = parseFamilyCommand(name, args);
                if (parsed.sub === "list") {
                    navigateToSettings(name, name === "env" && parsed.scopePrefix === "session" ? { envScope: "session" } : undefined);
                    return true;
                }
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
                const formatted = formatFamilyResult(name, parsed, res);
                if (formatted.literal) {
                    showOutputModal(text.trim(), formatted.literal, formatted.message);
                } else {
                    showStatus(formatted.message);
                }
                return true;
            }
            if (name === "model") {
                if (!args[0]) {
                    navigateToSettings("models");
                    return true;
                }
                const model = await sessionModel(call, args[0], args[1]);
                showStatus(`Model: ${modelLabel(model)}${model?.effort === undefined ? "" : ` (${model.effort})`}.`);
                return true;
            }
            if (name === "effort") {
                if (!args[0]) {
                    navigateToSettings("models");
                    return true;
                }
                const { effort, source, supported } = await sessionEffort(call, args[0]);
                showStatus(`Effort: ${effort ?? "Unavailable"} (${source}). Supported: ${supported.join(", ") || "None"}.`);
                return true;
            }
            if (name === "persona") {
                if (!args[0]) {
                    navigateToSettings("personas");
                    return true;
                }
                const { currentValue, supported } = await sessionConfigOption(call, "persona", args[0]);
                showStatus(`Persona: ${currentValue || "none"}. Supported: ${supported.join(", ") || "none"}.`);
                return true;
            }
            if (name === "child") {
                if (!args[0]) {
                    navigateToSettings("models");
                    return true;
                }
                const { currentValue } = await sessionConfigOption(call, "spawn_model", args[0]);
                showStatus(`Child model: ${currentValue || "inherit"}.`);
                return true;
            }
            if (name === "mode") {
                if (!args[0]) {
                    navigateToSettings("general");
                    return true;
                }
                const { currentValue } = await sessionConfigOption(call, "mode", args[0]);
                showStatus(`Approval policy: ${currentValue || "review"}.`);
                return true;
            }
            if (name === "update") {
                const [{ formatServiceUpdateReport }, res] = await Promise.all([
                    import("@plurnk/plurnk-contracts"),
                    call("service.update", {}),
                ]);
                signal.throwIfAborted();
                const report = formatServiceUpdateReport(isRecord(res) ? res : {});
                showOutputModal("/update", report);
                return true;
            }
            if (name === "share") {
                const res = await call("workspace.share", { folder: rest });
                const folder = isRecord(res) && typeof res.folder === "string" ? res.folder : rest;
                showStatus(`Shared digest: ${folder}.`);
                return true;
            }
            if (name === "rollback") {
                const res = await call("session.rollback", { to: args[0] });
                const restored = isRecord(res) && Array.isArray(res.restored) ? res.restored.length : 0;
                const skipped = isRecord(res) && Array.isArray(res.skipped) ? res.skipped.length : 0;
                const to = isRecord(res) && typeof res.to === "string" ? res.to : args[0];
                showStatus(`Rolled back to ${to} (${restored} restored, ${skipped} skipped).`);
                return true;
            }
            if (name === "script") {
                const res = await call("op.exec", { text: rest });
                signal.throwIfAborted();
                const out = formatExecResults(res);
                if (out) {
                    showOutputModal(text.trim(), out);
                } else {
                    showStatus("Completed.");
                }
                return true;
            }
            if (name === "workspaces" || (name === "workspace" && !rest)) {
                const wsDialog = $("#dialog-workspaces");
                if (wsDialog instanceof HTMLDialogElement) {
                    if (!wsDialog.open) wsDialog.showModal();
                    return true;
                }
                const res = await call("workspace.list", {});
                signal.throwIfAborted();
                const items = isRecord(res) && Array.isArray(res.workspaces) ? res.workspaces : [];
                if (items.length === 0) {
                    showStatus("workspaces: none");
                } else {
                    const lines = items.map((w) => {
                        if (!isRecord(w)) return String(w);
                        const wsName = typeof w.name === "string" ? w.name : "";
                        const root = typeof w.project_root === "string" ? w.project_root
                            : typeof w.projectRoot === "string" ? w.projectRoot : "(folderless)";
                        return `${wsName}  ${root}`;
                    });
                    showOutputModal("/workspaces", lines.join("\n"));
                }
                return true;
            }
            if (name === "workspace") {
                const targetPath = directoryPath({ kind: "workspace", workspace: rest });
                if (!targetPath) throw new Error(`Invalid workspace address: ${rest}.`);
                if (actions.navigate) actions.navigate(targetPath);
                else location.assign(targetPath);
                return true;
            }
            if (name === "rename") {
                const { workspaceName, sessionName } = readIdentity();
                const res = await call("workspace.rename", { from: workspaceName, name: rest });
                const nextName = isRecord(res) && typeof res.name === "string" ? res.name : rest;
                showStatus(`Workspace: ${nextName}.`);
                const targetPath = directoryPath({ kind: "session", workspace: nextName, session: sessionName });
                if (targetPath) actions.navigate?.(targetPath);
                return true;
            }
            if (name === "sessions" || (name === "session" && !args[0])) {
                const openSessionsBtn = $("[data-open-sessions]");
                if (openSessionsBtn instanceof HTMLButtonElement) {
                    openSessionsBtn.click();
                    return true;
                }
                const { sessionName } = readIdentity();
                const res = await call("workspace.sessions", {});
                signal.throwIfAborted();
                const items = isRecord(res) && Array.isArray(res.sessions) ? res.sessions : [];
                if (items.length === 0) {
                    showStatus(`● ${sessionName}`);
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
                    showOutputModal("/sessions", lines.join("\n"));
                }
                return true;
            }
            if (name === "session") {
                const { workspaceName } = readIdentity();
                await call("session/new", { _meta: { plurnk: { workspace: workspaceName, session: args[0] } } });
                const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: args[0] });
                showStatus(`Session: ${args[0]}.`);
                if (targetPath) actions.navigate?.(targetPath);
                return true;
            }
            if (name === "fork") {
                const { workspaceName } = readIdentity();
                const res = await call("session/fork", args[0] ? { name: args[0] } : {});
                const rawSessionId = isRecord(res) && typeof res.sessionId === "string" ? res.sessionId : "";
                const forkedName = rawSessionId.includes("#") ? (rawSessionId.split("#")[1] ?? "") : (args[0] ?? "");
                if (!forkedName) throw new Error("Fork response returned no session name.");
                showStatus(`Forked session: ${forkedName}.`);
                const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: forkedName });
                if (targetPath) actions.navigate?.(targetPath);
                return true;
            }
            if (name === "parent" || name === "enter" || name === "older" || name === "newer") {
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
                        showStatus("(at the root: no parent)");
                        return true;
                    }
                    targetName = parent.name;
                } else if (name === "enter") {
                    const curId = isRecord(current) && typeof current.id === "number" ? current.id : null;
                    const children = curId !== null ? sessions.filter((s) => parentIdOf(s) === curId) : [];
                    const newest = children.at(-1);
                    if (!isRecord(newest) || typeof newest.name !== "string") {
                        showStatus("(no children)");
                        return true;
                    }
                    targetName = newest.name;
                } else {
                    const pid = parentIdOf(current);
                    const siblings = sessions.filter((s) => parentIdOf(s) === pid);
                    if (siblings.length <= 1) {
                        showStatus("(no siblings)");
                        return true;
                    }
                    const idx = siblings.findIndex((s) => isRecord(s) && s.name === sessionName);
                    const nextIdx = name === "older"
                        ? (idx - 1 + siblings.length) % siblings.length
                        : (idx + 1) % siblings.length;
                    const chosen = siblings[nextIdx];
                    if (isRecord(chosen) && typeof chosen.name === "string") targetName = chosen.name;
                }
                if (targetName) {
                    showStatus(`Session: ${targetName}.`);
                    const targetPath = directoryPath({ kind: "session", workspace: workspaceName, session: targetName });
                    if (targetPath) actions.navigate?.(targetPath);
                }
                return true;
            }
            if (name === "loops" || name === "loop") {
                const reqSeq = name === "loop" && args[0] ? Number.parseInt(args[0], 10) : undefined;
                const res = await call("session.loops", reqSeq !== undefined ? { loopSeq: reqSeq } : {});
                signal.throwIfAborted();
                const items = (isRecord(res) && Array.isArray(res.items) ? res.items : [])
                    .filter(isRecord)
                    .toSorted((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
                if (items.length === 0) {
                    showStatus("(no loops yet)");
                    return true;
                }
                if (name === "loops") {
                    const lines = items.map((l) => {
                        const seq = String(l.sequence ?? "");
                        const rawPrompt = typeof l.prompt === "string" ? l.prompt : "";
                        const firstLine = rawPrompt.split(/\r?\n/u).map((s) => s.trim()).find(Boolean) ?? "";
                        const clipped = firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
                        return `${seq}: ${clipped}`;
                    });
                    showOutputModal("/loops", lines.join("\n"));
                    return true;
                }
                const targetSeq = reqSeq ?? Number(items.at(-1)?.sequence ?? 1);
                const targetLoop = items.find((i) => Number(i.sequence) === targetSeq);
                if (!targetLoop) {
                    showStatus(`(no loop ${targetSeq}; /loops lists them)`);
                    return true;
                }
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
                showOutputModal(`/loop ${targetSeq}`, lines.join("\n"));
                return true;
            }
            if (name === "review") {
                const gates = actions.getPendingGates?.() ?? [];
                if (gates.length === 0) {
                    showStatus("review: none");
                } else {
                    const lines = gates.map((g) => {
                        if (g.method === "session/request_permission") {
                            const facts = g._meta?.plurnk?.proposal;
                            const label = facts ? `${facts.session} ${facts.op}` : "permission";
                            return `@${g.id}  permission  ${label}`;
                        }
                        return `@${g.id}  elicitation  ${g.message ?? "input required"}`;
                    });
                    showOutputModal("/review", lines.join("\n"));
                }
                return true;
            }
            if (name === "accept" || name === "approve" || name === "reject" || name === "cancel" || name === "edit" || name === "answer") {
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
                    showStatus(`Submitted edited proposal @${gate.id}.`);
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
                    showStatus(`Submitted answer for @${gate.id}.`);
                } else if (name === "cancel") {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "cancelled" } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "cancel" } });
                    showStatus(`Cancelled @${gate.id}.`);
                } else if (name === "reject") {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: rejectOptionId(gate) } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "decline" } });
                    showStatus(`Rejected @${gate.id}.`);
                } else {
                    await actions.resolveGate(gate.method === "session/request_permission"
                        ? { id: gate.id, method: "session/request_permission", response: { outcome: { outcome: "selected", optionId: allowOptionId(gate) } } }
                        : { id: gate.id, method: "elicitation/create", response: { action: "accept" } });
                    showStatus(`Accepted @${gate.id}.`);
                }
                return true;
            }
            return true;
        } catch (error) {
            const { message, recovery } = await describeFailure(error);
            showError(signal.aborted ? "Response not confirmed." : [message, recovery].filter(Boolean).join(" "));
            return false;
        }
    };

    const dismissAll = () => {
        if (outputDialog?.open) {
            outputDialog.close();
            return true;
        }
        const feedback = $(main, '[aria-label="Message feedback"]');
        if (feedback instanceof HTMLElement) {
            const curStatus = the(feedback, "message-status") ?? "";
            const curError = the(feedback, "command-error") ?? "";
            if ((curStatus && curStatus !== "Sending…") || curError) {
                the(feedback, { "message-status": "", "command-error": "" });
                return true;
            }
        }
        return false;
    };

    const showHelp = () => {
        navigateToSettings("help");
        return true;
    };

    return Object.assign(execute, { dismissAll, showHelp });
}
