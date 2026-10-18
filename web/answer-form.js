import { $, on, the } from "on_the_money";

/** @typedef {Record<string, unknown>} Schema */
const OBJECT_KEYS = new Set(["$schema", "type", "properties", "required", "additionalProperties", "title", "description"]);
const FIELD_KEYS = new Set([
    "type", "title", "description", "enum", "enumNames", "default", "examples", "format",
    "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);
/** @param {unknown} value @returns {value is Schema} */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** {§web-worker-questions} This selects controls, not a second JSON Schema validator.
 * @param {Schema} schema @returns {Array<[string, Schema]> | null}
 */
function fieldsOf(schema) {
    if ((schema.type !== undefined && schema.type !== "object") || !object(schema.properties)
        || Object.keys(schema).some((key) => !OBJECT_KEYS.has(key))
        || (schema.required !== undefined && (!Array.isArray(schema.required)
            || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(/** @type {object} */ (schema.properties), key))))) return null;
    const fields = Object.entries(schema.properties);
    if (fields.some(([, field]) => !object(field) || !["string", "number", "integer", "boolean"].includes(String(field.type))
        || Object.keys(field).some((key) => !FIELD_KEYS.has(key))
        || (field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.some((value) =>
            !["string", "number", "boolean"].includes(typeof value)))))) return null;
    return /** @type {Array<[string, Schema]>} */ (fields);
}

/** @param {Element} parent @param {string} name @param {Schema} schema @param {boolean} required */
function fieldControl(parent, name, schema, required) {
    const row = $.clone(parent, "#answer-field");
    const value = $(row, "[data-answer-value]");
    const include = $(row, "[data-answer-include]");
    if (!(value instanceof HTMLFieldSetElement) || !(include instanceof HTMLInputElement)) throw new Error("Answer field template is incomplete.");
    the(row, { fieldName: name, fieldTitle: typeof schema.title === "string" ? schema.title : name,
        fieldDescription: typeof schema.description === "string" ? schema.description : "", fieldOptional: !required });
    include.checked = required || Object.hasOwn(schema, "default");
    value.disabled = !include.checked;
    on(row, "change", "[data-answer-include]", () => { value.disabled = !include.checked; });
    /** @type {(() => unknown)} */
    let read;
    if (schema.enum !== undefined || schema.type === "boolean") {
        const select = $.clone(value, schema.enum !== undefined ? "#answer-select" : "#answer-boolean");
        if (!(select instanceof HTMLSelectElement)) throw new Error("Answer select template is incomplete.");
        if (Array.isArray(schema.enum)) {
            const values = schema.enum;
            const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
            for (const [index, item] of values.entries()) {
                the($.clone(select, "#answer-option"), { optionValue: String(index), optionLabel: typeof names[index] === "string" ? names[index] : String(item) });
            }
            const selected = values.findIndex((item) => item === schema.default);
            if (selected !== -1) select.value = String(selected);
            read = () => values[Number(select.value)];
        } else {
            if (typeof schema.default === "boolean") select.value = String(schema.default);
            read = () => select.value === "true";
        }
    } else if (schema.type === "string") {
        const text = $.clone(value, "#answer-text");
        if (!(text instanceof HTMLTextAreaElement)) throw new Error("Answer text template is incomplete.");
        if (typeof schema.default === "string") text.value = schema.default;
        read = () => text.value;
    } else {
        const number = $.clone(value, "#answer-number");
        if (!(number instanceof HTMLInputElement)) throw new Error("Answer number template is incomplete.");
        if (typeof schema.default === "number") number.value = String(schema.default);
        read = () => number.valueAsNumber;
    }
    const title = typeof schema.title === "string" ? schema.title : name;
    the(row, "answer-label", title);
    return () => include.checked ? [[name, read()]] : [];
}

/** @param {Element} row @param {Schema} schema */
export default function answerForm(row, schema) {
    const cancel = $(row, "[data-answer-cancel]");
    const fields = $(row, "[data-answer-fields]");
    if (!(cancel instanceof HTMLInputElement) || !(fields instanceof HTMLFieldSetElement)) throw new Error("Question template is incomplete.");
    on(row, "change", "[data-answer-cancel]", () => { fields.disabled = cancel.checked; });
    const simple = fieldsOf(schema);
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const readers = simple?.map(([name, field]) => fieldControl(fields, name, field, required.has(name)));
    const jsonLabel = simple === null ? $.clone(fields, "#answer-json") : null;
    const json = jsonLabel && $(jsonLabel, "textarea");
    if (jsonLabel && !(json instanceof HTMLTextAreaElement)) throw new Error("JSON answer template is incomplete.");
    return {
        /** @returns {Promise<{status: "cancelled"} | {status: "resolved", payload: unknown} | undefined>} */
        async read() {
            the(row, "response-error", "");
            if (cancel.checked) return { status: "cancelled" };
            let payload;
            if (json instanceof HTMLTextAreaElement) {
                try { payload = JSON.parse(json.value); }
                catch { the(row, "response-error", "Enter valid JSON."); return; }
            } else payload = Object.fromEntries(readers?.flatMap((read) => read()) ?? []);
            try {
                const { Validator } = await import("@plurnk/plurnk-contracts");
                const result = Validator.validateJsonSchemaInstance(schema, payload);
                if (!result.valid) {
                    the(row, "response-error", `Answer does not satisfy the requested schema: ${result.errors.map(({ instanceLocation, error }) => `${instanceLocation}: ${error}`).join("; ")}`);
                    return;
                }
            } catch (cause) {
                the(row, "response-error", `Answer validation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
                return;
            }
            return { status: "resolved", payload };
        },
    };
}
