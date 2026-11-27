/** @returns {"⌘" | "Ctrl"} */
export const primaryModifierLabel = () =>
    /\b(?:Macintosh|Mac OS|iPhone|iPad|iPod)\b/iu.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** {§web-session-commands} A presentation vocabulary, not daemon policy or a terminal dispatcher. */
export const FAMILY_COMMANDS = new Set(["mcp", "skills", "schedule", "personas", "members", "env"]);
export const COMMANDS = new Set([
    "help",
    "models",
    "model",
    "effort",
    "yolo",
    "stop",
    ...FAMILY_COMMANDS,
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
    "review",
    "accept",
    "approve",
    "reject",
    "cancel",
    "edit",
    "answer",
    "logout",
]);
export const HELP_COMMANDS = new Set([...COMMANDS, "learn"]);

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
    "/persona",
    "/child",
    "/mode",
    "/parent",
    "/enter",
    "/older",
    "/newer",
    "/logout",
]);

const ZERO_ARG_COMMANDS = new Set([
    "/yolo",
    "/stop",
    "/logout",
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
    schedule: ["list", "show", "inspect", "run", "enable", "disable", "done", "reopen", "remove", "discover", "add", "replace"],
    personas: ["list", "enable", "disable", "remove", "discover", "add", "replace"],
    members: ["list", "enable", "disable", "remove", "discover", "add"],
    env: ["list", "discover", "set", "unset", "enable", "disable", "remove", "--scope"],
});

const FAMILY_LIST_FLAGS = Object.freeze(["--query", "--state", "--origin", "--offset", "--limit"]);
const FAMILY_LIST_STATES = Object.freeze(["active", "dormant", "disabled", "unavailable", "authorization-required"]);
const FAMILY_LIST_ORIGINS = Object.freeze(["host", "service", "workspace", "session"]);
const FAMILY_DISCOVER_FLAGS = Object.freeze({
    mcp: ["--query", "--cursor", "--limit"],
    skills: ["--source", "--query", "--cursor", "--limit"],
    personas: ["--source", "--query", "--cursor", "--limit"],
    members: ["--query", "--limit"],
    env: ["--query", "--source", "--cursor", "--limit"],
    schedule: ["--rule", "--cursor", "--limit"],
});
const MODELS_FLAGS = Object.freeze(["--provider", "--all", "--offset", "--limit"]);

const FAMILY_ALIAS_SUBS = new Set(["show", "inspect", "replace", "enable", "disable", "remove", "oauth", "run", "done", "reopen", "unset"]);

const SCHEDULE_ADD_FLAGS = Object.freeze([
    "--manual",
    "--once",
    "--rule",
    "--step",
    "--run",
    "--aside",
    "--target",
    "--prompt",
    "--persona",
    "--catchup",
    "--no-catchup",
]);

/**
 * @typedef {{
 *   readonly availableCommands?: readonly { readonly name: string, readonly type?: string }[],
 *   readonly promptSuggestions?: readonly string[],
 *   readonly models?: readonly string[],
 *   readonly modelChoices?: readonly import("./session-models.js").ModelChoice[],
 *   readonly efforts?: readonly string[],
 *   readonly effortsByModel?: Readonly<Record<string, readonly string[]>>,
 *   readonly personas?: readonly string[],
 *   readonly childModels?: readonly string[],
 *   readonly childModelChoices?: readonly import("./session-models.js").ModelChoice[],
 *   readonly modes?: readonly string[],
 *   readonly workspaces?: readonly string[],
 *   readonly sessions?: readonly string[],
 *   readonly loops?: readonly string[],
 *   readonly gateIds?: readonly string[],
 *   readonly familyAliases?: Partial<Record<"mcp" | "skills" | "schedule" | "personas" | "members" | "env", readonly string[]>>,
 *   readonly projectRoot?: string | null,
 * }} SuggestionSources
 */

/**
 * @param {readonly string[]} candidates
 * @param {string} partial
 * @param {boolean} terminal
 * @param {Readonly<Record<string, string>>} [details]
 * @returns {readonly string[]}
 */
