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

/** {§web-session-activity} Project only received observations; the SDK owns conversation.
 * @param {HTMLElement} root @param {(address: string) => Promise<string>} read
 */
export default function activity(root, read) {
    const list = $(root, ":scope > ul");
    if (!(list instanceof HTMLUListElement)) throw new Error("Session activity has no list.");
    const inspect = bodyReferences(root, read);
    /** @type {Map<string, Element>} */
    const rows = new Map();
    /** @type {Set<string>} */
    const ambientCalls = new Set();
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

    /** @param {import("./session-agent.js").AcpSessionUpdate} update */
    return (update) => {
        const plurnk = /** @type {Record<string, any> | undefined} */ (update._meta?.plurnk);
        if (!plurnk) return;
        const attribution = typeof plurnk.subagentRunId === "string" ? plurnk.subagentRunId : "";
        if (update.sessionUpdate === "agent_message_chunk") {
            if (!Object.hasOwn(plurnk, "outside") && plurnk.op !== "outside-") return;
            const outside = /** @type {Record<string, unknown> | null | undefined} */ (plurnk.outside);
            const text = update.content && typeof update.content === "object" && !Array.isArray(update.content) && update.content.type === "text"
                ? update.content.text
                : undefined;
            if (!outside || typeof outside.coordinate !== "string" || !outside.coordinate
                || typeof text !== "string" || !Number.isSafeInteger(outside.tokens) || Number(outside.tokens) < 0) {
                throw new TypeError("Outside text requires its coordinate, text and token count.");
            }
            const key = JSON.stringify(["outside", attribution, outside.coordinate]);
            const row = rows.get(key) ?? $.clone(list, "#session-outside");
            the(row, {
                activityKind: "outside", activityLabel: ["Outside operations", attribution ? `Subagent ${attribution}` : null].filter(Boolean).join(" · "),
                plurnkCoordinate: outside.coordinate, subagentRunId: attribution || null,
            });
            nameCard(content(row, text, undefined));
            rows.set(key, row);
            return;
        }
        const isNoticeRow = update.sessionUpdate === "notice"
            && !Object.hasOwn(plurnk, "notice")
            && !Object.hasOwn(plurnk, "problem")
            && Object.hasOwn(plurnk, "id");
        if (update.sessionUpdate !== "tool_call_update" && !isNoticeRow) return;
        if (plurnk.proposal !== undefined || plurnk.interaction !== undefined) return;
        if (!isNoticeRow && update.rawInput === undefined && update.rawOutput === undefined && update.name === undefined) return;
        const op = plurnk.op !== undefined ? plurnk.op : (update.name ?? null);
        if (!attribution && typeof plurnk.coordinate === "string" && update.toolCallId === plurnk.coordinate) {
            if (plurnk.origin === "model") ambientCalls.delete(plurnk.coordinate);
            else if (typeof plurnk.origin === "string") ambientCalls.add(plurnk.coordinate);
        }
        const isDischarge = typeof update.toolCallId === "string"
            && typeof plurnk.coordinate === "string"
            && update.toolCallId !== plurnk.coordinate
            && !ambientCalls.has(update.toolCallId);
        if (!attribution && (isDischarge || (plurnk.origin === "model" && op !== null && plurnk.attrs?.kind !== "emissionAttempt"))) return;
        const entryMatch = typeof plurnk.body?.url === "string"
            ? /\/acp\/[1-9]\d*\/([1-9]\d*)\/entry/u.exec(plurnk.body.url)
            : null;
        const sessionId = typeof plurnk.sessionId === "number" ? plurnk.sessionId : (entryMatch ? Number(entryMatch[1]) : 0);
        const id = plurnk.id;
        const loopSeq = plurnk.loopSeq;
        const turnSeq = plurnk.turnSeq;
        const sequence = plurnk.sequence;
        const origin = plurnk.origin;
        const statusRx = plurnk.status;
        const state = typeof plurnk.state === "string"
            ? plurnk.state
            : (update.status === "completed" ? "resolved" : (update.status ?? (statusRx >= 400 ? "failed" : "resolved")));
        if (!Number.isSafeInteger(id) || id <= 0
            || !Number.isSafeInteger(sessionId) || sessionId <= 0
            || ![loopSeq, turnSeq, sequence].every((val) => Number.isSafeInteger(val) && val >= 0)
            || (op !== null && typeof op !== "string") || typeof origin !== "string"
            || typeof state !== "string" || !Number.isSafeInteger(statusRx)
            || (plurnk.source !== undefined && plurnk.source !== null && typeof plurnk.source !== "string")) {
            throw new TypeError("Ambient row identity or display fields are incomplete.");
        }
        if (plurnk.body !== undefined) referenceOf(plurnk.body);
        const reasoning = referenceOf(typeof plurnk.reasoning === "string" ? undefined : plurnk.reasoning);
        if (origin === "_plurnk" && op === "READ" && plurnk.attrs?.kind === "emission") return;
        const key = JSON.stringify(["ambient", attribution, sessionId, id]);
        const row = rows.get(key) ?? $.clone(list, "#session-ambient");
        const operation = op ?? (plurnk.attrs?.kind === "emissionAttempt" ? "Rejected emission" : "Log entry");
        const args = typeof update.rawInput === "string" ? argumentsOf(update.rawInput) : record(update.rawInput);
        const receipt = typeof update.rawOutput === "string"
            ? argumentsOf(update.rawOutput)
            : (record(update.rawOutput) ?? record(plurnk.receipt));
        const coordinate = `${loopSeq}/${turnSeq}/${sequence}`;
        const target = typeof plurnk.target === "string" ? plurnk.target : update.locations?.[0]?.path;
        the(row, {
            activityKind: "ambient",
            activityLabel: [operation, `Session ${sessionId}`, coordinate, state, String(statusRx),
                attribution ? `Subagent ${attribution}` : null].filter(Boolean).join(" · "),
            plurnkRow: id, plurnkSession: sessionId, plurnkOrigin: origin,
            plurnkCoordinate: coordinate, plurnkType: op, plurnkState: state,
            plurnkStatus: statusRx, subagentRunId: attribution || null,
            plurnkNote: op === "NOTE" ? typeof args?.aside === "string" && args.aside ? args.aside : "note" : null,
            plurnkSignal: typeof plurnk.signal === "number" ? plurnk.signal : null,
        });
        const header = content(row, bodyOf(args, op), reasoning);
        operationSummary(header, operation, args, receipt, { op, status: statusRx, address: target }, "");
        nameCard(header);
        rows.set(key, row);
    };
}
