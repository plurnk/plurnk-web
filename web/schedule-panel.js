import { $, $$, on, the } from "on_the_money";
import { EFFORTS } from "@plurnk/plurnk-contracts";
import { directoryPath } from "../src/directory-addresses.js";
import describeFailure from "./failure.js";
import { isRecord } from "./session-translator.js";

const SCHEDULE_PREVIEW_DEBOUNCE_MS = 200;
const TURN_ONLY_PLURNK_TOOLS = new Set(["done", "fail", "wait", "question"]);

let comboboxIdCounter = 0;

/**
 * @typedef {{
 *   readonly value: string,
 *   readonly primary: string,
 *   readonly secondary: string,
 *   readonly kind?: "builtin" | "mcp" | "session" | "tool",
 * }} ComboboxChoice
 */

/**
 * @typedef {{
 *   readonly name: string,
 *   readonly type: "string" | "number" | "integer" | "boolean" | "enum" | "textarea" | "string-list",
 *   readonly required: boolean,
 *   readonly description: string,
 *   readonly enumValues?: readonly string[],
 * }} GuidedArgField
 */

/**
 * @typedef {{
 *   readonly name: string,
 *   readonly description: string,
 *   readonly inputSchema?: Record<string, unknown>,
 * }} ToolCatalogEntry
 */

/**
 * @typedef {{
 *   readonly alias: string,
 *   readonly description: string,
 *   readonly kind: "builtin" | "mcp",
 *   readonly tools: readonly ToolCatalogEntry[],
 *   readonly hydrated: boolean,
 * }} ServerCatalogEntry
 */

/**
 * @typedef {{
 *   readonly mode: "manual" | "once" | "relative" | "at" | "repeating" | "custom",
 *   readonly relativeAmount: number,
 *   readonly relativeUnit: "s" | "m" | "h" | "d" | "w",
 *   readonly atLocal: string,
 *   readonly repeatPreset: "daily" | "weekdays" | "weekly" | "monthly" | "every-hours" | "every-minutes",
 *   readonly repeatInterval: number,
 *   readonly repeatTime: string,
 *   readonly repeatDays: readonly number[],
 *   readonly repeatDayOfMonth: number,
 *   readonly customRule: string,
 * }} ScheduleTimingState
 */

/**
 * @typedef {{
 *   readonly server: string,
 *   readonly tool: string,
 *   readonly arguments?: Record<string, unknown>,
 *   readonly aside?: string,
 * }} ScheduledToolCall
 */

/**
 * @typedef {{
 *   readonly index: number,
 *   readonly server: string,
 *   readonly tool: string,
 *   readonly status: number,
 *   readonly uri?: string,
 *   readonly preview?: string,
 *   readonly problem?: Record<string, unknown>,
 * }} ScheduledStepReceipt
 */

/**
 * Curated fallback catalog for built-in schedule-safe `plurnk` tools when `mcp:///plurnk.json`
 * is not yet available (e.g. zero-session workspace or minimal unit fixture). Live `entry.read`
 * schemas from `mcp:///plurnk.json` enrich and supersede these entries whenever available.
 * @type {readonly ToolCatalogEntry[]}
 */
const BUILTIN_PLURNK_TOOLS = Object.freeze([
    {
        name: "sh",
        description: "Run shell code in the workspace.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                text: { type: "string", description: "Shell command or script to run." },
                cwd: { type: "string", description: "Optional working directory." },
            },
        },
    },
    {
        name: "js",
        description: "Run JavaScript code in the workspace.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                text: { type: "string", description: "JavaScript code to run." },
                cwd: { type: "string", description: "Optional working directory." },
            },
        },
    },
    {
        name: "python3",
        description: "Run Python 3 code in the workspace.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                text: { type: "string", description: "Python 3 code to run." },
                cwd: { type: "string", description: "Optional working directory." },
            },
        },
    },
    {
        name: "read",
        description: "Read files, workspace entries, streams, or matching lines.",
        inputSchema: {
            type: "object",
            required: ["path"],
            properties: {
                path: { type: "string", description: "Project path or URI (e.g. workspace:///notes.md)." },
                range: { type: "string", description: "Optional line range (e.g. 1,100)." },
                pattern: { type: "string", description: "Optional content matcher." },
            },
        },
    },
    {
        name: "find",
        description: "List matching paths or search pattern locations.",
        inputSchema: {
            type: "object",
            required: ["path"],
            properties: {
                path: { type: "string", description: "Glob or URI (e.g. src/**/*.ts)." },
                pattern: { type: "string", description: "Optional content matcher." },
                range: { type: "string", description: "Optional result page range." },
            },
        },
    },
    {
        name: "edit",
        description: "Create or edit a file or workspace entry.",
        inputSchema: {
            type: "object",
            required: ["path"],
            properties: {
                path: { type: "string", description: "Project path or URI (e.g. workspace:///notes.md)." },
                range: { type: "string", description: "Optional line range (e.g. 1,-1, 0, -1)." },
                pattern: { type: "string", description: "Optional pattern to replace." },
                text: { type: "string", description: "Replacement or file text." },
            },
        },
    },
    {
        name: "copy",
        description: "Copy files, entries, streams, or text regions.",
        inputSchema: {
            type: "object",
            required: ["from", "to"],
            properties: {
                from: { type: "string", description: "Source path or URI." },
                to: { type: "string", description: "Destination path or URI." },
            },
        },
    },
    {
        name: "move",
        description: "Move files, entries, streams, or text regions.",
        inputSchema: {
            type: "object",
            required: ["from", "to"],
            properties: {
                from: { type: "string", description: "Source path or URI." },
                to: { type: "string", description: "Destination path or URI." },
            },
        },
    },
    {
        name: "kill",
        description: "Delete an entry or stop a live stream or child session.",
        inputSchema: {
            type: "object",
            required: ["path"],
            properties: {
                path: { type: "string", description: "Target path, stream URI, or session URI." },
                range: { type: "string", description: "Optional range to delete." },
                pattern: { type: "string", description: "Optional pattern to delete." },
                remote: { type: "boolean", description: "Issue HTTP DELETE for http(s):// URLs." },
            },
        },
    },
    {
        name: "note",
        description: "Record a durable note in working memory.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                text: { type: "string", description: "Note text to record." },
            },
        },
    },
    {
        name: "send",
        description: "Send a message to a session://<name> or stream target.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                target: { type: "string", description: "Recipient URI (e.g. session://session1)." },
                text: { type: "string", description: "Message text to deliver." },
            },
        },
    },
    {
        name: "work",
        description: "Delegate a task to a child session with a fresh log.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                target: { type: "string", description: "Child session URI (e.g. session://worker)." },
                text: { type: "string", description: "Complete task prompt." },
                persona: { type: "string", description: "Optional workspace persona." },
                model: { type: "string", description: "Optional model selector." },
                effort: { type: "string", enum: [...EFFORTS], description: "Optional reasoning effort." },
            },
        },
    },
    {
        name: "fork",
        description: "Delegate a task to a forked child session.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                target: { type: "string", description: "Child session URI (e.g. session://branch)." },
                text: { type: "string", description: "Task prompt." },
                persona: { type: "string", description: "Optional workspace persona." },
                model: { type: "string", description: "Optional model selector." },
                effort: { type: "string", enum: [...EFFORTS], description: "Optional reasoning effort." },
            },
        },
    },
    {
        name: "bare",
        description: "Run a single stateless, toolless model call.",
        inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
                text: { type: "string", description: "Self-contained prompt." },
            },
        },
    },
    {
        name: "schedule",
        description: "Trigger, inspect, or update another workspace schedule.",
        inputSchema: {
            type: "object",
            properties: {
                alias: { type: "string", description: "Target schedule alias." },
                trigger: { type: "boolean", description: "Set true to trigger immediately." },
                status: { type: "string", enum: ["open", "done", "fail"], description: "Optional lifecycle status." },
            },
        },
    },
    {
        name: "env",
        description: "Inspect or update workspace environment variables.",
        inputSchema: {
            type: "object",
            properties: {
                alias: { type: "string", description: "Environment variable name." },
                value: { type: "string", description: "Variable value." },
            },
        },
    },
    {
        name: "mcp",
        description: "Inspect or toggle workspace MCP servers.",
        inputSchema: {
            type: "object",
            properties: {
                alias: { type: "string", description: "MCP server alias." },
                enabled: { type: "boolean", description: "Enable or disable." },
            },
        },
    },
    {
        name: "skills",
        description: "Inspect or toggle workspace skills.",
        inputSchema: {
            type: "object",
            properties: {
                alias: { type: "string", description: "Skill alias." },
                enabled: { type: "boolean", description: "Enable or disable." },
            },
        },
    },
    {
        name: "personas",
        description: "Inspect or toggle workspace personas.",
        inputSchema: {
            type: "object",
            properties: {
                alias: { type: "string", description: "Persona alias." },
                enabled: { type: "boolean", description: "Enable or disable." },
            },
        },
    },
    {
        name: "members",
        description: "Inspect or manage workspace file member rules.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path or glob pattern." },
            },
        },
    },
]);

const ICAL_DOW_TO_CRON = Object.freeze({
    SU: 0,
    MO: 1,
    TU: 2,
    WE: 3,
    TH: 4,
    FR: 5,
    SA: 6,
});

/** @param {number} value */
const pad2 = (value) => String(Math.max(0, Math.floor(value))).padStart(2, "0");

/**
 * {§web-workspace-settings} Synthesize a canonical schedule `rule` string from structured timing builder controls.
 * @param {ScheduleTimingState} state
 * @returns {string}
 */