function filterCandidates(candidates, partial, terminal, details) {
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
    const substringMatches = unique.filter((item) =>
        !item.toLowerCase().startsWith(needle)
        && (item.toLowerCase().includes(needle) || (details?.[item]?.toLowerCase().includes(needle) ?? false)));
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
 * @returns {{ candidates: readonly string[], advances: boolean, details?: Readonly<Record<string, string>>, menu?: boolean }}
 */
function resolveArgumentStage(cmd, completedArgs, sources) {
    if (cmd === "model") {
        if (completedArgs.length === 0) {
            const anyModelEfforts = (sources.efforts?.length ?? 0) > 0
                || Boolean(sources.effortsByModel && Object.values(sources.effortsByModel).some((list) => list.length > 0))
                || Boolean(sources.modelChoices?.some((choice) => choice.efforts.length > 0));
            if (sources.modelChoices && sources.modelChoices.length > 0) {
                /** @type {Record<string, string>} */
                const details = {};
                const candidates = [];
                for (const choice of sources.modelChoices) {
                    candidates.push(choice.value);
                    if (choice.secondary) details[choice.value] = choice.secondary;
                }
                for (const fallback of sources.models ?? []) {
                    if (!Object.hasOwn(details, fallback)) candidates.push(fallback);
                }
                return { candidates, advances: anyModelEfforts, details, menu: true };
            }
            return { candidates: sources.models ?? [], advances: anyModelEfforts, menu: true };
        }
        if (completedArgs.length === 1) {
            const selected = completedArgs[0] ?? "";
            const candidates = sources.effortsByModel && Object.hasOwn(sources.effortsByModel, selected)
                ? (sources.effortsByModel[selected] ?? [])
                : (sources.efforts ?? []);
            return { candidates, advances: false };
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
        if (completedArgs.length === 0) {
            if (sources.childModelChoices && sources.childModelChoices.length > 0) {
                /** @type {Record<string, string>} */
                const details = {};
                const candidates = [];
                for (const choice of sources.childModelChoices) {
                    candidates.push(choice.value);
                    if (choice.secondary) details[choice.value] = choice.secondary;
                }
                return { candidates: ["inherit", ...candidates], advances: false, details, menu: true };
            }
            return { candidates: ["inherit", ...(sources.childModels ?? sources.models ?? [])], advances: false, menu: true };
        }
        return { candidates: [], advances: false };
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
            ? { candidates: [...HELP_COMMANDS], advances: false }
            : { candidates: [], advances: false };
    }
    if (cmd === "learn") {
        if (completedArgs.length === 0) {
            return { candidates: ["--scope"], advances: true };
        }
        if (completedArgs.length === 1 && completedArgs[0] === "--scope") {
            return { candidates: sources.projectRoot === null ? ["plurnk"] : ["project", "plurnk"], advances: true };
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
    if (cmd === "models") {
        return { candidates: MODELS_FLAGS, advances: true };
    }
    if (cmd === "env") {
        const envVars = sources.familyAliases?.env ?? [];
        const hasScope = completedArgs[0] === "--scope";
        if (hasScope && completedArgs.length === 1) {
            return { candidates: ["service", "session", "workspace"], advances: true };
        }
        const effective = hasScope ? completedArgs.slice(2) : completedArgs;
        if (effective.length === 0) {
            return {
                candidates: hasScope ? FAMILY_SUBCOMMANDS.env.filter((item) => item !== "--scope") : FAMILY_SUBCOMMANDS.env,
                advances: true,
            };
        }
        const envSub = effective[0] ?? "";
        const prevTok = effective.at(-1) ?? "";
        if (prevTok === "--state") return { candidates: FAMILY_LIST_STATES, advances: true };
        if (prevTok === "--origin") return { candidates: FAMILY_LIST_ORIGINS, advances: true };
        if (envSub === "list" || /^--(query|state|origin|offset|limit)\b/u.test(envSub)) {
            return { candidates: FAMILY_LIST_FLAGS, advances: true };
        }
        if (envSub === "discover") {
            return { candidates: FAMILY_DISCOVER_FLAGS.env, advances: true };
        }
        if (effective.length === 1 && FAMILY_ALIAS_SUBS.has(envSub)) {
            return { candidates: envVars, advances: false };
        }
        return { candidates: [], advances: false };
    }
    if (cmd === "mcp" || cmd === "skills" || cmd === "schedule" || cmd === "personas" || cmd === "members") {
        if (completedArgs.length === 0) {
            return { candidates: FAMILY_SUBCOMMANDS[cmd], advances: true };
        }
        const sub = completedArgs[0] ?? "";
        const prevTok = completedArgs.at(-1) ?? "";
        if (prevTok === "--state") return { candidates: FAMILY_LIST_STATES, advances: true };
        if (prevTok === "--origin") return { candidates: FAMILY_LIST_ORIGINS, advances: true };
        if (sub === "list" || /^--(query|state|origin|offset|limit)\b/u.test(sub)) {
            return { candidates: FAMILY_LIST_FLAGS, advances: true };
        }
        if (sub === "discover") {
            return { candidates: FAMILY_DISCOVER_FLAGS[cmd], advances: true };
        }
        const validAliasSub = ((sub !== "show" && sub !== "inspect") || cmd === "schedule")
            && (sub !== "replace" || cmd !== "members");
        if (completedArgs.length === 1 && FAMILY_ALIAS_SUBS.has(sub) && validAliasSub) {
            const aliases = sources.familyAliases?.[cmd] ?? [];
            return { candidates: aliases, advances: sub === "oauth" || sub === "replace" };
        }
        if (cmd === "mcp" && completedArgs.length === 2 && sub === "oauth") {
            return { candidates: ["begin", "complete"], advances: false };
        }
        if (cmd === "schedule" && (sub === "add" || sub === "replace") && completedArgs.length >= 2) {
            return { candidates: SCHEDULE_ADD_FLAGS, advances: true };
        }
        return { candidates: [], advances: false };
    }
    return { candidates: [], advances: false };
}

/**
 * {§web-session-commands} {§web-session-input} Compute live-narrowing pill/menu candidates across command and argument stages.
 * @param {string} rawInput
 * @param {SuggestionSources} [sources]
 * @param {{ readonly allowPromptSuggestions?: boolean }} [options]
 * @returns {{ readonly kind: "command" | "arg" | "skill" | "prompt", readonly items: readonly string[], readonly advances: boolean, readonly details?: Readonly<Record<string, string>>, readonly menu?: boolean }}
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
            const { candidates, advances, details, menu } = resolveArgumentStage(cmd, completedArgs, sources);
            const items = filterCandidates(candidates, partial, !advances, details);
            if (items.length > 0) {
                return {
                    kind: "arg",
                    items,
                    advances,
                    ...(details ? { details } : {}),
                    ...(menu ? { menu: true } : {}),
                };
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
                : cmd === "model" && completedArgs.length === 0 && sources.effortsByModel && Object.hasOwn(sources.effortsByModel, text)
                    ? (sources.effortsByModel[text]?.length ?? 0) > 0
                    : advances;
            const prefixTokens = [`/${argMatch[1]}`, ...completedArgs, text].join(" ");
            return nextSubAdvances ? `${prefixTokens} ` : prefixTokens;
        }
    }
    return text;
}
