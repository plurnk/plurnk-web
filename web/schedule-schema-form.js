import { $, the } from "on_the_money";
import { EFFORTS } from "@plurnk/plurnk-contracts";
import { isRecord } from "./session-translator.js";

const TURN_ONLY_PLURNK_TOOLS = new Set(["done", "fail", "wait", "question"]);

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
 *   readonly server: string,
 *   readonly tool: string,
 *   readonly arguments?: Record<string, unknown>,
 *   readonly aside?: string,
 * }} ScheduledToolCall
 */

/**
 * Curated fallback catalog for built-in schedule-safe `plurnk` tools when `mcp:///plurnk.json`
 * is not yet available (e.g. zero-session workspace or minimal unit fixture). Live `entry.read`
 * schemas from `mcp:///plurnk.json` enrich and supersede these entries whenever available.
 * @type {readonly ToolCatalogEntry[]}
 */
export const BUILTIN_PLURNK_TOOLS = Object.freeze([
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
 * {§web-workspace-settings} Extract compact guided scalar and string-list fields from a JSON Schema object.
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
 * Parse a JSON tool catalog read from `mcp:///<server>.json`.
 * @param {string} server
 * @param {unknown} readResult
 * @returns {readonly ToolCatalogEntry[] | null}
 */
export function parseToolCatalogEntry(server, readResult) {
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
 * Safely parse the step's raw JSON arguments textarea into a plain record.
 * @param {HTMLTextAreaElement} area
 * @returns {Record<string, unknown> | null}
 */
export function readArgsJson(area) {
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
 * Render guided JSON-Schema fields into `guidedHost` for a schedule macro step.
 * @param {HTMLElement} guidedHost
 * @param {readonly GuidedArgField[]} fields
 * @param {Record<string, unknown>} currentArgs
 */
export function renderGuidedFields(guidedHost, fields, currentArgs) {
    guidedHost.replaceChildren();
    guidedHost.hidden = fields.length === 0;
    for (const field of fields) {
        const isSelect = field.type === "boolean" || field.type === "enum";
        const wrapper = isSelect
            ? $.clone(guidedHost, "#schedule-step-arg-select")
            : $.clone(guidedHost, "#schedule-step-arg-field");
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
                const opts = field.type === "boolean"
                    ? [
                        { value: "", label: field.required ? "Choose…" : "(unset)" },
                        { value: "true", label: "true" },
                        { value: "false", label: "false" },
                    ]
                    : [
                        { value: "", label: field.required ? "Choose…" : "(unset)" },
                        ...(field.enumValues ?? []).map((v) => ({ value: v, label: v })),
                    ];
                $.cloneEach(sel, "#setting-option", opts, (optEl, choice) => {
                    the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
                });
                if (typeof existing === "boolean") sel.value = String(existing);
                else if (typeof existing === "string" && opts.some((o) => o.value === existing)) sel.value = existing;
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
 * Synchronize a guided field input/select edit back into the raw JSON arguments `<textarea>`.
 * @param {HTMLTextAreaElement} argsArea
 * @param {HTMLElement} fieldWrap
 * @param {string} rawValue
 */
export function applyGuidedFieldChange(argsArea, fieldWrap, rawValue) {
    const argName = fieldWrap.dataset.argName ?? "";
    const argType = fieldWrap.dataset.argType ?? "string";
    if (!argName) return;
    const nextObj = { ...(readArgsJson(argsArea) ?? {}) };
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
    argsArea.value = Object.keys(nextObj).length === 0 ? "{}" : JSON.stringify(nextObj, null, 2);
    argsArea.removeAttribute("aria-invalid");
}