export function synthesizeScheduleRule(state) {
    if (state.mode === "manual") return "manual";
    if (state.mode === "once") return "once";
    if (state.mode === "relative") {
        const amount = Number.isFinite(state.relativeAmount) && state.relativeAmount >= 1
            ? Math.floor(state.relativeAmount)
            : 0;
        if (amount < 1) throw new Error("Enter a positive relative delay amount.");
        return `+${amount}${state.relativeUnit}`;
    }
    if (state.mode === "at") {
        const raw = state.atLocal.trim();
        if (!raw) throw new Error("Choose a date and time.");
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(raw) ? `${raw}:00` : raw;
    }
    if (state.mode === "repeating") {
        const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(state.repeatTime.trim());
        const hour = timeMatch ? Math.min(23, Math.max(0, Number.parseInt(timeMatch[1] ?? "9", 10))) : 9;
        const minute = timeMatch ? Math.min(59, Math.max(0, Number.parseInt(timeMatch[2] ?? "0", 10))) : 0;
        const interval = Number.isFinite(state.repeatInterval) && state.repeatInterval >= 1
            ? Math.floor(state.repeatInterval)
            : 1;
        if (state.repeatPreset === "every-minutes") {
            return interval <= 1 ? "* * * * *" : `*/${Math.min(59, interval)} * * * *`;
        }
        if (state.repeatPreset === "every-hours") {
            return interval <= 1 ? "0 * * * *" : `0 */${Math.min(23, interval)} * * *`;
        }
        if (state.repeatPreset === "daily") {
            return `${minute} ${hour} * * *`;
        }
        if (state.repeatPreset === "weekdays") {
            return `${minute} ${hour} * * 1-5`;
        }
        if (state.repeatPreset === "weekly") {
            const days = [...new Set(state.repeatDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
                .toSorted((a, b) => a - b);
            if (days.length === 0) throw new Error("Select at least one day of the week.");
            return `${minute} ${hour} * * ${days.join(",")}`;
        }
        const dom = Number.isFinite(state.repeatDayOfMonth)
            ? Math.min(31, Math.max(1, Math.floor(state.repeatDayOfMonth)))
            : 1;
        return `${minute} ${hour} ${dom} * *`;
    }
    const custom = state.customRule.trim();
    if (!custom) throw new Error("Enter a schedule rule.");
    return custom;
}

/**
 * {§web-workspace-settings} Parse an authored or daemon-canonical rule back into timing builder controls.
 * @param {string | null | undefined} rawRule
 * @returns {ScheduleTimingState}
 */
export function parseRuleToTimingState(rawRule) {
    /** @type {ScheduleTimingState} */
    const base = {
        mode: "manual",
        relativeAmount: 15,
        relativeUnit: "m",
        atLocal: "",
        repeatPreset: "daily",
        repeatInterval: 1,
        repeatTime: "09:00",
        repeatDays: [1],
        repeatDayOfMonth: 1,
        customRule: "",
    };
    const text = typeof rawRule === "string" ? rawRule.trim() : "";
    if (!text || text === "manual") return { ...base, mode: "manual" };
    if (text === "once") return { ...base, mode: "once" };

    const relMatch = /^\+(\d+)([smhdw])$/iu.exec(text);
    if (relMatch) {
        return {
            ...base,
            mode: "relative",
            relativeAmount: Number.parseInt(relMatch[1] ?? "15", 10),
            relativeUnit: /** @type {"s" | "m" | "h" | "d" | "w"} */ ((relMatch[2] ?? "m").toLowerCase()),
        };
    }

    const isoLocalMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/u.exec(text);
    if (isoLocalMatch) {
        return { ...base, mode: "at", atLocal: `${isoLocalMatch[1]}T${isoLocalMatch[2]}` };
    }

    // Check 5-field cron presets
    const cronFields = text.split(/\s+/u);
    if (cronFields.length === 5 && !text.includes("\n")) {
        const [minF, hourF, domF, monF, dowF] = cronFields;
        if (domF === "*" && monF === "*" && dowF === "*") {
            if (minF === "*" && hourF === "*") {
                return { ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: 1 };
            }
            const stepMin = /^\*\/(\d+)$/u.exec(minF ?? "");
            if (stepMin && hourF === "*") {
                return { ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: Number.parseInt(stepMin[1] ?? "1", 10) };
            }
            if (minF === "0" && hourF === "*") {
                return { ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: 1 };
            }
            const stepHr = /^\*\/(\d+)$/u.exec(hourF ?? "");
            if (minF === "0" && stepHr) {
                return { ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: Number.parseInt(stepHr[1] ?? "1", 10) };
            }
            if (/^\d+$/u.test(minF ?? "") && /^\d+$/u.test(hourF ?? "")) {
                return {
                    ...base,
                    mode: "repeating",
                    repeatPreset: "daily",
                    repeatTime: `${pad2(Number(hourF))}:${pad2(Number(minF))}`,
                };
            }
        }
        if (/^\d+$/u.test(minF ?? "") && /^\d+$/u.test(hourF ?? "") && monF === "*") {
            const repeatTime = `${pad2(Number(hourF))}:${pad2(Number(minF))}`;
            if (domF === "*" && dowF === "1-5") {
                return { ...base, mode: "repeating", repeatPreset: "weekdays", repeatTime };
            }
            if (domF === "*" && /^[0-7](?:,[0-7])*$/u.test(dowF ?? "")) {
                const days = (dowF ?? "").split(",").map((d) => Number.parseInt(d, 10) % 7);
                return { ...base, mode: "repeating", repeatPreset: "weekly", repeatTime, repeatDays: days };
            }
            if (/^\d+$/u.test(domF ?? "") && dowF === "*") {
                return {
                    ...base,
                    mode: "repeating",
                    repeatPreset: "monthly",
                    repeatTime,
                    repeatDayOfMonth: Number.parseInt(domF ?? "1", 10),
                };
            }
        }
    }

    // Check daemon-canonical RFC 5545 forms
    const lines = text.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
    const hasExOrRdate = lines.some((l) => /^(?:EXDATE|RDATE)\b/u.test(l));
    const dtstartLine = lines.find((l) => l.startsWith("DTSTART"));
    const rruleLine = lines.find((l) => l.startsWith("RRULE:") || l.startsWith("FREQ="));
    if (!hasExOrRdate && rruleLine) {
        const body = rruleLine.startsWith("RRULE:") ? rruleLine.slice(6) : rruleLine;
        /** @type {Record<string, string>} */
        const parts = {};
        for (const pair of body.split(";")) {
            const eq = pair.indexOf("=");
            if (eq > 0) parts[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const keys = Object.keys(parts).filter((k) => k !== "BYSECOND");
        // One-shot timestamp normalized by daemon: DTSTART;TZID=...:YYYYMMDDTHHMMSS + RRULE:FREQ=SECONDLY;COUNT=1
        if (parts.FREQ === "SECONDLY" && parts.COUNT === "1" && dtstartLine && keys.length === 2) {
            const dtMatch = /:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}/u.exec(dtstartLine);
            if (dtMatch) {
                return {
                    ...base,
                    mode: "at",
                    atLocal: `${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}T${dtMatch[4]}:${dtMatch[5]}`,
                };
            }
        }
        const hasNoBounds = !parts.COUNT && !parts.UNTIL && !parts.BYMONTH && !parts.BYSETPOS;
        if (hasNoBounds) {
            if (parts.FREQ === "MINUTELY" && !parts.BYHOUR && !parts.BYDAY && !parts.BYMONTHDAY) {
                const interval = parts.INTERVAL ? Number.parseInt(parts.INTERVAL, 10) : 1;
                if (Number.isInteger(interval) && interval >= 1) {
                    return { ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: interval };
                }
            }
            if (parts.FREQ === "HOURLY" && !parts.BYHOUR && !parts.BYDAY && !parts.BYMONTHDAY && (!parts.BYMINUTE || parts.BYMINUTE === "0")) {
                const interval = parts.INTERVAL ? Number.parseInt(parts.INTERVAL, 10) : 1;
                if (Number.isInteger(interval) && interval >= 1) {
                    return { ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: interval };
                }
            }
            const singleHour = /^\d+$/u.test(parts.BYHOUR ?? "") ? Number.parseInt(parts.BYHOUR ?? "9", 10) : null;
            const singleMin = /^\d+$/u.test(parts.BYMINUTE ?? "") ? Number.parseInt(parts.BYMINUTE ?? "0", 10) : null;
            if (singleHour !== null && singleMin !== null && !parts.INTERVAL) {
                const repeatTime = `${pad2(singleHour)}:${pad2(singleMin)}`;
                if (parts.FREQ === "DAILY" && !parts.BYDAY && !parts.BYMONTHDAY) {
                    return { ...base, mode: "repeating", repeatPreset: "daily", repeatTime };
                }
                if (parts.FREQ === "WEEKLY" && parts.BYDAY && !parts.BYMONTHDAY) {
                    const tokens = parts.BYDAY.split(",");
                    /** @type {number[]} */
                    const mapped = [];
                    let valid = true;
                    for (const tok of tokens) {
                        if (Object.hasOwn(ICAL_DOW_TO_CRON, tok)) {
                            mapped.push(ICAL_DOW_TO_CRON[/** @type {keyof typeof ICAL_DOW_TO_CRON} */ (tok)]);
                        } else {
                            valid = false;
                            break;
                        }
                    }
                    if (valid && mapped.length > 0) {
                        const sorted = [...new Set(mapped)].toSorted((a, b) => a - b);
                        if (sorted.join(",") === "1,2,3,4,5") {
                            return { ...base, mode: "repeating", repeatPreset: "weekdays", repeatTime };
                        }
                        return { ...base, mode: "repeating", repeatPreset: "weekly", repeatTime, repeatDays: sorted };
                    }
                }
                if (parts.FREQ === "MONTHLY" && /^\d+$/u.test(parts.BYMONTHDAY ?? "") && !parts.BYDAY) {
                    return {
                        ...base,
                        mode: "repeating",
                        repeatPreset: "monthly",
                        repeatTime,
                        repeatDayOfMonth: Number.parseInt(parts.BYMONTHDAY ?? "1", 10),
                    };
                }
            }
        }
    }

    return { ...base, mode: "custom", customRule: text };
}

/**
 * Resolve a local `#/$defs/<name>` `$ref` when present on a property schema.
 * @param {Record<string, unknown>} rawProp
 * @param {Record<string, unknown> | null} defs
 * @returns {Record<string, unknown>}
 */
function resolveLocalSchemaRef(rawProp, defs) {
    const ref = typeof rawProp.$ref === "string" ? rawProp.$ref : "";
    if (!defs || !ref.startsWith("#/$defs/")) return rawProp;
    const key = ref.slice("#/$defs/".length);
    const target = defs[key];
    return isRecord(target) ? { ...target, ...rawProp } : rawProp;
}

/**
 * Extract compact guided scalar and string-list fields from a JSON Schema object.
 * Resolves local `#/$defs/` `$ref`s and scalar `oneOf`/`anyOf` branches.
 * @param {Record<string, unknown> | undefined} schema
 * @returns {readonly GuidedArgField[]}
 */
export function extractGuidedFields(schema) {
    if (!isRecord(schema) || !isRecord(schema.properties)) return [];
    const defs = isRecord(schema.$defs) ? schema.$defs : null;
    const requiredSet = new Set(
        Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === "string") : [],
    );
    /** @param {Record<string, unknown>} prop @returns {string | undefined} */
    const primaryTypeOf = (prop) => {
        const rawType = prop.type;
        if (typeof rawType === "string") return rawType;
        if (Array.isArray(rawType)) {
            return rawType.find((t) => typeof t === "string" && t !== "null");
        }
        const union = Array.isArray(prop.oneOf) ? prop.oneOf : Array.isArray(prop.anyOf) ? prop.anyOf : null;
        if (union) {
            for (const preferred of ["string", "integer", "number", "boolean", "array"]) {
                for (const rawBranch of union) {
                    if (!isRecord(rawBranch)) continue;
                    const branch = resolveLocalSchemaRef(rawBranch, defs);
                    if (branch.type === preferred || (Array.isArray(branch.type) && branch.type.includes(preferred))) {
                        return preferred;
                    }
                }
            }
        }
        return undefined;
    };
    /** @type {GuidedArgField[]} */
    const fields = [];
    for (const [name, rawEntry] of Object.entries(schema.properties)) {
        if (!isRecord(rawEntry)) continue;
        const rawProp = resolveLocalSchemaRef(rawEntry, defs);
        const description = typeof rawProp.description === "string" ? rawProp.description : "";
        const required = requiredSet.has(name);
        if (Array.isArray(rawProp.enum) && rawProp.enum.every((v) => typeof v === "string")) {
            fields.push({ name, type: "enum", required, description, enumValues: rawProp.enum });
            continue;
        }
        const primaryType = primaryTypeOf(rawProp);
        if (primaryType === "boolean") {
            fields.push({ name, type: "boolean", required, description });
        } else if (primaryType === "integer" || primaryType === "number") {
            fields.push({ name, type: primaryType, required, description });
        } else if (primaryType === "string") {
            const multiline = name === "text" || name === "content" || name === "prompt" || name === "body" || name === "command";
            fields.push({ name, type: multiline ? "textarea" : "string", required, description });
        } else if (primaryType === "array") {
            const itemSchema = isRecord(rawProp.items) ? resolveLocalSchemaRef(rawProp.items, defs) : null;
            if (itemSchema && (itemSchema.type === "string" || (Array.isArray(itemSchema.enum) && itemSchema.enum.every((v) => typeof v === "string")))) {
                fields.push({ name, type: "string-list", required, description });
            }
        }
    }
    return fields;
}

/**
 * Reusable ARIA listbox combobox over a dynamic choice supplier.
 * @param {HTMLElement} container
 * @param {{
 *   getChoices: (query: string) => readonly ComboboxChoice[],
 *   emptyHint: string,
 *   onSelect?: (value: string, choice?: ComboboxChoice) => void,
 *   onInput?: (value: string) => void,
 * }} options
 */
function attachListCombobox(container, { getChoices, emptyHint, onSelect, onInput }) {
    const rawInput = $(container, 'input[role="combobox"]');
    const rawList = $(container, '[role="listbox"][data-combobox-list]');
    if (!(rawInput instanceof HTMLInputElement) || !(rawList instanceof HTMLUListElement)) {
        throw new Error("Schedule combobox markup is incomplete.");
    }
    const input = rawInput;
    const list = rawList;
    if (!list.id) {
        comboboxIdCounter += 1;
        list.id = `schedule-combobox-list-${comboboxIdCounter}`;
    }
    input.setAttribute("aria-controls", list.id);

    let open = false;
    let suppressOpen = false;
    let committedValue = input.value.trim();
    let activeIndex = -1;
    /** @type {ComboboxChoice[]} */
    let currentItems = [];

    /** @param {number} index */
    function setActiveIndex(index) {
        if (currentItems.length === 0) {
            activeIndex = -1;
            input.removeAttribute("aria-activedescendant");
            return;
        }
        activeIndex = ((index % currentItems.length) + currentItems.length) % currentItems.length;
        const rows = $$(list, '[role="option"]');
        let activeId = "";
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            if (!(row instanceof HTMLElement)) continue;
            const selected = i === activeIndex;
            row.setAttribute("aria-selected", selected ? "true" : "false");
            if (selected) {
                activeId = row.id;
                row.scrollIntoView({ block: "nearest" });
            }
        }
        if (activeId) input.setAttribute("aria-activedescendant", activeId);
        else input.removeAttribute("aria-activedescendant");
    }

    /** @param {string} query */
    function render(query) {
        const needle = query.trim().toLowerCase();
        const all = getChoices(query);
        const matched = needle
            ? [
                ...all.filter((c) => c.value.toLowerCase().startsWith(needle) || c.primary.toLowerCase().startsWith(needle)),
                ...all.filter((c) =>
                    !c.value.toLowerCase().startsWith(needle)
                    && !c.primary.toLowerCase().startsWith(needle)
                    && (c.value.toLowerCase().includes(needle)
                        || c.primary.toLowerCase().includes(needle)
                        || c.secondary.toLowerCase().includes(needle))),
            ]
            : [...all];
        currentItems = matched;
        $.cloneEach(list, "#model-combobox-option", currentItems, (li, choice, index) => {
            li.id = `${list.id}-opt-${index}`;
            li.setAttribute("data-combobox-option", choice.value);
            li.setAttribute("data-combobox-kind", choice.kind ?? "tool");
            li.setAttribute("aria-selected", "false");
            const primaryEl = $(li, "[data-combobox-primary]");
            const secondaryEl = $(li, "[data-combobox-secondary]");
            if (primaryEl) primaryEl.textContent = choice.primary;
            if (secondaryEl) {
                secondaryEl.textContent = choice.secondary;
                if (secondaryEl instanceof HTMLElement) secondaryEl.hidden = choice.secondary.length === 0;
            }
        });
        if (currentItems.length === 0) {
            const hint = $.clone(list, "#model-combobox-hint");
            if (hint) hint.textContent = emptyHint;
        }
        const curIdx = committedValue ? currentItems.findIndex((item) => item.value === committedValue) : -1;
        setActiveIndex(curIdx >= 0 ? curIdx : (currentItems.length > 0 ? 0 : -1));
    }

    function openList() {
        if (input.disabled) return;
        open = true;
        list.hidden = false;
        container.dataset.comboboxOpen = "true";
        input.setAttribute("aria-expanded", "true");
    }

    function closeList() {
        open = false;
        list.hidden = true;
        container.dataset.comboboxOpen = "false";
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
    }

    /** @param {ComboboxChoice} choice */
    function selectChoice(choice) {
        committedValue = choice.value;
        input.value = choice.value;
        closeList();
        onSelect?.(choice.value, choice);
    }

    const offFocus = on(container, "focusin", 'input[role="combobox"]', () => {
        if (input.disabled || suppressOpen) return;
        openList();
        const trimmed = input.value.trim();
        render(trimmed === committedValue ? "" : trimmed);
    });

    const offClick = on(container, "click", 'input[role="combobox"]', () => {
        if (input.disabled || open || suppressOpen) return;
        openList();
        const trimmed = input.value.trim();
        render(trimmed === committedValue ? "" : trimmed);
    });

    const offInput = on(container, "input", 'input[role="combobox"]', () => {
        if (!open) openList();
        render(input.value);
        onInput?.(input.value.trim());
    });

    const offKeydown = on(container, "keydown", 'input[role="combobox"]', (rawEvent) => {
        if (!(rawEvent instanceof KeyboardEvent) || rawEvent.isComposing) return;
        if (rawEvent.key === "ArrowDown") {
            rawEvent.preventDefault();
            if (!open) {
                openList();
                const trimmed = input.value.trim();
                render(trimmed === committedValue ? "" : trimmed);
            } else {
                setActiveIndex(activeIndex + 1);
            }
            return;
        }
        if (rawEvent.key === "ArrowUp") {
            rawEvent.preventDefault();
            if (!open) {
                openList();
                const trimmed = input.value.trim();
                render(trimmed === committedValue ? "" : trimmed);
            } else {
                setActiveIndex(activeIndex - 1);
            }
            return;
        }
        if (rawEvent.key === "Escape" && open) {
            rawEvent.preventDefault();
            rawEvent.stopPropagation();
            closeList();
            return;
        }
        if (rawEvent.key === "Enter" && open) {
            const chosen = activeIndex >= 0 ? currentItems[activeIndex] : undefined;
            if (chosen) {
                rawEvent.preventDefault();
                selectChoice(chosen);
            } else {
                closeList();
            }
            return;
        }
        if (rawEvent.key === "Tab" && open) {
            const trimmed = input.value.trim();
            if (trimmed !== committedValue && currentItems.length > 0) {
                const chosen = activeIndex >= 0 ? currentItems[activeIndex] : currentItems[0];
                if (chosen) {
                    selectChoice(chosen);
                    return;
                }
            }
            closeList();
        }
    });

    const offMousedown = on(list, "mousedown", '[role="option"]', (event) => {
        event.preventDefault();
    });

    const offOptionClick = on(list, "click", '[role="option"]', (event, option) => {
        event.preventDefault();
        event.stopPropagation();
        const value = option.getAttribute("data-combobox-option") ?? "";
        const chosen = currentItems.find((item) => item.value === value);
        if (chosen) {
            suppressOpen = true;
            try {
                selectChoice(chosen);
                if (document.activeElement !== input) input.focus();
            } finally {
                queueMicrotask(() => {
                    suppressOpen = false;
                });
            }
        }
    });

    const offFocusout = on(container, "focusout", "*", (rawEvent) => {
        const next = rawEvent instanceof FocusEvent ? rawEvent.relatedTarget : null;
        if (next instanceof Node && container.contains(next)) return;
        closeList();
        const trimmed = input.value.trim();
        if (trimmed !== committedValue) {
            committedValue = trimmed;
            onSelect?.(trimmed, undefined);
        }
    });

    const offOutside = on.target(document, "pointerdown", (event) => {
        if (!open) return;
        if (event.target instanceof Node && container.contains(event.target)) return;
        closeList();
    });

    return {
        input,
        setValue(/** @type {string} */ value) {
            committedValue = value.trim();
            input.value = committedValue;
        },
        getValue: () => input.value.trim(),
        refresh() {
            if (open) {
                const trimmed = input.value.trim();
                render(trimmed === committedValue ? "" : trimmed);
            }
        },
        close: closeList,
        dispose() {
            offFocus();
            offClick();
            offInput();
            offKeydown();
            offMousedown();
            offOptionClick();
            offFocusout();
            offOutside();
        },
    };
}

/**
 * Parse a JSON tool catalog read from `mcp:///<server>.json`.
 * @param {string} server
 * @param {unknown} readResult
 * @returns {readonly ToolCatalogEntry[] | null}
 */
function parseToolCatalogEntry(server, readResult) {
    if (!isRecord(readResult) || readResult.status !== 200 || !isRecord(readResult.entry)) return null;
    const channels = isRecord(readResult.entry.channels) ? readResult.entry.channels : null;
    const body = channels && isRecord(channels.body) ? channels.body : null;
    const content = body && typeof body.content === "string" ? body.content : "";
    if (!content) return null;
    try {
        const parsed = /** @type {unknown} */ (JSON.parse(content));
        if (!isRecord(parsed) || !Array.isArray(parsed.tools)) return null;
        /** @type {ToolCatalogEntry[]} */
        const out = [];
        for (const item of parsed.tools) {
            if (!isRecord(item) || typeof item.name !== "string" || !item.name) continue;
            if (server === "plurnk" && TURN_ONLY_PLURNK_TOOLS.has(item.name)) continue;
            const rawDesc = typeof item.description === "string" ? item.description : "";
            const firstLine = rawDesc.split(/\r?\n/u).map((s) => s.trim()).find(Boolean) ?? "";
            out.push({
                name: item.name,
                description: firstLine,
                ...(isRecord(item.inputSchema) ? { inputSchema: item.inputSchema } : {}),
            });
        }
        return out;
    } catch {
        return null;
    }
}

/**
 * @param {unknown} raw
 * @returns {readonly ScheduledStepReceipt[]}
 */
function parseStepReceipts(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {ScheduledStepReceipt[]} */
    const out = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        if (typeof item.server !== "string" || typeof item.tool !== "string" || typeof item.status !== "number") continue;
        out.push({
            index: typeof item.index === "number" ? item.index : out.length,
            server: item.server,
            tool: item.tool,
            status: item.status,
            ...(typeof item.uri === "string" ? { uri: item.uri } : {}),
            ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
            ...(isRecord(item.problem) ? { problem: item.problem } : {}),
        });
    }
    return out;
}

