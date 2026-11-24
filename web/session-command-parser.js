import { COMMANDS, FAMILY_COMMANDS } from "./session-command-suggestions.js";
import { isRecord } from "./session-translator.js";

/** @typedef {import("./session-agent.js").SessionGate} SessionGate */

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
 * {§web-session-input} Extract relative workspace `@<path>` tokens without `..` traversal.
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
 * {§web-session-commands} Expand `/learn` into a structured skill-authoring prompt.
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
 * {§web-session-input} Prepare composer prompt text (`: ` escape, `/learn`, `? ` forced review, `... ` follow-up, `@path` openPaths).
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
    if (!name || COMMANDS.has(name)) return true;
    return !availableCommands.some((entry) => entry?.type !== "skill" && entry?.name === name);
}

/**
 * Shell-style tokenizer preserving quoted rules ("0 9 * * 1-5") and JSON payloads ('{"text":"echo hi"}').
 * @param {string} raw
 * @returns {string[]}
 */
function tokenizeFamilyArgs(raw) {
    /** @type {string[]} */
    const tokens = [];
    let current = "";
    let inToken = false;
    /** @type {"'" | '"' | null} */
    let quote = null;

    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i] ?? "";
        if (quote !== null) {
            if (quote === '"' && ch === "\\" && i + 1 < raw.length) {
                const next = raw[i + 1] ?? "";
                if (next === '"' || next === "\\" || next === "$" || next === "`") {
                    current += next;
                    i += 1;
                    continue;
                }
            }
            if (ch === quote) {
                quote = null;
                continue;
            }
            current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            inToken = true;
            continue;
        }
        if (ch === "\\" && i + 1 < raw.length && /\s/u.test(raw[i + 1] ?? "")) {
            current += raw[i + 1] ?? "";
            inToken = true;
            i += 1;
            continue;
        }
        if (/\s/u.test(ch)) {
            if (inToken) {
                tokens.push(current);
                current = "";
                inToken = false;
            }
            continue;
        }
        current += ch;
        inToken = true;
    }

    if (quote !== null) {
        throw new Error(`Unclosed ${quote === "'" ? "single" : "double"} quote in command arguments.`);
    }
    if (inToken) {
        tokens.push(current);
    }
    return tokens;
}

/** @param {string} text */
export function parseCommand(text) {
    const match = /^\/(\S*)\s*([\s\S]*)$/u.exec(text.trim());
    if (!match) throw new Error("Expected a slash command.");
    const name = match[1] || "help";
    if (!COMMANDS.has(name)) throw new Error(`Unknown command /${name}. Use /help.`);
    const rest = match[2].trim();
    const args = rest ? (FAMILY_COMMANDS.has(name) ? tokenizeFamilyArgs(rest) : rest.split(/\s+/u)) : [];
    const zeroArg = new Set([
        "yolo", "stop", "logout", "update", "workspaces", "sessions", "loops",
        "parent", "enter", "older", "newer", "review",
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
        || (name === "share" && rest.length === 0)) {
        throw new Error(`Invalid arguments for /${name}. Use /help ${name}.`);
    }
    return { name, rest, args };
}

/** @param {unknown} rawResult @returns {string} */
export function formatExecResults(rawResult) {
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
export function formatFamilyResult(family, parsed, res) {
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
        if (parsed.actionName === "workspace.schedule.run") {
            const alias = typeof res.alias === "string" ? res.alias
                : typeof parsed.params.alias === "string" ? parsed.params.alias : "";
            const status = typeof res.status === "string" ? res.status : "open";
            const loopId = typeof res.loopId === "number" ? res.loopId : null;
            if (Array.isArray(res.results) && res.results.length > 0) {
                /** @type {string[]} */
                const lines = [];
                for (const rawStep of res.results) {
                    if (!isRecord(rawStep)) continue;
                    const idx = typeof rawStep.index === "number" ? rawStep.index + 1 : lines.length + 1;
                    const srv = typeof rawStep.server === "string" ? rawStep.server : "?";
                    const tool = typeof rawStep.tool === "string" ? rawStep.tool : "?";
                    const st = typeof rawStep.status === "number" ? rawStep.status : 200;
                    const uri = typeof rawStep.uri === "string" && rawStep.uri ? `  ${rawStep.uri}` : "";
                    lines.push(`[${idx}] ${srv}.${tool}  ${st}${uri}`);
                    if (typeof rawStep.preview === "string" && rawStep.preview.trim()) {
                        lines.push(`    ${rawStep.preview.trim().replace(/\r?\n/gu, "\n    ")}`);
                    }
                    if (isRecord(rawStep.problem) && typeof rawStep.problem.detail === "string" && rawStep.problem.detail) {
                        lines.push(`    ! ${rawStep.problem.detail}`);
                    }
                }
                const stepCount = res.results.length;
                return {
                    message: `${alias}  ${status} (${stepCount} ${stepCount === 1 ? "step" : "steps"})`,
                    literal: lines.join("\n"),
                };
            }
            return {
                message: `${alias}  ${status}${loopId !== null ? ` (loop ${loopId})` : ""}`,
            };
        }
        if (parsed.actionName === "workspace.schedule.status") {
            const alias = typeof res.alias === "string" ? res.alias
                : typeof parsed.params.alias === "string" ? parsed.params.alias : "";
            const status = typeof res.status === "string" ? res.status : "open";
            return { message: `${alias}  ${status}` };
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

/**
 * @param {readonly SessionGate[]} gates
 * @param {string | undefined} rawTarget
 * @param {string} cmdName
 * @returns {SessionGate}
 */
export function selectGate(gates, rawTarget, cmdName) {
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
