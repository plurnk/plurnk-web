import { $, the } from "on_the_money";
import { buildResumeArray } from "./worker-agent.js";
import answerForm from "./answer-form.js";

/** @typedef {import("@plurnk/plurnk-acp/client").HttpAgent["pendingInterrupts"]} Interrupts */
/** {§web-worker-approval} The daemon cancels a proposal at its deadline; past it by this page's clock, the page answers nothing.
 * @param {Interrupts[number]} interrupt
 */
const expired = (interrupt) => interrupt.expiresAt !== undefined && Date.parse(interrupt.expiresAt) <= Date.now();
/** @param {Interrupts[number]} interrupt */
const proposal = (interrupt) => /** @type {import("@plurnk/plurnk-contracts").ProposalProjection | undefined} */ (interrupt.metadata?.plurnk?.proposal);

/** {§web-worker-approval} {§web-worker-questions} Apply the configured client choice to the SDK's complete set.
 * @param {Element} controls @param {boolean} yolo
 */
export default function reviewRequests(controls, yolo) {
    const form = $.clone(controls, "#worker-review");
    const outlet = $(form, "[data-requests]");
    if (!(form instanceof HTMLFormElement) || !outlet) throw new Error("Review template is incomplete.");
    const list = outlet;
    /** @type {Array<() => Promise<NonNullable<import("@plurnk/plurnk-acp/client").RunAgentParameters["resume"]>[number] | undefined>>} */
    let responses = [];
    /** @type {Interrupts} */
    let current = [];
    let supported = false;
    /** @type {Map<string, Element>} */
    const rows = new Map();
    function mode() {
        const late = supported && current.some(expired);
        const manual = !supported ? 0 : late ? current.length : current.filter((interrupt) => !yolo || proposal(interrupt) === undefined).length;
        the(form, { requestCount: manual, deadlinePassed: late ? "" : null });
        return !supported ? "unsupported" : late ? "expired" : manual > 0 ? "manual" : "automatic";
    }
    /** @param {Interrupts[number]} interrupt @param {number} index @param {Element} [before] */
    function presentProposal(interrupt, index, before) {
        const facts = proposal(interrupt);
        if (!facts) throw new Error("Proposal presentation has no facts.");
        const row = before ? $.clone(before, "#worker-proposal", { position: "beforebegin" }) : $.clone(list, "#worker-proposal");
        rows.set(interrupt.id, row);
        the(row, {
            interruptId: interrupt.id, proposalChoice: `decision-${index}`, proposalWorker: facts.worker,
            proposalOp: facts.op, proposalDeadline: interrupt.expiresAt ?? "",
            proposalDeadlineLabel: interrupt.expiresAt === undefined ? "" : new Date(interrupt.expiresAt).toLocaleString(),
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
        /** {§web-worker-commands} Change only proposal controls; question answers remain in their original nodes.
         * @param {boolean} value
         */
        automatic(value) {
            yolo = value;
            if (supported) {
                for (let index = current.length - 1; index >= 0; index--) {
                    const interrupt = current[index];
                    if (!proposal(interrupt)) continue;
                    if (yolo) {
                        rows.get(interrupt.id)?.remove();
                        rows.delete(interrupt.id);
                    } else if (!rows.has(interrupt.id)) {
                        const next = current.slice(index + 1).map(({ id }) => rows.get(id)).find(Boolean);
                        presentProposal(interrupt, index, next);
                    }
                }
            }
            return mode();
        },
        /** @param {Interrupts} interrupts @param {import("@plurnk/plurnk-acp/client").HttpAgent["messages"]} [messages] */
        present(interrupts, messages = []) {
            current = interrupts;
            const calls = messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : []);
            supported = interrupts.length > 0 && interrupts.every((interrupt) => {
                const facts = proposal(interrupt);
                return facts !== undefined ? facts.disposition.decision === "review"
                    : interrupt.reason === "tool_call" && interrupt.responseSchema !== undefined
                        && calls.some(({ id }) => id === interrupt.toolCallId);
            });
            list.replaceChildren();
            rows.clear();
            responses = (supported ? interrupts : []).map((interrupt, index) => {
                const facts = proposal(interrupt);
                if (facts === undefined) {
                    const call = calls.find(({ id }) => id === interrupt.toolCallId);
                    if (!call || !interrupt.responseSchema) throw new Error("Question interrupt has no request contract.");
                    const interaction = /** @type {import("@plurnk/plurnk-contracts").ClientInteractionProjection | undefined} */ (interrupt.metadata?.plurnk?.interaction);
                    const row = $.clone(list, "#worker-question");
                    rows.set(interrupt.id, row);
                    the(row, {
                        interruptId: interrupt.id,
                        requestWorker: interaction?.workerId ?? "",
                        requestTool: call.function.name,
                        responseError: "",
                    });
                    const message = $(row, "[data-request-message]");
                    const args = $(row, "[data-request-arguments]");
                    const schema = $(row, "[data-request-schema]");
                    if (!message || !args || !schema) throw new Error("Question template has no content outlets.");
                    message.textContent = interrupt.message ?? "Provide the requested input.";
                    args.textContent = call.function.arguments;
                    schema.textContent = JSON.stringify(interrupt.responseSchema, null, 2);
                    const answer = answerForm(row, interrupt.responseSchema);
                    return async () => {
                        const result = await answer.read();
                        return result && { interruptId: interrupt.id, ...result };
                    };
                }
                if (!yolo || interrupts.some(expired)) presentProposal(interrupt, index);
                return async () => {
                    if (yolo) return {
                        interruptId: interrupt.id, status: /** @type {const} */ ("resolved"), payload: { decision: "accept", outcome: "client_yolo" },
                    };
                    const values = new FormData(form);
                    const decision = values.get(`decision-${index}`);
                    if (decision !== "accept" && decision !== "reject") throw new Error("Approval form has no decision.");
                    return { interruptId: interrupt.id, status: /** @type {const} */ ("resolved"), payload: { decision } };
                };
            });
            return mode();
        },
        /** @param {Interrupts} interrupts */
        async decisions(interrupts) {
            if (mode() === "expired") return;
            if (!form.reportValidity()) return;
            const results = await Promise.all(responses.map((read) => read()));
            if (results.some((result) => result === undefined)) return;
            return buildResumeArray(interrupts, Object.fromEntries(results.map((result) => {
                if (!result) throw new Error("Review response is missing.");
                const { interruptId, ...resolution } = result;
                return [interruptId, resolution];
            })));
        },
    };
}