/**
 * Format a compact human summary of a schedule's action (`Prompt` target or `Run` step chain).
 * @param {Record<string, unknown>} def
 * @returns {string}
 */
function formatScheduleAction(def) {
    if (Array.isArray(def.run)) {
        const calls = def.run.filter(isRecord).map((step) => {
            const srv = typeof step.server === "string" ? step.server : "?";
            const tool = typeof step.tool === "string" ? step.tool : "?";
            return `${srv}.${tool}`;
        });
        if (calls.length === 0) return "0 steps";
        const preview = calls.length <= 3 ? calls.join(" → ") : `${calls.slice(0, 3).join(" → ")} +${calls.length - 3}`;
        return `${calls.length} ${calls.length === 1 ? "step" : "steps"}: ${preview}`;
    }
    const target = typeof def.target === "string" ? def.target : "";
    const persona = typeof def.persona === "string" && def.persona ? ` (${def.persona})` : "";
    const prompt = typeof def.prompt === "string" ? def.prompt.trim().replace(/\s+/gu, " ") : "";
    const clipped = prompt.length > 72 ? `${prompt.slice(0, 71)}…` : prompt;
    return [target ? `${target}${persona}` : "", clipped].filter(Boolean).join(" · ");
}

/**
 * {§web-workspace-settings} Mount the interactive Schedule & Macro Control Panel inside `[data-settings-panel="schedule"]`.
 * @param {HTMLElement} panel
 * @param {{
 *   getContext: () => { readonly workspaceId: number, readonly workspaceName: string, readonly sessionName: string | null, readonly signal: AbortSignal },
 *   invoke: (kind: string, params?: Record<string, unknown>, opts?: { requireSession?: boolean }) => Promise<unknown>,
 *   invokeForSession: (kind: string, params: Record<string, unknown>, sessionName: string, signal?: AbortSignal) => Promise<unknown>,
 *   runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   setFeedback: (busy: boolean, message?: string, recovery?: string) => void,
 * }} host
 */
