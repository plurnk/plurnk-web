import { $, the } from "on_the_money";

/** @param {import("@plurnk/plurnk-contracts").Notice} notice */
const noticeFields = (notice) => ({
    diagnosticLevel: notice.level,
    diagnosticTitle: `${notice.source}:${notice.kind}`,
    diagnosticMessage: notice.message ?? "",
    diagnosticRecovery: "",
});

/** @param {import("@plurnk/plurnk-contracts").ProblemDetails} problem */
const problemFields = (problem) => ({
    diagnosticLevel: "error",
    diagnosticTitle: problem.title,
    diagnosticMessage: problem.detail,
    diagnosticRecovery: typeof problem.recovery === "string" ? problem.recovery : "",
});

/** {§web-worker-diagnostics} Distinct observations belong to the page, never the SDK conversation.
 * @param {HTMLElement} root
 */
export default function diagnostics(root) {
    const list = $(root, "ul");
    if (!(list instanceof HTMLUListElement)) throw new Error("Worker diagnostics have no list.");
    const observed = new Set();
    /** @param {import("@ag-ui/client").CustomEvent} event */
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
        const article = $(row, "article");
        const message = $(row, "[data-diagnostic-message]");
        if (!article || !message) throw new Error("Diagnostic template has no content outlet.");
        message.textContent = fields.diagnosticMessage || diagnosticTitle;
        if (fields.diagnosticRecovery) $.clone(article, "#diagnostic-recovery").textContent = fields.diagnosticRecovery;
        observed.add(key);
    };
}
