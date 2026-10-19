import { $, $$, the } from "on_the_money";

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
    const list = $(root, "ol");
    if (!(list instanceof HTMLOListElement)) throw new Error("Worker diagnostics have no list.");
    /** @param {import("@ag-ui/client").CustomEvent} event */
    return async (event) => {
        if (event.name !== "plurnk.notice" && event.name !== "plurnk.problem") return;
        const { Validator } = await import("@plurnk/plurnk-contracts");
        const fields = event.name === "plurnk.notice" ? noticeFields(Validator.assertNotice(event.value))
            : problemFields(Validator.assertProblemDetails(event.value));
        const details = JSON.stringify(event.value, null, 2);
        const attribution = event.subagentRunId ?? "";
        if ($$(list, ":scope > li").some((row) => the(row, "diagnostic-type") === event.name
            && the(row, "diagnostic-attribution") === attribution && the(row, "diagnostic-details") === details)) return;
        const level = fields.diagnosticLevel;
        the($.clone(list, "#worker-diagnostic"), {
            ...fields,
            diagnosticType: event.name,
            diagnosticIcon: level === "info" ? "📌" : level === "warn" ? "⚠️" : "❌",
            diagnosticAttribution: attribution,
            diagnosticDetails: details,
        });
    };
}
