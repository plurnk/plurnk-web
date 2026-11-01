import { $, the } from "on_the_money";
import entryOutput from "./entry-output.js";

/** {§web-session-streams} Only supplied conclusions become observed outcomes.
 * @param {HTMLElement} root
 * @param {(target: string) => Promise<import("@plurnk/plurnk-contracts").ClientEntry>} read
 */
export default function sessionStreams(root, read) {
    const outcomes = $(root, ":scope > ul");
    if (!outcomes) throw new Error("Session streams have no outcome outlet.");
    const inspect = entryOutput(root, read);
    const concluded = new Set();
    return {
        /** @param {import("./session-agent.js").AcpSessionUpdate} update */
        async consume(update) {
            if (update.sessionUpdate !== "terminal_update") return;
            const plurnk = /** @type {Record<string, unknown> | undefined} */ (update._meta?.plurnk);
            if (!plurnk || !Object.hasOwn(plurnk, "result") || (plurnk.loop_seq === 1 && plurnk.turn_seq === 1)) return;
            const terminalMatch = typeof update.terminalId === "string" ? /^term:([1-9]\d*)$/u.exec(update.terminalId) : null;
            const entryId = typeof plurnk.entryId === "number" ? plurnk.entryId : (terminalMatch ? Number(terminalMatch[1]) : 0);
            const sessionId = typeof plurnk.sessionId === "number" ? plurnk.sessionId : 0;
            const target = typeof plurnk.target === "string" ? plurnk.target : "";
            if (!Number.isSafeInteger(entryId) || entryId <= 0
                || !Number.isSafeInteger(sessionId) || sessionId <= 0 || !target) {
                throw new Error("Stream event has no resource identity.");
            }
            const { Validator } = await import("@plurnk/plurnk-contracts");
            const result = Validator.assertOperationResult(plurnk.result);
            const scheme = typeof plurnk.scheme === "string"
                ? plurnk.scheme
                : (/^([a-z][a-z0-9+.-]*):\/\//iu.exec(target)?.[1] ?? "");
            const summary = typeof plurnk.summary === "string"
                ? plurnk.summary
                : (typeof result.exitCode === "number" ? `Exited ${result.exitCode}` : `Status ${result.status}`);
            if (!scheme || !summary) throw new Error("Stream conclusion is incomplete.");
            const evidence = JSON.stringify({ entryId, sessionId, target, scheme, summary, result });
            if (concluded.has(evidence)) return;
            const row = $.clone(outcomes, "#session-stream-outcome");
            the(row, {
                streamTarget: target, streamSession: sessionId,
                streamScheme: scheme, streamSummary: summary, streamStatus: result.status,
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
