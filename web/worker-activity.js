import { $, the } from "on_the_money";
import bodyReferences from "./body-references.js";

/** @typedef {{url: string, mimeType?: string}} Reference */

/** @param {unknown} value @returns {Reference | undefined} */
function referenceOf(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string" || !value.url.trim()
        || ("mimeType" in value && typeof value.mimeType !== "string")) throw new TypeError("Ambient body reference is incomplete.");
    return /** @type {Reference} */ (value);
}

/** {§web-worker-activity} Project only received observations; the SDK owns conversation.
 * @param {HTMLElement} root @param {(address: string) => Promise<string>} read
 */
export default function activity(root, read) {
    const list = $(root, ":scope > ol");
    if (!(list instanceof HTMLOListElement)) throw new Error("Worker activity has no list.");
    const inspect = bodyReferences(root, read);
    /** @type {Map<string, Element>} */
    const rows = new Map();
    /** @type {WeakMap<Element, string>} */
    const references = new WeakMap();

    /** @param {Element} row @param {string} selector @param {Reference | undefined} source @param {string} label */
    function reference(row, selector, source, label) {
        const outlet = $(row, selector);
        if (!outlet) throw new Error("Activity template has no body outlet.");
        const revision = JSON.stringify(source ?? null);
        if (references.get(outlet) === revision) return;
        outlet.replaceChildren();
        if (source) inspect(outlet, { value: source.url, mimeType: source.mimeType }, label);
        references.set(outlet, revision);
    }

    /** @param {import("@ag-ui/client").CustomEvent} event */
    return (event) => {
        if (event.name !== "plurnk.ambient" && event.name !== "plurnk.outside") return;
        const value = event.value;
        const attribution = event.subagentRunId ?? "";
        if (event.name === "plurnk.outside") {
            if (!value || typeof value.coordinate !== "string" || !value.coordinate
                || typeof value.text !== "string" || !Number.isSafeInteger(value.tokens) || value.tokens < 0) {
                throw new TypeError("Outside text requires its coordinate, text and token count.");
            }
            const key = JSON.stringify([event.name, attribution, value.coordinate]);
            const row = rows.get(key) ?? $.clone(list, "#worker-outside");
            the(row, {
                activityKind: "outside", activityLabel: ["Outside operations", attribution ? `Subagent ${attribution}` : null].filter(Boolean).join(" · "),
                plurnkCoordinate: value.coordinate, subagentRunId: attribution || null,
                activityText: value.text, plurnkTokens: value.tokens,
            });
            rows.set(key, row);
            return;
        }
        if (!value || !Number.isSafeInteger(value.id) || value.id <= 0
            || !Number.isSafeInteger(value.worker_id) || value.worker_id <= 0
            || !["loop_seq", "turn_seq", "sequence"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
            || (value.op !== null && typeof value.op !== "string") || typeof value.origin !== "string"
            || typeof value.at !== "string" || typeof value.state !== "string" || !Number.isSafeInteger(value.status_rx)
            || (value.source !== null && typeof value.source !== "string")) {
            throw new TypeError("Ambient row identity or display fields are incomplete.");
        }
        const body = referenceOf(value.body);
        const reasoning = referenceOf(typeof value.reasoning === "string" ? undefined : value.reasoning);
        if (value.origin === "_plurnk" && value.op === "READ" && value.attrs?.kind === "emission") return;
        const key = JSON.stringify([event.name, attribution, value.worker_id, value.id]);
        const row = rows.get(key) ?? $.clone(list, "#worker-ambient");
        const operation = value.op ?? (value.attrs?.kind === "emissionAttempt" ? "Rejected emission" : "Log entry");
        const coordinate = `${value.loop_seq}/${value.turn_seq}/${value.sequence}`;
        the(row, {
            activityKind: "ambient", activityOperation: operation,
            activityLabel: [operation, `Worker ${value.worker_id}`, coordinate, value.state, String(value.status_rx),
                attribution ? `Subagent ${attribution}` : null].filter(Boolean).join(" · "),
            plurnkRow: value.id, plurnkWorker: value.worker_id, plurnkOrigin: value.origin,
            plurnkCoordinate: coordinate, plurnkType: value.op, plurnkState: value.state,
            plurnkStatus: value.status_rx, plurnkAt: value.at,
            plurnkSource: value.source, subagentRunId: attribution || null,
        });
        reference(row, "[data-activity-body]", body, "Receipt body");
        reference(row, "[data-activity-reasoning]", reasoning, "Reasoning");
        rows.set(key, row);
    };
}
