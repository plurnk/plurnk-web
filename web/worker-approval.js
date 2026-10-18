import { $, the } from "on_the_money";
import { buildResumeArray } from "./worker-agent.js";

/** @typedef {import("@ag-ui/client").HttpAgent["pendingInterrupts"]} Interrupts */
/** @param {Interrupts[number]} interrupt */
const proposal = (interrupt) => /** @type {import("@plurnk/plurnk-contracts").ProposalProjection | undefined} */ (interrupt.metadata?.plurnk?.proposal);

/** {§web-worker-approval} The form projects SDK interrupts; it owns no gate registry or policy.
 * @param {Element} controls
 */
export default function approvals(controls) {
    const form = $.clone(controls, "#worker-approval", { position: "afterbegin" });
    const list = $(form, "[data-proposals]");
    if (!(form instanceof HTMLFormElement) || !list) throw new Error("Approval template is incomplete.");
    the(form, { proposalCount: 0, reviewUnavailable: "" });
    return {
        form,
        /** @param {Interrupts} interrupts */
        present(interrupts) {
            const supported = interrupts.length > 0 && interrupts.every((interrupt) => proposal(interrupt)?.disposition.decision === "review");
            the(form, "proposal-count", supported ? interrupts.length : 0);
            $.cloneEach(list, "#worker-proposal", supported ? interrupts : [], (row, interrupt, index) => {
                const facts = proposal(interrupt);
                if (!facts) throw new Error("Approval interrupt has no proposal.");
                the(row, {
                    interruptId: interrupt.id,
                    proposalChoice: `decision-${index}`,
                    proposalWorker: facts.worker,
                    proposalOp: facts.op,
                    proposalTarget: JSON.stringify(facts.target, null, 2),
                    proposalBody: facts.body,
                    proposalDetails: JSON.stringify(facts, null, 2),
                });
            });
            return supported;
        },
        /** @param {Interrupts} interrupts */
        decisions(interrupts) {
            if (!form.reportValidity()) return;
            const values = new FormData(form);
            return buildResumeArray(interrupts, Object.fromEntries(interrupts.map((interrupt, index) => {
                const decision = values.get(`decision-${index}`);
                if (decision !== "accept" && decision !== "reject") throw new Error("Approval form has no decision.");
                return [interrupt.id, { status: "resolved", payload: { decision } }];
            })));
        },
    };
}
