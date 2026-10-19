import { $, the } from "on_the_money";
import { buildResumeArray } from "./worker-agent.js";
import answerForm from "./answer-form.js";

/** @typedef {import("@ag-ui/client").HttpAgent["pendingInterrupts"]} Interrupts */
/** @param {Interrupts[number]} interrupt */
const proposal = (interrupt) => /** @type {import("@plurnk/plurnk-contracts").ProposalProjection | undefined} */ (interrupt.metadata?.plurnk?.proposal);

/** {§web-worker-approval} {§web-worker-questions} The form projects SDK interrupts, not policy.
 * @param {Element} controls
 */
export default function reviewRequests(controls) {
    const form = $.clone(controls, "#worker-review", { position: "afterbegin" });
    const list = $(form, "[data-requests]");
    if (!(form instanceof HTMLFormElement) || !list) throw new Error("Review template is incomplete.");
    /** @type {Array<() => Promise<NonNullable<import("@ag-ui/client").RunAgentParameters["resume"]>[number] | undefined>>} */
    let responses = [];
    the(form, { requestCount: 0, reviewUnavailable: "" });
    return {
        form,
        /** @param {Interrupts} interrupts @param {import("@ag-ui/client").HttpAgent["messages"]} [messages] */
        present(interrupts, messages = []) {
            const calls = messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : []);
            const supported = interrupts.length > 0 && interrupts.every((interrupt) => {
                const facts = proposal(interrupt);
                return facts !== undefined ? facts.disposition.decision === "review"
                    : interrupt.reason === "tool_call" && interrupt.responseSchema !== undefined
                        && calls.some(({ id }) => id === interrupt.toolCallId);
            });
            the(form, "request-count", supported ? interrupts.length : 0);
            list.replaceChildren();
            responses = (supported ? interrupts : []).map((interrupt, index) => {
                const facts = proposal(interrupt);
                if (facts === undefined) {
                    const call = calls.find(({ id }) => id === interrupt.toolCallId);
                    if (!call || !interrupt.responseSchema) throw new Error("Question interrupt has no request contract.");
                    const interaction = /** @type {import("@plurnk/plurnk-contracts").ClientInteractionProjection | undefined} */ (interrupt.metadata?.plurnk?.interaction);
                    const row = $.clone(list, "#worker-question");
                    the(row, {
                        interruptId: interrupt.id,
                        requestWorker: interaction?.workerId ?? "",
                        requestTool: call.function.name,
                        requestMessage: interrupt.message ?? "Provide the requested input.",
                        requestArguments: call.function.arguments,
                        requestSchema: JSON.stringify(interrupt.responseSchema, null, 2),
                        responseError: "",
                    });
                    const answer = answerForm(row, interrupt.responseSchema);
                    return async () => {
                        const result = await answer.read();
                        return result && { interruptId: interrupt.id, ...result };
                    };
                }
                const row = $.clone(list, "#worker-proposal");
                the(row, {
                    interruptId: interrupt.id,
                    proposalChoice: `decision-${index}`,
                    proposalWorker: facts.worker,
                    proposalOp: facts.op,
                    proposalTarget: JSON.stringify(facts.target, null, 2),
                    proposalBody: facts.body,
                    proposalDetails: JSON.stringify(facts, null, 2),
                });
                return async () => {
                    const values = new FormData(form);
                    const decision = values.get(`decision-${index}`);
                    if (decision !== "accept" && decision !== "reject") throw new Error("Approval form has no decision.");
                    return { interruptId: interrupt.id, status: /** @type {const} */ ("resolved"), payload: { decision } };
                };
            });
            return supported;
        },
        /** @param {Interrupts} interrupts */
        async decisions(interrupts) {
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
