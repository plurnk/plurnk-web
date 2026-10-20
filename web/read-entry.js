import managementAction from "./management-action.js";

/** {§web-worker-streams} An isolated management Run reads evidence, never conversation or control.
 * @param {string} target @param {string} threadId
 * @param {"session" | "none"} auth @param {AbortSignal} signal
 */
export default async function readEntry(target, threadId, auth, signal) {
    const result = await managementAction("entry.read", { target }, threadId, auth, signal);
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const outcome = Validator.assertEntryReadResult(result);
    if (outcome.entry === null) throw new Error(outcome.problem.detail, { cause: outcome.problem });
    return outcome.entry;
}
