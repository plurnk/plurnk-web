import { $, the } from "on_the_money";

/** @typedef {Record<string, unknown>} RecordValue */
/** @typedef {[string, string]} Field */

/** @param {unknown} value @returns {RecordValue | null} */
export function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? /** @type {RecordValue} */ (value) : null;
}

/** @param {unknown} value @returns {RecordValue | null} */
export function argumentsOf(value) {
    const direct = record(value);
    if (direct) return direct;
    if (typeof value !== "string") return null;
    try { return record(JSON.parse(value)); }
    catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
}

/** @param {unknown} content @returns {RecordValue | null} */
export function receiptOf(content) {
    const direct = record(content);
    if (direct && Number.isInteger(direct.status)) return direct;
    const texts = typeof content === "string" ? [content]
        : Array.isArray(content)
            ? content.flatMap((part) => {
                if (part?.type === "text" && typeof part.text === "string") return [part.text];
                if (part?.type === "content" && part.content?.type === "text" && typeof part.content.text === "string") return [part.content.text];
                return [];
            })
            : [];
    for (const text of texts) {
        const receipt = argumentsOf(text);
        if (receipt && Number.isInteger(receipt.status)) return receipt;
    }
    return null;
}

/** @param {unknown} value @returns {string} */
const textOf = (value) => typeof value === "string" ? value : "";

/** @param {RecordValue | null} args @param {unknown} op @returns {string} */
export function bodyOf(args, op) {
    return typeof args?.body === "string" ? args.body : op === "NOTE" ? "" : textOf(record(args?.body)?.raw);
}

/** @param {RecordValue | null} selection @param {unknown} address @returns {Field[]} */
function operand(selection, address) {
    const path = textOf(record(selection?.target)?.raw) || textOf(address);
    const marks = record(selection?.lineMarker)?.marks;
    const pattern = textOf(record(selection?.matcher)?.raw);
    /** @type {Field[]} */
    const fields = [];
    if (path) fields.push(["path", `(${path})`]);
    if (Array.isArray(marks) && marks.length) fields.push(["scope", `<${marks.join(",")}>`]);
    if (pattern) fields.push(["pattern", pattern]);
    return fields;
}

/** @param {string} op @param {RecordValue | null} receipt @returns {number | null} */
function countOf(op, receipt) {
    if (op !== "READ" && op !== "FIND") return null;
    if (op === "READ" && Array.isArray(receipt?.lineOrdinals)) return receipt.lineOrdinals.length;
    const range = record(receipt?.range);
    const returned = range?.returned;
    if (Array.isArray(returned) && returned.length === 2 && returned.every(Number.isSafeInteger)) return Math.max(0, returned[1] - returned[0] + 1);
    return op === "FIND" && typeof range?.total === "number" ? range.total : null;
}

/** @param {RecordValue | null} receipt @param {unknown} status @param {string} error */
function outcomeOf(receipt, status, error) {
    const problem = record(receipt?.problem);
    const parts = [error];
    if (typeof status === "number" && status >= 400) parts.push(
        textOf(problem?.title), textOf(problem?.detail), textOf(problem?.recovery), textOf(receipt?.detail),
    );
    else if (status === 204) parts.push(textOf(receipt?.detail));
    const outcome = [...new Set(parts.filter(Boolean))].join(" — ");
    return outcome || (typeof status === "number" && status >= 400 ? String(status) : "");
}

/** @param {Element} outlet @param {Field[]} fields */
function appendFields(outlet, fields) {
    for (const [kind, text] of fields) {
        if (outlet.hasChildNodes()) outlet.append(" ");
        const field = $.clone(outlet, "#operation-field");
        the(field, "plurnk-field", kind);
        field.textContent = text;
    }
}

// {§web-operation-summary} Only render revisions, not a parallel message collection.
/** @type {WeakMap<Element, string>} */
const painted = new WeakMap();

/** @param {Element} summary @param {string | null} name @param {RecordValue | null} args
 * @param {RecordValue | null} receipt @param {RecordValue | null} facts @param {string} error
 */
export default function operationSummary(summary, name, args, receipt, facts, error) {
    if (name === null) {
        summary.replaceChildren();
        return;
    }
    const op = textOf(facts?.op) || name;
    const aside = textOf(args?.aside ?? facts?.aside);
    const status = receipt?.status ?? facts?.status;
    const count = countOf(op, receipt);
    const outcome = outcomeOf(receipt, status, error);
    /** @type {Field[]} */
    const heading = [];
    if (name !== "error" && name === name.toLowerCase()) heading.push(["runtime", name]);
    if (aside) heading.push(["aside", aside]);
    const paired = record(args?.source) || record(args?.destination);
    const operands = paired
        ? [operand(record(args?.source), null), operand(record(args?.destination), null)]
        : [operand(args, receipt?.path ?? facts?.address)];
    /** @type {Field[]} */
    const result = [];
    if (count !== null) result.push(["count", `{${count}}`]);

    let header = $(summary, ':scope > [data-plurnk-field="heading"]');
    header ??= $.clone(summary, "#operation-header", { position: "afterbegin" });
    const headingRevision = JSON.stringify(heading);
    if (painted.get(header) !== headingRevision) {
        header.replaceChildren();
        appendFields(header, heading);
        painted.set(header, headingRevision);
    }
    let details = $(summary, ":scope > [data-plurnk-operands]");
    if (!operands.some((fields) => fields.length) && !result.length) {
        details?.remove();
    } else {
        details ??= $.clone(header, "#operation-operands", { position: "afterend" });
        const revision = JSON.stringify([operands, result]);
        if (painted.get(details) !== revision) {
            details.replaceChildren();
            for (const fields of operands) {
                if (!fields.length) continue;
                if (details.hasChildNodes()) details.append(" ");
                appendFields($.clone(details, "#operation-operand"), fields);
            }
            appendFields(details, result);
            painted.set(details, revision);
        }
    }
    let conclusion = $(summary, ':scope > [data-plurnk-field="outcome"]');
    if (!outcome) { conclusion?.remove(); return; }
    conclusion ??= $.clone(header, "#operation-outcome", { position: "afterend" });
    if (header.nextElementSibling !== conclusion) header.after(conclusion);
    if (conclusion.textContent !== outcome) conclusion.textContent = outcome;
}
