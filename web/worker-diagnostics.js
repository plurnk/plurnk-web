import { $, the } from "on_the_money";
import card, { nameCard } from "./card.js";

/** @param {import("@plurnk/plurnk-contracts").Notice} notice */
const noticeFields = (notice) => ({
    diagnosticLevel: notice.level,
    diagnosticTitle: `${notice.source}:${notice.kind}`,
    heading: notice.message || `${notice.source}:${notice.kind}`,
    body: "",
});

/** @param {import("@plurnk/plurnk-contracts").ProblemDetails} problem */
const problemFields = (problem) => ({
    diagnosticLevel: "error",
    diagnosticTitle: problem.title,
    heading: problem.title,
    body: [...new Set([problem.detail, problem.recovery].filter((text) => typeof text === "string" && text && text !== problem.title))].join("\n\n"),
});

/** {§web-worker-diagnostics} Distinct observations belong to the page, never the SDK conversation.
 * @param {HTMLElement} root
 */
export default function diagnostics(root) {
    const list = $(root, "ul");
    if (!(list instanceof HTMLUListElement)) throw new Error("Worker diagnostics have no list.");
    const observed = new Set();
    /** @param {import("@plurnk/plurnk-acp/client").CustomEvent} event */
    return async (event) => {
        if (event.name !== "plurnk.notice" && event.name !== "plurnk.problem") return;
        const { Validator } = await import("@plurnk/plurnk-contracts");
        const fields = event.name === "plurnk.notice" ? noticeFields(Validator.assertNotice(event.value))
            : problemFields(Validator.assertProblemDetails(event.value));
        const attribution = event.subagentRunId ?? "";
        const key = JSON.stringify([event.name, attribution, event.value]);
        if (observed.has(key)) return;
        const { diagnosticTitle } = fields;
        const severity = { info: "Information", warn: "Warning", error: "Error" }[fields.diagnosticLevel];
        const row = $.clone(list, "#worker-diagnostic");
        the(row, {
            diagnosticLevel: fields.diagnosticLevel,
            diagnosticType: event.name,
            diagnosticLabel: [severity, diagnosticTitle, attribution ? `Subagent ${attribution}` : null].filter(Boolean).join(" · "),
            subagentRunId: attribution || null,
        });
        const { header, body } = card(row, Boolean(fields.body));
        $.clone(header, "#operation-header").textContent = fields.heading;
        if (body) $.clone(body, "#conversation-literal").textContent = fields.body;
        nameCard(header);
        observed.add(key);
    };
}
