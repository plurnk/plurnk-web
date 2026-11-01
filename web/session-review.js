import { $, the } from "on_the_money";
import answerForm from "./answer-form.js";

/** @typedef {import("./session-agent.js").SessionGate} SessionGate */
/** @typedef {import("./session-agent.js").GateResolution} GateResolution */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** {§web-session-approval} The daemon cancels a proposal at its deadline; past it by this page's clock, the page answers nothing.
 * @param {SessionGate} gate
 */
const expired = (gate) => gate.expiresAt !== undefined && Date.parse(gate.expiresAt) <= Date.now();

/** @param {SessionGate} gate */
const proposal = (gate) => gate.method === "session/request_permission"
    ? /** @type {import("@plurnk/plurnk-contracts").ProposalProjection | undefined} */ (gate._meta?.plurnk?.proposal)
    : undefined;

/** @param {SessionGate} gate @returns {string} */
const allowOptionId = (gate) => {
    const id = gate.method === "session/request_permission"
        ? gate.options?.find((opt) => typeof opt.kind === "string" && opt.kind.startsWith("allow"))?.optionId
        : undefined;
    return typeof id === "string" && id.length > 0 ? id : "allow_once";
};

/** @param {SessionGate} gate @returns {string} */
const rejectOptionId = (gate) => {
    const id = gate.method === "session/request_permission"
        ? gate.options?.find((opt) => typeof opt.kind === "string" && opt.kind.startsWith("reject"))?.optionId
        : undefined;
    return typeof id === "string" && id.length > 0 ? id : "reject_once";
};

/**
 * @param {string} toolName
 * @param {Extract<SessionGate, { method: "elicitation/create" }>} gate
 * @returns {Record<string, unknown> | undefined}
 */
function elicitationSchema(toolName, gate) {
    if (gate.mode === "url") {
        return {
            oneOf: [{
                type: "object",
                required: ["action"],
                additionalProperties: false,
                properties: {
                    action: { enum: ["accept", "decline", "cancel"] },
                },
            }],
        };
    }
    const requested = isRecord(gate._meta?.plurnk?.interaction?.request)
        && "requestedSchema" in gate._meta.plurnk.interaction.request
        && isRecord(gate._meta.plurnk.interaction.request.requestedSchema)
        ? gate._meta.plurnk.interaction.request.requestedSchema
        : isRecord(gate.requestedSchema)
            ? gate.requestedSchema
            : undefined;
    if (!requested) return undefined;
    if (
        toolName === "mcp_input_required"
        && !Array.isArray(requested.oneOf)
        && !(isRecord(requested.properties) && isRecord(requested.properties.response) && Array.isArray(requested.properties.response.oneOf))
    ) {
        return {
            oneOf: [
                {
                    type: "object",
                    required: ["action", "content"],
                    additionalProperties: false,
                    properties: {
                        action: { const: "accept" },
                        content: requested,
                    },
                },
                {
                    type: "object",
                    required: ["action"],
                    additionalProperties: false,
                    properties: {
                        action: { enum: ["decline", "cancel"] },
                    },
                },
            ],
        };
    }
    return requested;
}

/** {§web-session-approval} {§web-session-questions} Apply the configured client choice to the complete pending gate set.
 * @param {Element} controls @param {boolean} yolo
 */
