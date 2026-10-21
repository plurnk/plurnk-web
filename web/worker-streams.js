import { $, the } from "on_the_money";
import entryOutput from "./entry-output.js";

/** {§web-worker-streams} Only supplied conclusions become observed outcomes.
 * @param {HTMLElement} root
 * @param {(target: string) => Promise<import("@plurnk/plurnk-contracts").ClientEntry>} read
 */
export default function workerStreams(root, read) {
    const outcomes = $(root, ":scope > ol");
    if (!outcomes) throw new Error("Worker streams have no outcome outlet.");
    const inspect = entryOutput(root, read);
    const concluded = new Set();
    return {
        /** @param {import("@ag-ui/client").CustomEvent} event */
        async consume(event) {
            if (event.name !== "plurnk.stream") return;
            const value = event.value;
            if (!value || !Object.hasOwn(value, "result")) return;
            if (!Number.isSafeInteger(value.entryId) || value.entryId <= 0
                || !Number.isSafeInteger(value.workerId) || value.workerId <= 0 || typeof value.target !== "string" || !value.target) {
                throw new Error("Stream event has no resource identity.");
            }
            const { Validator } = await import("@plurnk/plurnk-contracts");
            const result = Validator.assertOperationResult(value.result);
            if (typeof value.scheme !== "string" || typeof value.summary !== "string") throw new Error("Stream conclusion is incomplete.");
            const evidence = JSON.stringify(value);
            if (concluded.has(evidence)) return;
            const row = $.clone(outcomes, "#worker-stream-outcome");
            the(row, {
                streamTarget: value.target, streamWorker: value.workerId,
                streamScheme: value.scheme, streamSummary: value.summary, streamStatus: result.status,
                streamExitCode: typeof result.exitCode === "number" ? result.exitCode : null,
                streamProblem: result.problem?.detail ?? "", streamProblemTitle: result.problem?.title ?? "",
            });
            const details = $(row, "details");
            if (!details) throw new Error("Stream outcome has no disclosure.");
            inspect(details);
            concluded.add(evidence);
        },
    };
}