export function mountSchedulePanel(panel, host) {
    const rawForm = $(panel, "form[data-schedule-save-form]");
    const rawDisclosure = $(panel, 'details[data-family-disclosure="schedule"]');
    const rawTbody = $(panel, "[data-family-rows]");
    const rawStepsList = $(panel, "[data-schedule-steps-list]");
    const rawReceiptBox = $(panel, "[data-schedule-receipt]");
    if (
        !(rawForm instanceof HTMLFormElement)
        || !(rawDisclosure instanceof HTMLDetailsElement)
        || !(rawTbody instanceof HTMLTableSectionElement)
        || !(rawStepsList instanceof HTMLOListElement)
        || !(rawReceiptBox instanceof HTMLElement)
    ) {
        throw new Error("Schedule panel markup is incomplete.");
    }
    const form = rawForm;
    const disclosure = rawDisclosure;
    const tbody = rawTbody;
    const stepsList = rawStepsList;
    const receiptBox = rawReceiptBox;

    /** @type {Map<string, Record<string, unknown>>} */
    const scheduleByAlias = new Map();
    /** @type {Map<string, ServerCatalogEntry>} */
    const serverCatalog = new Map([
        ["plurnk", {
            alias: "plurnk",
            description: "Built-in Plurnk VM operations, runtimes, and workspace families",
            kind: "builtin",
            tools: BUILTIN_PLURNK_TOOLS,
            hydrated: false,
        }],
    ]);
    /** @type {Set<string>} */
    const hydratingServers = new Set();
    /** @type {string[]} */
    let workspaceSessions = [];
    /** @type {{ alias: string, description: string }[]} */
    let workspacePersonas = [];
    /** @type {string | null} */
    let readSessionName = null;
    let activated = false;
    /** @type {string | null} */
    let editingAlias = null;
    /** @type {string | null} */
    let lastReceiptAlias = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let previewTimer = null;
    /** @type {AbortController | null} */
    let previewAbort = null;

    /**
     * @typedef {{
     *   readonly li: HTMLLIElement,
     *   readonly serverCombo: ReturnType<typeof attachListCombobox>,
     *   readonly toolCombo: ReturnType<typeof attachListCombobox>,
     *   readonly guidedHost: HTMLElement,
     *   readonly argsArea: HTMLTextAreaElement,
     *   readonly asideInput: HTMLInputElement,
     *   readonly descEl: HTMLElement,
     * }} StepRowController
     */
    /** @type {StepRowController[]} */
    let stepControllers = [];

    const targetBox = $(form, '[data-schedule-combobox="target"]');
    const targetCombobox = targetBox instanceof HTMLElement
        ? attachListCombobox(targetBox, {
            emptyHint: "Type a new or existing session name.",
            getChoices: () => {
                const ctx = host.getContext();
                const names = new Set(workspaceSessions);
                if (ctx.sessionName) names.add(ctx.sessionName);
                return [...names].map((name) => ({
                    value: name,
                    primary: name,
                    secondary: name === ctx.sessionName ? "Active session" : "Workspace session",
                    kind: "session",
                }));
            },
        })
        : null;

    /** @returns {ScheduleTimingState} */
    function readTimingState() {
        const modeEl = $(form, 'select[name="scheduleMode"]');
        const relAmtEl = $(form, 'input[name="relativeAmount"]');
        const relUnitEl = $(form, 'select[name="relativeUnit"]');
        const atEl = $(form, 'input[name="atLocal"]');
        const repeatPresetEl = $(form, 'select[name="repeatPreset"]');
        const repeatIntervalEl = $(form, 'input[name="repeatInterval"]');
        const repeatTimeEl = $(form, 'input[name="repeatTime"]');
        const repeatDomEl = $(form, 'input[name="repeatDayOfMonth"]');
        const customEl = $(form, 'input[name="rule"]');
        const checkedDays = $$(form, 'input[name="repeatDay"]:checked')
            .filter((el) => el instanceof HTMLInputElement)
            .map((el) => Number.parseInt(/** @type {HTMLInputElement} */ (el).value, 10))
            .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
        const rawMode = modeEl instanceof HTMLSelectElement ? modeEl.value : "manual";
        const mode = rawMode === "once" || rawMode === "relative" || rawMode === "at" || rawMode === "repeating" || rawMode === "custom"
            ? rawMode
            : "manual";
        const rawUnit = relUnitEl instanceof HTMLSelectElement ? relUnitEl.value : "m";
        const relativeUnit = rawUnit === "s" || rawUnit === "m" || rawUnit === "h" || rawUnit === "d" || rawUnit === "w"
            ? rawUnit
            : "m";
        const rawPreset = repeatPresetEl instanceof HTMLSelectElement ? repeatPresetEl.value : "daily";
        const repeatPreset = rawPreset === "weekdays" || rawPreset === "weekly" || rawPreset === "monthly" || rawPreset === "every-hours" || rawPreset === "every-minutes"
            ? rawPreset
            : "daily";
        return {
            mode,
            relativeAmount: relAmtEl instanceof HTMLInputElement ? Number.parseInt(relAmtEl.value, 10) : 15,
            relativeUnit,
            atLocal: atEl instanceof HTMLInputElement ? atEl.value : "",
            repeatPreset,
            repeatInterval: repeatIntervalEl instanceof HTMLInputElement ? Number.parseInt(repeatIntervalEl.value, 10) : 1,
            repeatTime: repeatTimeEl instanceof HTMLInputElement ? repeatTimeEl.value : "09:00",
            repeatDays: checkedDays,
            repeatDayOfMonth: repeatDomEl instanceof HTMLInputElement ? Number.parseInt(repeatDomEl.value, 10) : 1,
            customRule: customEl instanceof HTMLInputElement ? customEl.value : "",
        };
    }

    /** @param {ScheduleTimingState} state */
    function writeTimingState(state) {
        const setVal = (/** @type {string} */ selector, /** @type {string} */ value) => {
            const el = $(form, selector);
            if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = value;
        };
        setVal('select[name="scheduleMode"]', state.mode);
        setVal('input[name="relativeAmount"]', String(state.relativeAmount));
        setVal('select[name="relativeUnit"]', state.relativeUnit);
        setVal('input[name="atLocal"]', state.atLocal);
        setVal('select[name="repeatPreset"]', state.repeatPreset);
        setVal('input[name="repeatInterval"]', String(state.repeatInterval));
        setVal('input[name="repeatTime"]', state.repeatTime);
        setVal('input[name="repeatDayOfMonth"]', String(state.repeatDayOfMonth));
        setVal('input[name="rule"]', state.customRule);
        const daySet = new Set(state.repeatDays);
        for (const box of $$(form, 'input[name="repeatDay"]')) {
            if (box instanceof HTMLInputElement) {
                box.checked = daySet.has(Number.parseInt(box.value, 10));
            }
        }
        syncFormAttributes();
    }

    function syncFormAttributes() {
        const kindEl = $(form, 'select[name="kind"]');
        const modeEl = $(form, 'select[name="scheduleMode"]');
        const repeatEl = $(form, 'select[name="repeatPreset"]');
        const kind = kindEl instanceof HTMLSelectElement && kindEl.value === "run" ? "run" : "prompt";
        const mode = modeEl instanceof HTMLSelectElement ? modeEl.value : "manual";
        const repeat = repeatEl instanceof HTMLSelectElement ? repeatEl.value : "daily";
        the(form, {
            "schedule-kind": kind,
            "schedule-mode": mode,
            "schedule-repeat": repeat,
            "schedule-editing": editingAlias !== null ? "true" : "false",
            "schedule-editing-alias": editingAlias ?? "",
        });
    }

    /**
     * @param {{ immediate?: boolean }} [opts]
     */
    function schedulePreview(opts = {}) {
        if (previewTimer !== null) {
            clearTimeout(previewTimer);
            previewTimer = null;
        }
        previewAbort?.abort();
        previewAbort = null;

        const state = readTimingState();
        if (state.mode === "manual") {
            the(form, "schedule-preview", "Manual trigger — runs only when triggered on demand and stays open.");
            return;
        }
        if (state.mode === "once") {
            the(form, "schedule-preview", "Single-shot obligation — runs once on demand, then transitions open → done.");
            return;
        }

        let rule;
        try {
            rule = synthesizeScheduleRule(state);
        } catch (err) {
            the(form, "schedule-preview", err instanceof Error ? err.message : String(err));
            return;
        }
        const runPreview = async () => {
            const ctx = host.getContext();
            if (ctx.workspaceId <= 0) return;
            const req = previewAbort = new AbortController();
            the(form, "schedule-preview", `Previewing ${rule}…`);
            try {
                const res = await host.invoke("workspace.schedule.discover", { rule });
                if (req.signal.aborted || ctx.signal.aborted) return;
                const candidates = isRecord(res) && Array.isArray(res.candidates) ? res.candidates : [];
                const first = candidates.find(isRecord);
                const summary = typeof first?.summary === "string" && first.summary
                    ? first.summary
                    : `Rule: ${rule}`;
                the(form, "schedule-preview", `${rule} — ${summary}`);
            } catch (error) {
                if (req.signal.aborted || ctx.signal.aborted) return;
                const { message } = await describeFailure(error);
                the(form, "schedule-preview", message);
            } finally {
                if (previewAbort === req) previewAbort = null;
            }
        };

        if (opts.immediate) {
            void runPreview();
        } else {
            previewTimer = setTimeout(() => {
                previewTimer = null;
                void runPreview();
            }, SCHEDULE_PREVIEW_DEBOUNCE_MS);
        }
    }

    function updatePersonaChoices() {
        const personaSelect = $(form, 'select[name="persona"]');
        if (!(personaSelect instanceof HTMLSelectElement)) return;
        const previous = personaSelect.value;
        const choices = [
            { value: "", label: "None (default)" },
            ...workspacePersonas.map((p) => ({
                value: p.alias,
                label: p.description ? `${p.alias} — ${p.description}` : p.alias,
            })),
        ];
        $.cloneEach(personaSelect, "#setting-option", choices, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        personaSelect.value = choices.some((c) => c.value === previous) ? previous : "";
    }

    /** @param {string} server */
    async function hydrateServerCatalog(server) {
        if (!activated) return;
        const entry = serverCatalog.get(server);
        if (!entry || entry.hydrated || hydratingServers.has(server)) return;
        const ctx = host.getContext();
        const sessionForRead = ctx.sessionName ?? readSessionName;
        if (!sessionForRead || ctx.workspaceId <= 0) return;
        hydratingServers.add(server);
        try {
            const res = await host.invokeForSession("entry.read", { target: `mcp:///${server}.json` }, sessionForRead, ctx.signal);
            if (ctx.signal.aborted) return;
            const parsedTools = parseToolCatalogEntry(server, res);
            if (parsedTools && parsedTools.length > 0) {
                serverCatalog.set(server, {
                    ...entry,
                    tools: parsedTools,
                    hydrated: true,
                });
                for (const ctrl of stepControllers) {
                    if (ctrl.serverCombo.getValue() === server) {
                        ctrl.toolCombo.refresh();
                        syncStepToolSchema(ctrl);
                    }
                }
            }
        } catch {
            /* graceful fallback to workspace.mcp.list / curated schemas */
        } finally {
            hydratingServers.delete(server);
        }
    }

    /**
     * @param {string} server
     * @param {string} toolName
     * @returns {ToolCatalogEntry | undefined}
     */
    function findToolEntry(server, toolName) {
        return serverCatalog.get(server)?.tools.find((t) => t.name === toolName);
    }

    /**
     * Safely parse the step's raw JSON arguments textarea into a plain record.
     * @param {HTMLTextAreaElement} area
     * @returns {Record<string, unknown> | null}
     */
    function readArgsJson(area) {
        const trimmed = area.value.trim();
        if (!trimmed) return {};
        try {
            const parsed = /** @type {unknown} */ (JSON.parse(trimmed));
            return isRecord(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    /**
     * Render guided schema fields for the step's currently selected server+tool and bind them to `argsArea`.
     * @param {StepRowController} ctrl
     */
    function syncStepToolSchema(ctrl) {
        const server = ctrl.serverCombo.getValue();
        const toolName = ctrl.toolCombo.getValue();
        const entry = findToolEntry(server, toolName);
        ctrl.descEl.textContent = entry?.description ?? "";
        ctrl.descEl.hidden = !entry?.description;
        const fields = extractGuidedFields(entry?.inputSchema);
        const currentArgs = readArgsJson(ctrl.argsArea) ?? {};
        ctrl.guidedHost.replaceChildren();
        ctrl.guidedHost.hidden = fields.length === 0;
        for (const field of fields) {
            const isSelect = field.type === "boolean" || field.type === "enum";
            const wrapper = isSelect
                ? $.clone(ctrl.guidedHost, "#schedule-step-arg-select")
                : $.clone(ctrl.guidedHost, "#schedule-step-arg-field");
            if (!(wrapper instanceof HTMLElement)) continue;
            wrapper.dataset.argName = field.name;
            wrapper.dataset.argType = field.type;
            the(wrapper, {
                "arg-label": field.name,
                "arg-required": field.required ? "required" : "",
            });
            const existing = currentArgs[field.name];
            if (isSelect) {
                const sel = $(wrapper, "select");
                if (sel instanceof HTMLSelectElement) {
                    sel.setAttribute("aria-label", `${field.name} argument`);
                    const options = field.type === "boolean"
                        ? [
                            { value: "", label: field.required ? "Choose…" : "(unset)" },
                            { value: "true", label: "true" },
                            { value: "false", label: "false" },
                        ]
                        : [
                            { value: "", label: field.required ? "Choose…" : "(unset)" },
                            ...(field.enumValues ?? []).map((v) => ({ value: v, label: v })),
                        ];
                    $.cloneEach(sel, "#setting-option", options, (optEl, choice) => {
                        the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
                    });
                    if (typeof existing === "boolean") sel.value = String(existing);
                    else if (typeof existing === "string" && options.some((o) => o.value === existing)) sel.value = existing;
                    else sel.value = "";
                }
            } else {
                const input = $(wrapper, "input");
                const area = $(wrapper, "textarea");
                if (field.type === "textarea" || field.type === "string-list") {
                    if (input instanceof HTMLElement) input.remove();
                    if (area instanceof HTMLTextAreaElement) {
                        area.setAttribute("aria-label", `${field.name} argument`);
                        area.placeholder = field.type === "string-list"
                            ? `${field.description || field.name} (one per line)`
                            : (field.description || field.name);
                        area.value = field.type === "string-list"
                            ? (Array.isArray(existing) ? existing.map(String).join("\n") : typeof existing === "string" ? existing : "")
                            : (typeof existing === "string" ? existing : "");
                    }
                } else {
                    if (area instanceof HTMLElement) area.remove();
                    if (input instanceof HTMLInputElement) {
                        input.type = field.type === "number" || field.type === "integer" ? "number" : "text";
                        if (field.type === "number") input.step = "any";
                        input.setAttribute("aria-label", `${field.name} argument`);
                        input.placeholder = field.description || field.name;
                        input.value = typeof existing === "string" || typeof existing === "number" ? String(existing) : "";
                    }
                }
            }
        }
    }

    /**
     * Push a guided field edit back into the step's JSON textarea.
     * @param {StepRowController} ctrl
     * @param {HTMLElement} fieldWrap
     * @param {string} rawValue
     */
    function applyGuidedFieldChange(ctrl, fieldWrap, rawValue) {
        const argName = fieldWrap.dataset.argName ?? "";
        const argType = fieldWrap.dataset.argType ?? "string";
        if (!argName) return;
        const nextObj = { ...(readArgsJson(ctrl.argsArea) ?? {}) };
        if (rawValue === "") {
            delete nextObj[argName];
        } else if (argType === "boolean") {
            nextObj[argName] = rawValue === "true";
        } else if (argType === "integer" || argType === "number") {
            const parsed = Number(rawValue);
            if (Number.isFinite(parsed)) nextObj[argName] = argType === "integer" ? Math.trunc(parsed) : parsed;
        } else if (argType === "string-list") {
            const items = rawValue.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
            if (items.length === 0) delete nextObj[argName];
            else nextObj[argName] = items;
        } else {
            nextObj[argName] = rawValue;
        }
        ctrl.argsArea.value = Object.keys(nextObj).length === 0 ? "{}" : JSON.stringify(nextObj, null, 2);
        ctrl.argsArea.removeAttribute("aria-invalid");
    }

    function renumberSteps() {
        for (let i = 0; i < stepControllers.length; i += 1) {
            const ctrl = stepControllers[i];
            the(ctrl.li, "step-number", `Step ${i + 1}`);
            const upBtn = $(ctrl.li, "[data-step-up]");
            const downBtn = $(ctrl.li, "[data-step-down]");
            const removeBtn = $(ctrl.li, "[data-step-remove]");
            if (upBtn instanceof HTMLButtonElement) upBtn.disabled = i === 0;
            if (downBtn instanceof HTMLButtonElement) downBtn.disabled = i === stepControllers.length - 1;
            if (removeBtn instanceof HTMLButtonElement) removeBtn.disabled = stepControllers.length <= 1;
        }
    }

    /**
     * @param {Partial<ScheduledToolCall>} [initial]
     * @param {number} [insertAt]
     */
    function addStepRow(initial = {}, insertAt = stepControllers.length) {
        const li = $.clone(stepsList, "#schedule-step-card");
        if (!(li instanceof HTMLLIElement)) throw new Error("Schedule step card template is missing.");
        if (insertAt < stepControllers.length && stepControllers[insertAt]) {
            stepsList.insertBefore(li, stepControllers[insertAt].li);
        }
        const serverBox = $(li, '[data-schedule-combobox="server"]');
        const toolBox = $(li, '[data-schedule-combobox="tool"]');
        const guidedHost = $(li, "[data-step-guided-fields]");
        const argsArea = $(li, 'textarea[name="stepArguments"]');
        const asideInput = $(li, 'input[name="stepAside"]');
        const descEl = $(li, "[data-step-tool-desc]");
        if (
            !(serverBox instanceof HTMLElement)
            || !(toolBox instanceof HTMLElement)
            || !(guidedHost instanceof HTMLElement)
            || !(argsArea instanceof HTMLTextAreaElement)
            || !(asideInput instanceof HTMLInputElement)
            || !(descEl instanceof HTMLElement)
        ) {
            throw new Error("Schedule step card controls are incomplete.");
        }

        const findSelf = () => stepControllers.find((c) => c.li === li);
        let lastServer = (initial.server ?? "plurnk").trim();
        const serverCombo = attachListCombobox(serverBox, {
            emptyHint: "No matching server — type any active MCP alias.",
            getChoices: () => [...serverCatalog.values()].map((srv) => ({
                value: srv.alias,
                primary: srv.alias,
                secondary: srv.tools.length > 0
                    ? `${srv.tools.length} ${srv.tools.length === 1 ? "tool" : "tools"}${srv.description ? ` · ${srv.description}` : ""}`
                    : srv.description,
                kind: srv.kind,
            })),
            onSelect: (srvName) => {
                const nextServer = srvName.trim();
                const serverChanged = nextServer !== lastServer;
                lastServer = nextServer;
                void hydrateServerCatalog(nextServer);
                const self = findSelf();
                if (self) {
                    if (serverChanged) {
                        const curTool = self.toolCombo.getValue();
                        const hasCurTool = curTool !== ""
                            && (serverCatalog.get(nextServer)?.tools.some((t) => t.name === curTool) ?? false);
                        if (!hasCurTool) {
                            self.toolCombo.setValue("");
                            self.argsArea.value = "{}";
                            self.argsArea.removeAttribute("aria-invalid");
                        }
                    }
                    self.toolCombo.refresh();
                    syncStepToolSchema(self);
                }
            },
            onInput: (srvName) => {
                if (serverCatalog.has(srvName)) void hydrateServerCatalog(srvName);
                const self = findSelf();
                if (self) syncStepToolSchema(self);
            },
        });
        const toolCombo = attachListCombobox(toolBox, {
            emptyHint: "No matching tool — type any tool name for this server.",
            getChoices: () => {
                const srvName = serverCombo.getValue() || "plurnk";
                void hydrateServerCatalog(srvName);
                const tools = serverCatalog.get(srvName)?.tools ?? [];
                return tools.map((t) => ({
                    value: t.name,
                    primary: t.name,
                    secondary: t.description,
                    kind: "tool",
                }));
            },
            onSelect: () => {
                const self = findSelf();
                if (self) syncStepToolSchema(self);
            },
            onInput: () => {
                const self = findSelf();
                if (self) syncStepToolSchema(self);
            },
        });

        /** @type {StepRowController} */
        const ctrl = { li, serverCombo, toolCombo, guidedHost, argsArea, asideInput, descEl };
        serverCombo.setValue(initial.server ?? "plurnk");
        toolCombo.setValue(initial.tool ?? "");
        argsArea.value = initial.arguments && Object.keys(initial.arguments).length > 0
            ? JSON.stringify(initial.arguments, null, 2)
            : "{}";
        asideInput.value = initial.aside ?? "";
        stepControllers.splice(insertAt, 0, ctrl);
        void hydrateServerCatalog(serverCombo.getValue());
        syncStepToolSchema(ctrl);
        renumberSteps();
        return ctrl;
    }

    function clearSteps() {
        for (const ctrl of stepControllers) {
            ctrl.serverCombo.dispose();
            ctrl.toolCombo.dispose();
            ctrl.li.remove();
        }
        stepControllers = [];
    }

    /** @param {readonly ScheduledToolCall[]} steps */
    function setSteps(steps) {
        clearSteps();
        if (steps.length === 0) {
            addStepRow({ server: "plurnk", tool: "" });
            return;
        }
        for (const step of steps) {
            addStepRow(step);
        }
    }

    /** @returns {ScheduledToolCall[]} */
    function collectSteps() {
        /** @type {ScheduledToolCall[]} */
        const calls = [];
        for (let i = 0; i < stepControllers.length; i += 1) {
            const ctrl = stepControllers[i];
            const server = ctrl.serverCombo.getValue();
            const tool = ctrl.toolCombo.getValue();
            if (!server) throw new Error(`Step ${i + 1}: enter a server (e.g. plurnk or an MCP server alias).`);
            if (!tool) throw new Error(`Step ${i + 1}: select or enter a tool name.`);
            const parsedArgs = readArgsJson(ctrl.argsArea);
            if (parsedArgs === null) {
                ctrl.argsArea.setAttribute("aria-invalid", "true");
                throw new Error(`Step ${i + 1} (${server}.${tool}): arguments must be a valid JSON object.`);
            }
            ctrl.argsArea.removeAttribute("aria-invalid");
            const aside = ctrl.asideInput.value.trim();
            calls.push({
                server,
                tool,
                ...(Object.keys(parsedArgs).length > 0 ? { arguments: parsedArgs } : {}),
                ...(aside ? { aside } : {}),
            });
        }
        if (calls.length === 0) throw new Error("Add at least one tool step.");
        return calls;
    }

    function prefillTarget() {
        const ctx = host.getContext();
        if (targetCombobox && targetCombobox.getValue() === "" && ctx.sessionName) {
            targetCombobox.setValue(ctx.sessionName);
        }
    }

    function resetBuilder() {
        editingAlias = null;
        const aliasInput = $(form, 'input[name="alias"]');
        if (aliasInput instanceof HTMLInputElement) aliasInput.value = "";
        const kindSelect = $(form, 'select[name="kind"]');
        if (kindSelect instanceof HTMLSelectElement) kindSelect.value = "prompt";
        const catchupSelect = $(form, 'select[name="catchup"]');
        if (catchupSelect instanceof HTMLSelectElement) catchupSelect.value = "default";
        const personaSelect = $(form, 'select[name="persona"]');
        if (personaSelect instanceof HTMLSelectElement) personaSelect.value = "";
        const promptArea = $(form, 'textarea[name="prompt"]');
        if (promptArea instanceof HTMLTextAreaElement) promptArea.value = "";
        targetCombobox?.setValue(host.getContext().sessionName ?? "");
        writeTimingState(parseRuleToTimingState("manual"));
        setSteps([{ server: "plurnk", tool: "" }]);
        schedulePreview();
    }

    /**
     * Populate the builder from an existing schedule entry so the operator can edit in place.
     * @param {Record<string, unknown>} item
     */
    function loadForEdit(item) {
        const alias = typeof item.alias === "string" ? item.alias : "";
        const def = isRecord(item.definition) ? item.definition : {};
        editingAlias = alias || null;
        const aliasInput = $(form, 'input[name="alias"]');
        if (aliasInput instanceof HTMLInputElement) aliasInput.value = alias;

        const isRun = Array.isArray(def.run);
        const kindSelect = $(form, 'select[name="kind"]');
        if (kindSelect instanceof HTMLSelectElement) kindSelect.value = isRun ? "run" : "prompt";

        const catchupSelect = $(form, 'select[name="catchup"]');
        if (catchupSelect instanceof HTMLSelectElement) {
            catchupSelect.value = def.catchup === true ? "true" : def.catchup === false ? "false" : "default";
        }

        const ruleStr = typeof def.rule === "string" ? def.rule : "manual";
        writeTimingState(parseRuleToTimingState(ruleStr));

        if (isRun) {
            const steps = /** @type {unknown[]} */ (def.run)
                .filter(isRecord)
                .map((s) => ({
                    server: typeof s.server === "string" ? s.server : "plurnk",
                    tool: typeof s.tool === "string" ? s.tool : "",
                    ...(isRecord(s.arguments) ? { arguments: s.arguments } : {}),
                    ...(typeof s.aside === "string" ? { aside: s.aside } : {}),
                }));
            setSteps(steps);
        } else {
            const rawTarget = typeof def.target === "string" ? def.target.replace(/^session:\/\//u, "") : "";
            targetCombobox?.setValue(rawTarget || host.getContext().sessionName || "");
            const personaSelect = $(form, 'select[name="persona"]');
            if (personaSelect instanceof HTMLSelectElement) {
                personaSelect.value = typeof def.persona === "string" ? def.persona : "";
            }
            const promptArea = $(form, 'textarea[name="prompt"]');
            if (promptArea instanceof HTMLTextAreaElement) {
                promptArea.value = typeof def.prompt === "string" ? def.prompt : "";
            }
            if (stepControllers.length === 0) setSteps([{ server: "plurnk", tool: "" }]);
        }

        syncFormAttributes();
        disclosure.open = true;
        schedulePreview({ immediate: true });
        if (aliasInput instanceof HTMLInputElement) aliasInput.focus();
    }

    /**
     * Render a run receipt (success or failure with collected step receipts / `409 already-done` / `409 already-running`).
     * @param {{
     *   readonly alias: string,
     *   readonly status: string,
     *   readonly ok: boolean,
     *   readonly summary: string,
     *   readonly meta?: string,
     *   readonly results?: readonly ScheduledStepReceipt[],
     *   readonly sessionTarget?: string | null,
     *   readonly showReopen?: boolean,
     * }} receipt
     */
    function renderReceipt(receipt) {
        lastReceiptAlias = receipt.alias;
        the(receiptBox, {
            "receipt-status": receipt.ok ? "ok" : "error",
            "receipt-alias": receipt.alias,
            "receipt-status-label": receipt.status,
            "receipt-meta": receipt.meta ?? "",
            "receipt-summary": receipt.summary,
        });
        const reopenBtn = $(receiptBox, "[data-receipt-reopen]");
        if (reopenBtn instanceof HTMLButtonElement) reopenBtn.hidden = receipt.showReopen !== true;

        const linkLine = $(receiptBox, "[data-receipt-session-link]");
        const ctx = host.getContext();
        const sessionHref = receipt.sessionTarget && ctx.workspaceName
            ? directoryPath({ kind: "session", workspace: ctx.workspaceName, session: receipt.sessionTarget })
            : null;
        if (linkLine instanceof HTMLElement) {
            if (sessionHref && receipt.sessionTarget) {
                the(linkLine, {
                    "receipt-session-href": sessionHref,
                    "receipt-session-label": `Open session #${receipt.sessionTarget} →`,
                });
                linkLine.hidden = false;
            } else {
                linkLine.hidden = true;
            }
        }

        const stepsOl = $(receiptBox, "[data-schedule-receipt-steps]");
        if (stepsOl instanceof HTMLOListElement) {
            const steps = receipt.results ?? [];
            stepsOl.hidden = steps.length === 0;
            $.cloneEach(stepsOl, "#schedule-receipt-step", steps, (li, step) => {
                li.dataset.receiptStepOk = step.status < 400 ? "true" : "false";
                const idxEl = $(li, "[data-receipt-step-index]");
                const callEl = $(li, "[data-receipt-step-call]");
                const statusEl = $(li, "[data-receipt-step-status]");
                const uriEl = $(li, "[data-receipt-step-uri]");
                const preEl = $(li, "[data-receipt-step-preview]");
                const codeEl = preEl ? $(preEl, "code") : null;
                const probEl = $(li, "[data-receipt-step-problem]");
                if (idxEl) idxEl.textContent = `#${step.index + 1}`;
                if (callEl) callEl.textContent = `${step.server}.${step.tool}`;
                if (statusEl) statusEl.textContent = String(step.status);
                if (uriEl instanceof HTMLElement) {
                    uriEl.textContent = step.uri ?? "";
                    uriEl.hidden = !step.uri;
                }
                if (preEl instanceof HTMLElement && codeEl) {
                    codeEl.textContent = step.preview ?? "";
                    preEl.hidden = !step.preview;
                }
                if (probEl instanceof HTMLElement) {
                    const probDetail = isRecord(step.problem)
                        ? [
                            typeof step.problem.detail === "string" ? step.problem.detail : "",
                            typeof step.problem.recovery === "string" ? step.problem.recovery : "",
                        ].filter(Boolean).join(" ")
                        : "";
                    probEl.textContent = probDetail;
                    probEl.hidden = !probDetail;
                }
            });
        }
        receiptBox.hidden = false;
    }

    /**
     * Render the schedule inventory table from a `workspace.schedule.list` response.
     * @param {unknown} res
     */
    function renderList(res) {
        const rawItems = isRecord(res) && Array.isArray(res.definitions) ? res.definitions : [];
        const items = rawItems.filter(isRecord);
        scheduleByAlias.clear();
        for (const item of items) {
            if (typeof item.alias === "string" && item.alias) {
                scheduleByAlias.set(item.alias, item);
            }
        }
        $.cloneEach(tbody, "#workspace-schedule-row", items, (tr, item) => {
            const alias = typeof item.alias === "string" ? item.alias : "";
            const origin = typeof item.origin === "string" ? item.origin : "workspace";
            const state = typeof item.state === "string" ? item.state : "active";
            const def = isRecord(item.definition) ? item.definition : {};
            const detail = isRecord(item.detail) ? item.detail : {};
            const isRun = Array.isArray(def.run) || detail.kind === "run";
            const ruleStr = typeof detail.rule === "string" ? detail.rule : (typeof def.rule === "string" ? def.rule : "manual");
            const ruleText = typeof detail.text === "string" && detail.text
                ? detail.text
                : ruleStr === "manual"
                    ? "manual trigger"
                    : ruleStr === "once"
                        ? "unscheduled single-shot obligation"
                        : ruleStr;
            const nextStr = typeof detail.next === "string" && detail.next ? `Next: ${detail.next}` : "";
            const obligation = detail.status === "done" || detail.status === "fail"
                ? detail.status
                : state === "unavailable"
                    ? "fail"
                    : "open";
            const problemDetail = (state === "unavailable" || obligation === "fail") && isRecord(item.problem)
                ? (typeof item.problem.detail === "string" ? item.problem.detail
                    : typeof item.problem.title === "string" ? item.problem.title : "")
                : "";
            const statusText = state === "disabled"
                ? "disabled"
                : problemDetail
                    ? `${obligation}: ${problemDetail}`
                    : obligation;
            const metaParts = [];
            if (typeof detail.lastFiredAt === "string" && detail.lastFiredAt) metaParts.push(`Last: ${detail.lastFiredAt}`);
            if (typeof detail.doneAt === "string" && detail.doneAt) metaParts.push(`Done: ${detail.doneAt}`);
            if (origin !== "workspace") metaParts.push(origin);
            const rowState = state === "disabled" ? "disabled"
                : state === "unavailable" ? "retryable"
                : "active";
            const canRun = state !== "disabled" && !(ruleStr === "once" && obligation === "done");
            the(tr, {
                "sched-alias": alias,
                "sched-kind": isRun ? "Macro" : "Prompt",
                "sched-rule-text": ruleText,
                "sched-next": nextStr,
                "sched-action": formatScheduleAction(def),
                "sched-status": statusText,
                "sched-meta": metaParts.join(" · "),
                "family-removable": origin === "workspace" ? "true" : "false",
                "family-state": rowState,
                "schedule-obligation": obligation,
                "schedule-can-run": canRun ? "true" : "false",
                "schedule-row-kind": isRun ? "run" : "prompt",
            });
            const runBtn = $(tr, "[data-schedule-run]");
            if (runBtn instanceof HTMLButtonElement) runBtn.disabled = !canRun;
        });
        the(panel, { "family-count": items.length });
    }

    /**
     * Refresh auxiliary workspace metadata (active MCP servers, sessions, personas, workspace clock) in the background.
     */
    async function refreshAuxiliaryData() {
        activated = true;
        const ctx = host.getContext();
        if (ctx.workspaceId <= 0) return;
        const [mcpRes, sessionsRes, personasRes, clockRes] = await Promise.all([
            host.invoke("workspace.mcp.list", {}).catch(() => null),
            host.invoke("workspace.sessions", { workspaceId: ctx.workspaceId }).catch(() => null),
            host.invoke("workspace.personas.list", {}).catch(() => null),
            host.invoke("workspace.schedule.discover", {}).catch(() => null),
        ]);
        if (ctx.signal.aborted) return;

        // Sessions for target combobox + entry.read session hint
        if (isRecord(sessionsRes) && Array.isArray(sessionsRes.sessions)) {
            const activeModelSessions = sessionsRes.sessions
                .filter((row) => isRecord(row) && typeof row.name === "string" && row.origin === "model" && !row.archivedAt)
                .map((row) => String(/** @type {Record<string, unknown>} */ (row).name));
            workspaceSessions = activeModelSessions;
            readSessionName = ctx.sessionName ?? activeModelSessions[0] ?? null;
            targetCombobox?.refresh();
        } else {
            readSessionName = ctx.sessionName;
        }

        // Personas for Prompt mode auto-create persona selector
        if (isRecord(personasRes) && Array.isArray(personasRes.definitions)) {
            workspacePersonas = personasRes.definitions
                .filter((entry) => isRecord(entry) && typeof entry.alias === "string" && entry.state !== "disabled")
                .map((entry) => {
                    const def = isRecord(entry.definition) ? entry.definition : null;
                    return {
                        alias: String(entry.alias),
                        description: def && typeof def.description === "string" ? def.description : "",
                    };
                });
            updatePersonaChoices();
        }

        // Workspace clock readout
        if (isRecord(clockRes) && Array.isArray(clockRes.candidates) && isRecord(clockRes.candidates[0])) {
            const summary = typeof clockRes.candidates[0].summary === "string" ? clockRes.candidates[0].summary : "";
            if (summary) the(panel, "schedule-clock", summary);
        }

        // MCP servers for macro step Server + Tool autocomplete
        if (isRecord(mcpRes) && Array.isArray(mcpRes.definitions)) {
            const keep = new Set(["plurnk"]);
            for (const entry of mcpRes.definitions) {
                if (!isRecord(entry) || typeof entry.alias !== "string" || entry.state === "disabled") continue;
                const alias = entry.alias;
                keep.add(alias);
                const detail = isRecord(entry.detail) ? entry.detail : null;
                const description = detail && typeof detail.description === "string" ? detail.description : "";
                const toolNames = detail && Array.isArray(detail.tools)
                    ? detail.tools.filter((t) => typeof t === "string" && t.length > 0)
                    : [];
                const prev = serverCatalog.get(alias);
                const prevMatches = prev?.hydrated === true
                    && prev.tools.length === toolNames.length
                    && toolNames.every((name) => prev.tools.some((t) => t.name === name));
                if (!prevMatches) {
                    serverCatalog.set(alias, {
                        alias,
                        description,
                        kind: "mcp",
                        tools: toolNames.map((name) => ({ name, description: "" })),
                        hydrated: false,
                    });
                }
            }
            for (const key of [...serverCatalog.keys()]) {
                if (!keep.has(key)) serverCatalog.delete(key);
            }
            for (const ctrl of stepControllers) {
                ctrl.serverCombo.refresh();
                ctrl.toolCombo.refresh();
            }
        }

        void hydrateServerCatalog("plurnk");
    }

    /**
     * Build the validated `workspace.schedule.replace` payload from the form state.
     * @returns {{ readonly alias: string, readonly payload: Record<string, unknown> }}
     */
    function buildPayload() {
        const aliasInput = $(form, 'input[name="alias"]');
        const kindEl = $(form, 'select[name="kind"]');
        const catchupEl = $(form, 'select[name="catchup"]');
        const alias = aliasInput instanceof HTMLInputElement ? aliasInput.value.trim() : "";
        if (!alias) throw new Error("Enter a schedule alias.");
        const timing = readTimingState();
        const rule = synthesizeScheduleRule(timing);
        const catchupRaw = catchupEl instanceof HTMLSelectElement ? catchupEl.value : "default";
        const catchupPart = timing.mode !== "manual" && timing.mode !== "once" && (catchupRaw === "true" || catchupRaw === "false")
            ? { catchup: catchupRaw === "true" }
            : {};
        const kind = kindEl instanceof HTMLSelectElement && kindEl.value === "run" ? "run" : "prompt";
        if (kind === "run") {
            const run = collectSteps();
            return {
                alias,
                payload: { alias, rule, run, ...catchupPart },
            };
        }
        const rawTarget = targetCombobox?.getValue() ?? "";
        const promptArea = $(form, 'textarea[name="prompt"]');
        const prompt = promptArea instanceof HTMLTextAreaElement ? promptArea.value.trim() : "";
        if (!rawTarget || !prompt) throw new Error("Enter both a target session and a prompt.");
        const target = rawTarget.startsWith("session://") ? rawTarget : `session://${rawTarget}`;
        const personaEl = $(form, 'select[name="persona"]');
        const persona = personaEl instanceof HTMLSelectElement ? personaEl.value.trim() : "";
        return {
            alias,
            payload: {
                alias,
                rule,
                target,
                prompt,
                ...(persona ? { persona } : {}),
                ...catchupPart,
            },
        };
    }

    // Initialize default builder state
    resetBuilder();

    // Form control reactivity (attribute-driven CSS visibility + debounced preview)
    on(form, "change", 'select[name="kind"], select[name="scheduleMode"], select[name="repeatPreset"], select[name="relativeUnit"], input[name="repeatDay"], input[name="atLocal"], input[name="repeatTime"]', () => {
        syncFormAttributes();
        schedulePreview();
    });

    on(form, "input", 'input[name="relativeAmount"], input[name="repeatInterval"], input[name="repeatDayOfMonth"], input[name="rule"]', () => {
        schedulePreview();
    });

    on(form, "click", "[data-schedule-preview-btn]", () => {
        schedulePreview({ immediate: true });
    });

    on(form, "click", "[data-schedule-cancel-edit], [data-schedule-reset]", () => {
        resetBuilder();
        host.setFeedback(false, "", "");
    });

    on(form, "click", "[data-schedule-add-step]", () => {
        const ctrl = addStepRow({ server: "plurnk", tool: "" });
        ctrl.toolCombo.input.focus();
    });

    on(stepsList, "click", "[data-step-up], [data-step-down], [data-step-duplicate], [data-step-remove]", (_event, button) => {
        const li = button.closest("[data-schedule-step]");
        const idx = stepControllers.findIndex((c) => c.li === li);
        if (idx < 0) return;
        const current = stepControllers[idx];
        if (button.hasAttribute("data-step-up") && idx > 0) {
            const prev = stepControllers[idx - 1];
            stepsList.insertBefore(current.li, prev.li);
            stepControllers.splice(idx, 1);
            stepControllers.splice(idx - 1, 0, current);
            renumberSteps();
        } else if (button.hasAttribute("data-step-down") && idx < stepControllers.length - 1) {
            const next = stepControllers[idx + 1];
            stepsList.insertBefore(next.li, current.li);
            stepControllers.splice(idx, 1);
            stepControllers.splice(idx + 1, 0, current);
            renumberSteps();
        } else if (button.hasAttribute("data-step-duplicate")) {
            const parsedArgs = readArgsJson(current.argsArea) ?? {};
            addStepRow({
                server: current.serverCombo.getValue(),
                tool: current.toolCombo.getValue(),
                arguments: parsedArgs,
                aside: current.asideInput.value.trim(),
            }, idx + 1);
        } else if (button.hasAttribute("data-step-remove") && stepControllers.length > 1) {
            current.serverCombo.dispose();
            current.toolCombo.dispose();
            current.li.remove();
            stepControllers.splice(idx, 1);
            renumberSteps();
        }
    });

    on(stepsList, "input", "[data-step-guided-fields] input, [data-step-guided-fields] textarea", (_event, target) => {
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        const fieldWrap = target.closest("[data-arg-name]");
        const li = target.closest("[data-schedule-step]");
        const ctrl = stepControllers.find((c) => c.li === li);
        if (ctrl && fieldWrap instanceof HTMLElement) {
            applyGuidedFieldChange(ctrl, fieldWrap, target.value);
        }
    });

    on(stepsList, "change", "[data-step-guided-fields] select", (_event, target) => {
        if (!(target instanceof HTMLSelectElement)) return;
        const fieldWrap = target.closest("[data-arg-name]");
        const li = target.closest("[data-schedule-step]");
        const ctrl = stepControllers.find((c) => c.li === li);
        if (ctrl && fieldWrap instanceof HTMLElement) {
            applyGuidedFieldChange(ctrl, fieldWrap, target.value);
        }
    });

    on(stepsList, "input", 'textarea[name="stepArguments"]', (_event, target) => {
        if (!(target instanceof HTMLTextAreaElement)) return;
        const li = target.closest("[data-schedule-step]");
        const ctrl = stepControllers.find((c) => c.li === li);
        if (!ctrl) return;
        const parsed = readArgsJson(target);
        if (parsed === null) {
            target.setAttribute("aria-invalid", "true");
        } else {
            target.removeAttribute("aria-invalid");
            syncStepToolSchema(ctrl);
        }
    });

    // Save schedule / macro
    on(form, "submit", "form", (event) => {
        event.preventDefault();
        targetCombobox?.close();
        for (const ctrl of stepControllers) {
            ctrl.serverCombo.close();
            ctrl.toolCombo.close();
        }
        let built;
        try {
            built = buildPayload();
        } catch (error) {
            host.setFeedback(false, error instanceof Error ? error.message : String(error), "");
            return;
        }
        void host.runMutation(async () => {
            await host.invoke("workspace.schedule.replace", built.payload);
            const fresh = await host.invoke("workspace.schedule.list", {});
            renderList(fresh);
            resetBuilder();
            disclosure.open = false;
            return `${built.alias}  saved`;
        });
    });

    // Receipt controls
    on(receiptBox, "click", "[data-receipt-dismiss]", () => {
        receiptBox.hidden = true;
    });

    on(receiptBox, "click", "[data-receipt-reopen]", () => {
        if (!lastReceiptAlias) return;
        const alias = lastReceiptAlias;
        void host.runMutation(async () => {
            await host.invoke("workspace.schedule.status", { alias, status: "open" });
            const fresh = await host.invoke("workspace.schedule.list", {});
            renderList(fresh);
            receiptBox.hidden = true;
            return `${alias}  open`;
        });
    });

    // Row actions: Run now, Edit, Done, Reopen, Enable/Retry, Disable, Remove
    on(panel, "submit", "[data-schedule-row-form]", (event, rowForm) => {
        event.preventDefault();
        if (!(rowForm instanceof HTMLFormElement)) return;
        const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLButtonElement ? event.submitter : null;
        const operation = submitter?.value ?? "";
        const alias = String(new FormData(rowForm).get("alias") ?? "").trim();
        if (!alias) return;

        if (operation === "edit") {
            const item = scheduleByAlias.get(alias);
            if (item) {
                loadForEdit(item);
                host.setFeedback(false, "", "");
            }
            return;
        }

        if (operation === "run") {
            const existing = scheduleByAlias.get(alias);
            const existingDef = isRecord(existing?.definition) ? existing.definition : null;
            const sessionTarget = existingDef && typeof existingDef.target === "string"
                ? existingDef.target.replace(/^session:\/\//u, "")
                : null;
            void host.runMutation(async () => {
                try {
                    const res = await host.invoke("workspace.schedule.run", { alias });
                    const fresh = await host.invoke("workspace.schedule.list", {});
                    renderList(fresh);
                    const rec = isRecord(res) ? res : {};
                    const status = typeof rec.status === "string" ? rec.status : "open";
                    const loopId = typeof rec.loopId === "number" ? rec.loopId : null;
                    const lastFiredAt = typeof rec.lastFiredAt === "string" ? rec.lastFiredAt : "";
                    const results = parseStepReceipts(rec.results);
                    const meta = [
                        loopId !== null ? `loop ${loopId}` : "",
                        lastFiredAt ? `fired ${lastFiredAt}` : "",
                    ].filter(Boolean).join(" · ");
                    renderReceipt({
                        alias,
                        status,
                        ok: true,
                        summary: results.length > 0
                            ? `Completed ${results.length} ${results.length === 1 ? "step" : "steps"}.`
                            : sessionTarget
                                ? `Delivered prompt to session://${sessionTarget}.`
                                : "Executed schedule.",
                        meta,
                        results,
                        sessionTarget: results.length === 0 ? sessionTarget : null,
                    });
                    return results.length > 0
                        ? `${alias}  ${status} (${results.length} ${results.length === 1 ? "step" : "steps"})`
                        : `${alias}  ${status}`;
                } catch (error) {
                    const cause = error instanceof Error && isRecord(error.cause) ? error.cause : null;
                    const problemType = cause && typeof cause.type === "string" ? cause.type : "";
                    const problemStatus = cause && typeof cause.status === "number" ? cause.status : 500;
                    const problemDetail = cause && typeof cause.detail === "string"
                        ? cause.detail
                        : (error instanceof Error ? error.message : String(error));
                    const results = parseStepReceipts(cause?.results);
                    const isAlreadyDone = problemType.endsWith("/already-done");
                    const isAlreadyRunning = problemType.endsWith("/already-running");
                    renderReceipt({
                        alias,
                        status: isAlreadyDone ? "409 already-done" : isAlreadyRunning ? "409 already-running" : `${problemStatus} failed`,
                        ok: false,
                        summary: problemDetail,
                        results,
                        showReopen: isAlreadyDone,
                    });
                    const fresh = await host.invoke("workspace.schedule.list", {}).catch(() => null);
                    if (fresh !== null) renderList(fresh);
                    throw error;
                }
            });
            return;
        }

        if (operation === "done" || operation === "reopen") {
            const nextStatus = operation === "done" ? "done" : "open";
            void host.runMutation(async () => {
                await host.invoke("workspace.schedule.status", { alias, status: nextStatus });
                const fresh = await host.invoke("workspace.schedule.list", {});
                renderList(fresh);
                return `${alias}  ${nextStatus}`;
            });
            return;
        }

        if (["enable", "disable", "remove"].includes(operation)) {
            void host.runMutation(async () => {
                await host.invoke(`workspace.schedule.${operation}`, { alias });
                const fresh = await host.invoke("workspace.schedule.list", {});
                renderList(fresh);
                const isRetry = submitter?.hasAttribute("data-family-retry") === true;
                const verbLabel = operation === "remove" ? "removed" : isRetry ? "retried" : `${operation}d`;
                return `${alias}  ${verbLabel}`;
            });
        }
    });

    on.target(host.getContext().signal, "abort", () => {
        if (previewTimer !== null) clearTimeout(previewTimer);
        previewAbort?.abort();
        targetCombobox?.dispose();
        clearSteps();
    });

    return {
        renderList,
        prefillTarget,
        refreshAuxiliaryData,
        dispose() {
            if (previewTimer !== null) clearTimeout(previewTimer);
            previewAbort?.abort();
            targetCombobox?.dispose();
            clearSteps();
        },
    };
}
