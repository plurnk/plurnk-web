import { $, the } from "on_the_money";
import bodyReferences from "./body-references.js";
import card, { nameCard } from "./card.js";
import operationSummary, { argumentsOf, bodyOf, record } from "./operation-summary.js";

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
    const list = $(root, ":scope > ul");
    if (!(list instanceof HTMLUListElement)) throw new Error("Worker activity has no list.");
    const inspect = bodyReferences(root, read);
    /** @type {Map<string, Element>} */
    const rows = new Map();
    /** @type {WeakMap<Element, string>} */
    const references = new WeakMap();

    /** @param {Element} row @param {string} body @param {Reference | undefined} reasoning */
    function content(row, body, reasoning) {
        const { header, body: outlet } = card(row, Boolean(body || reasoning));
        if (!outlet) { inspect.prune(); return header; }
        const revision = JSON.stringify([body, reasoning]);
        if (references.get(outlet) === revision) return header;
        for (const node of Array.from(outlet.childNodes)) if (node !== header) node.remove();
        if (body) $.clone(outlet, "#conversation-literal").textContent = body;
        if (reasoning) inspect.append($.clone(outlet, "#activity-reasoning"), { value: reasoning.url, mimeType: reasoning.mimeType });
        references.set(outlet, revision);
        inspect.prune();
        return header;
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
            });
            nameCard(content(row, value.text, undefined));
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
        const reasoning = referenceOf(typeof value.reasoning === "string" ? undefined : value.reasoning);
        if (value.origin === "_plurnk" && value.op === "READ" && value.attrs?.kind === "emission") return;
        const key = JSON.stringify([event.name, attribution, value.worker_id, value.id]);
        const row = rows.get(key) ?? $.clone(list, "#worker-ambient");
        const operation = value.op ?? (value.attrs?.kind === "emissionAttempt" ? "Rejected emission" : "Log entry");
        const args = typeof value.tx === "string" ? argumentsOf(value.tx) : record(value.tx);
        const receipt = typeof value.rx === "string" ? argumentsOf(value.rx) : record(value.rx);
        const coordinate = `${value.loop_seq}/${value.turn_seq}/${value.sequence}`;
        the(row, {
            activityKind: "ambient",
            activityLabel: [operation, `Worker ${value.worker_id}`, coordinate, value.state, String(value.status_rx),
                attribution ? `Subagent ${attribution}` : null].filter(Boolean).join(" · "),
            plurnkRow: value.id, plurnkWorker: value.worker_id, plurnkOrigin: value.origin,
            plurnkCoordinate: coordinate, plurnkType: value.op, plurnkState: value.state,
            plurnkStatus: value.status_rx, subagentRunId: attribution || null,
            plurnkNote: value.op === "NOTE" ? typeof args?.aside === "string" && args.aside ? args.aside : "note" : null,
            plurnkSignal: typeof value.signal === "number" ? value.signal : null,
        });
        const header = content(row, bodyOf(args, value.op), reasoning);
        operationSummary(header, operation, args, receipt, { op: value.op, status: value.status_rx, address: value.target }, "");
        nameCard(header);
        rows.set(key, row);
    };
}