export default function reviewRequests(controls, yolo) {
    const form = $.clone(controls, "#session-review");
    const outlet = $(form, "[data-requests]");
    if (!(form instanceof HTMLFormElement) || !outlet) throw new Error("Review template is incomplete.");
    const list = outlet;
    /** @type {Array<() => Promise<GateResolution | undefined>>} */
    let responses = [];
    /** @type {readonly SessionGate[]} */
    let current = [];
    let supported = false;
    /** @type {Map<string, Element>} */
    const rows = new Map();
    function mode() {
        const late = supported && current.some(expired);
        const manual = !supported ? 0 : late ? current.length : current.filter((gate) => !yolo || proposal(gate) === undefined).length;
        the(form, { requestCount: manual, deadlinePassed: late ? "" : null });
        return !supported ? "unsupported" : late ? "expired" : manual > 0 ? "manual" : "automatic";
    }
    /** @param {SessionGate} gate @param {number} index @param {Element} [before] */
    function presentProposal(gate, index, before) {
        const facts = proposal(gate);
        if (!facts) throw new Error("Proposal presentation has no facts.");
        const row = before ? $.clone(before, "#session-proposal", { position: "beforebegin" }) : $.clone(list, "#session-proposal");
        rows.set(gate.id, row);
        the(row, {
            interruptId: gate.id, proposalChoice: `decision-${index}`, proposalSession: facts.session,
            proposalOp: facts.op, proposalDeadline: gate.expiresAt ?? "",
            proposalDeadlineLabel: gate.expiresAt === undefined ? "" : new Date(gate.expiresAt).toLocaleString(),
        });
        const target = $(row, "[data-proposal-target]");
        const body = $(row, "[data-proposal-body]");
        if (!target || !body) throw new Error("Proposal template has no content outlets.");
        target.textContent = JSON.stringify(facts.target, null, 2);
        body.textContent = facts.body;
    }
    the(form, { requestCount: 0, reviewUnavailable: "" });
    return {
        form,
        /** {§web-session-commands} Change only proposal controls; question answers remain in their original nodes.
          * @param {boolean} value
          */
        automatic(value) {
            yolo = value;
            if (supported) {
                for (let index = current.length - 1; index >= 0; index--) {
                    const gate = current[index];
                    if (!proposal(gate)) continue;
                    if (yolo) {
                        rows.get(gate.id)?.remove();
                        rows.delete(gate.id);
                    } else if (!rows.has(gate.id)) {
                        const next = current.slice(index + 1).map(({ id }) => rows.get(id)).find(Boolean);
                        presentProposal(gate, index, next);
                    }
                }
            }
            return mode();
        },
        /** @param {readonly SessionGate[]} gates */
        present(gates) {
            current = gates;
            supported = gates.length > 0 && gates.every((gate) => {
                if (gate.method === "session/request_permission") {
                    const facts = proposal(gate);
                    return facts !== undefined && facts.disposition.decision === "review";
                }
                if (gate.method === "elicitation/create") {
                    const interaction = gate._meta?.plurnk?.interaction;
                    const toolName = typeof interaction?.request?.toolName === "string"
                        ? interaction.request.toolName
                        : (typeof gate._meta?.plurnk?.toolName === "string" ? gate._meta.plurnk.toolName : "question");
                    return elicitationSchema(toolName, gate) !== undefined;
                }
                return false;
            });
            list.replaceChildren();
            rows.clear();
            responses = (supported ? gates : []).map((gate, index) => {
                if (gate.method === "elicitation/create") {
                    const interaction = gate._meta?.plurnk?.interaction;
                    const toolName = typeof interaction?.request?.toolName === "string"
                        ? interaction.request.toolName
                        : (typeof gate._meta?.plurnk?.toolName === "string" ? gate._meta.plurnk.toolName : "question");
                    const responseSchema = elicitationSchema(toolName, gate);
                    if (!responseSchema) throw new Error("Elicitation gate has no request schema.");
                    const row = $.clone(list, "#session-question");
                    rows.set(gate.id, row);
                    the(row, {
                        interruptId: gate.id,
                        requestSession: interaction?.sessionId ?? "",
                        requestTool: toolName,
                        responseError: "",
                    });
                    const message = $(row, "[data-request-message]");
                    const args = $(row, "[data-request-arguments]");
                    const schema = $(row, "[data-request-schema]");
                    if (!message || !args || !schema) throw new Error("Question template has no content outlets.");
                    message.textContent = gate.message ?? interaction?.request?.message ?? "Provide the requested input.";
                    const rawArguments = gate._meta?.plurnk?.arguments;
                    args.textContent = typeof rawArguments === "string"
                        ? rawArguments
                        : rawArguments !== undefined
                            ? JSON.stringify(rawArguments)
                            : interaction?.request !== undefined
                                ? JSON.stringify(interaction.request)
                                : JSON.stringify({
                                    ...(gate.mode ? { mode: gate.mode } : {}),
                                    ...(gate.message ? { message: gate.message } : {}),
                                    ...(gate.requestedSchema ? { requestedSchema: gate.requestedSchema } : {}),
                                    ...(gate.url ? { url: gate.url } : {}),
                                    ...(gate.elicitationId ? { elicitationId: gate.elicitationId } : {}),
                                });
                    schema.textContent = JSON.stringify(responseSchema, null, 2);
                    const answer = answerForm(row, responseSchema);
                    return async () => {
                        const result = await answer.read();
                        if (!result) return undefined;
                        if (result.status === "cancelled") {
                            return {
                                id: gate.id,
                                method: /** @type {const} */ ("elicitation/create"),
                                response: { action: /** @type {const} */ ("cancel") },
                            };
                        }
                        const payload = result.payload;
                        if (toolName === "mcp_input_required" || gate.mode === "url") {
                            const inner = isRecord(payload) && isRecord(payload.response) ? payload.response : payload;
                            if (isRecord(inner) && (inner.action === "accept" || inner.action === "decline" || inner.action === "cancel")) {
                                return {
                                    id: gate.id,
                                    method: /** @type {const} */ ("elicitation/create"),
                                    response: inner.action === "accept" && isRecord(inner.content)
                                        ? { action: /** @type {const} */ ("accept"), content: inner.content }
                                        : { action: inner.action },
                                };
                            }
                        }
                        return {
                            id: gate.id,
                            method: /** @type {const} */ ("elicitation/create"),
                            response: {
                                action: /** @type {const} */ ("accept"),
                                content: isRecord(payload) ? payload : { value: payload },
                            },
                        };
                    };
                }
                if (!yolo || gates.some(expired)) presentProposal(gate, index);
                return async () => {
                    if (yolo) return {
                        id: gate.id,
                        method: /** @type {const} */ ("session/request_permission"),
                        response: {
                            outcome: { outcome: /** @type {const} */ ("selected"), optionId: allowOptionId(gate) },
                            _meta: { plurnk: { outcome: /** @type {const} */ ("client_yolo") } },
                        },
                    };
                    const values = new FormData(form);
                    const decision = values.get(`decision-${index}`);
                    if (decision !== "accept" && decision !== "reject") throw new Error("Approval form has no decision.");
                    return {
                        id: gate.id,
                        method: /** @type {const} */ ("session/request_permission"),
                        response: {
                            outcome: {
                                outcome: /** @type {const} */ ("selected"),
                                optionId: decision === "accept" ? allowOptionId(gate) : rejectOptionId(gate),
                            },
                        },
                    };
                };
            });
            return mode();
        },
        /** @param {readonly SessionGate[]} gates @returns {Promise<GateResolution[] | undefined>} */
        async decisions(gates) {
            if (mode() === "expired") return;
            if (!form.reportValidity()) return;
            const results = await Promise.all(responses.map((read) => read()));
            if (results.some((result) => result === undefined)) return;
            const byId = new Map(results.flatMap((res) => res ? [[res.id, res]] : []));
            return gates.map(({ id }) => {
                const entry = byId.get(id);
                if (!entry) throw new Error(`Missing resolution for gate: ${id}`);
                return entry;
            });
        },
    };
}
