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

/** @param {{ scheme: string | null, authority: string | null, pathname: string | null }} target @returns {string} */
function formatTargetUri(target) {
    const { scheme, authority, pathname } = target;
    if ((scheme === null || scheme === "file") && authority === null && typeof pathname === "string" && pathname.length > 0) {
        return pathname;
    }
    if (typeof scheme === "string" && scheme.length > 0) {
        if (typeof authority === "string" && authority.length > 0) {
            return `${scheme}://${authority}${pathname ?? ""}`;
        }
        if (typeof pathname === "string" && pathname.length > 0) {
            return `${scheme}://${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
        }
        return `${scheme}:`;
    }
    return typeof pathname === "string" ? pathname : "";
}

/** @param {import("@plurnk/plurnk-contracts").ProposalProjection} facts @returns {string} */
function formatProposalTarget(facts) {
    const subject = facts.subject;
    if (subject?.type === "command") {
        const explicitTarget = facts.target.scheme !== null && facts.target.scheme !== "sh"
            ? formatTargetUri(facts.target)
            : "";
        return explicitTarget ? `${explicitTarget} (${subject.cwd})` : subject.cwd;
    }
    if (subject?.type === "tool_call") {
        if (typeof subject.diff?.path === "string" && subject.diff.path.length > 0) {
            return subject.diff.path;
        }
        if (Array.isArray(subject.locations) && subject.locations.length > 0) {
            return subject.locations.map(({ path }) => path).join(", ");
        }
    }
    return formatTargetUri(facts.target);
}

/** @param {string} line @returns {"meta" | "hunk" | "add" | "del" | "context"} */
function classifyDiffLine(line) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff --git ") || line.startsWith("index ")) {
        return "meta";
    }
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "context";
}

/** @param {Element} codeOutlet @param {string} patch */
function presentUnifiedDiff(codeOutlet, patch) {
    codeOutlet.replaceChildren();
    const lines = patch.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const kind = classifyDiffLine(line);
        const node = kind === "add"
            ? $.clone(codeOutlet, "#proposal-diff-add")
            : kind === "del"
                ? $.clone(codeOutlet, "#proposal-diff-del")
                : $.clone(codeOutlet, "#proposal-diff-line");
        if (kind !== "add" && kind !== "del") {
            the(node, "diff-line", kind);
        }
        node.textContent = line;
        if (i < lines.length - 1) {
            codeOutlet.append("\n");
        }
    }
}

/** @param {SessionGate} gate @returns {string} */
export const allowOptionId = (gate) => {
    const id = gate.method === "session/request_permission"
        ? gate.options?.find((opt) => typeof opt.kind === "string" && opt.kind.startsWith("allow"))?.optionId
        : undefined;
    return typeof id === "string" && id.length > 0 ? id : "allow_once";
};

/** @param {SessionGate} gate @returns {string} */
export const rejectOptionId = (gate) => {
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

/** {§web-session-approval} {§web-session-questions} Present and submit decisions for the complete pending gate set.
 * @param {Element} controls
 */
export default function reviewRequests(controls) {
    const form = $.clone(controls, "#session-review");
    const outlet = $(form, "[data-requests]");
    if (!(form instanceof HTMLFormElement) || !outlet) throw new Error("Review template is incomplete.");
    const list = outlet;
    /** @type {Array<() => Promise<GateResolution | undefined>>} */
    let responses = [];
    /** @type {readonly SessionGate[]} */
    let current = [];
    let supported = false;
    function mode() {
        const late = supported && current.some(expired);
        const manual = !supported ? 0 : current.length;
        the(form, { "request-count": manual, "deadline-passed": late ? "" : null });
        return !supported ? "unsupported" : late ? "expired" : "manual";
    }
    /** @param {SessionGate} gate @param {number} index @param {Element} [before] */
    function presentProposal(gate, index, before) {
        const facts = proposal(gate);
        if (!facts) throw new Error("Proposal presentation has no facts.");
        const row = before ? $.clone(before, "#session-proposal", { position: "beforebegin" }) : $.clone(list, "#session-proposal");
        const targetText = formatProposalTarget(facts);
        const patchText = facts.subject?.type === "tool_call" && typeof facts.subject.diff?.patch === "string" && facts.subject.diff.patch.length > 0
            ? facts.subject.diff.patch
            : "";
        const editable = typeof facts.body === "string";
        the(row, {
            "interrupt-id": gate.id, "proposal-choice": `decision-${index}`, "proposal-edit-name": `body-${index}`, "proposal-session": facts.session,
            "proposal-op": facts.op, "proposal-deadline": gate.expiresAt ?? "",
            "proposal-deadline-label": gate.expiresAt === undefined ? "" : new Date(gate.expiresAt).toLocaleString(),
            "proposal-target-empty": targetText ? "false" : "true",
            "proposal-has-diff": patchText ? "true" : "false",
            "proposal-body-empty": facts.body ? "false" : "true",
            "proposal-editable": editable ? "true" : "false",
        });
        const target = $(row, "[data-proposal-target]");
        const diff = $(row, "[data-proposal-diff] > code");
        const body = $(row, "[data-proposal-body]");
        const editField = $(row, "[data-proposal-edit-body]");
        if (!target || !diff || !body || !(editField instanceof HTMLTextAreaElement)) {
            throw new Error("Proposal template has no content outlets.");
        }
        target.textContent = targetText;
        if (patchText) {
            presentUnifiedDiff(diff, patchText);
        }
        body.textContent = facts.body;
        editField.value = facts.body;
    }
    the(form, { "request-count": 0, "review-unavailable": "" });
    return {
        form,
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
            responses = (supported ? gates : []).map((gate, index) => {
                if (gate.method === "elicitation/create") {
                    const interaction = gate._meta?.plurnk?.interaction;
                    const toolName = typeof interaction?.request?.toolName === "string"
                        ? interaction.request.toolName
                        : (typeof gate._meta?.plurnk?.toolName === "string" ? gate._meta.plurnk.toolName : "question");
                    const responseSchema = elicitationSchema(toolName, gate);
                    if (!responseSchema) throw new Error("Elicitation gate has no request schema.");
                    const row = $.clone(list, "#session-question");
                    the(row, {
                        "interrupt-id": gate.id,
                        "request-session": interaction?.sessionId ?? "",
                        "request-tool": toolName,
                        "response-error": "",
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
                const facts = proposal(gate);
                presentProposal(gate, index);
                return async () => {
                    const values = new FormData(form);
                    const decision = values.get(`decision-${index}`);
                    if (decision !== "accept" && decision !== "edit" && decision !== "reject") {
                        throw new Error("Approval form has no decision.");
                    }
                    if (decision === "edit") {
                        const rawEdited = values.get(`body-${index}`);
                        const editedBody = typeof rawEdited === "string" ? rawEdited : (facts?.body ?? "");
                        return {
                            id: gate.id,
                            method: /** @type {const} */ ("session/request_permission"),
                            response: {
                                outcome: {
                                    outcome: /** @type {const} */ ("selected"),
                                    optionId: allowOptionId(gate),
                                },
                                _meta: { plurnk: { body: editedBody } },
                            },
                        };
                    }
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
