import { $, the } from "on_the_money";
import { Validator } from "@plurnk/plurnk-contracts";
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

/** {§web-session-diagnostics} Distinct observations belong to the page, never the SDK conversation.
 * @param {HTMLElement} root
 */
export default function diagnostics(root) {
    const list = $(root, "ul");
    if (!(list instanceof HTMLUListElement)) throw new Error("Session diagnostics have no list.");
    const observed = new Set();
    /** @param {import("./session-agent.js").AcpSessionUpdate} update */
    return async (update) => {
        if (update.sessionUpdate !== "notice") return;
        const plurnk = /** @type {Record<string, unknown> | undefined} */ (update._meta?.plurnk);
        if (!plurnk) return;
        const isNotice = Object.hasOwn(plurnk, "notice");
        const isProblem = !isNotice && Object.hasOwn(plurnk, "problem");
        if (!isNotice && !isProblem) return;
        if (isNotice && typeof plurnk.notice === "object" && plurnk.notice !== null
            && ((Reflect.get(plurnk.notice, "source") === "engine:lifecycle"
                && Reflect.get(plurnk.notice, "kind") === "loop_status"
                && !Object.hasOwn(plurnk.notice, "position"))
                || (Reflect.get(plurnk.notice, "source") === "engine:derivation"
                    && Reflect.get(plurnk.notice, "kind") === "search_progress"
                    && Reflect.get(plurnk.notice, "phase") !== "failed"))) return;
        const value = isNotice ? plurnk.notice : plurnk.problem;
        const fields = isNotice ? noticeFields(Validator.assertNotice(value))
            : problemFields(Validator.assertProblemDetails(value));
        const attribution = typeof plurnk.subagentRunId === "string" ? plurnk.subagentRunId : "";
        const diagnosticType = isNotice ? "notice" : "problem";
        const key = JSON.stringify([diagnosticType, attribution, value]);
        if (observed.has(key)) return;
        const { diagnosticTitle } = fields;
        const severity = { info: "Information", warn: "Warning", error: "Error" }[fields.diagnosticLevel];
        const row = $.clone(list, "#session-diagnostic");
        the(row, {
            diagnosticLevel: fields.diagnosticLevel,
            diagnosticType,
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
