import WorkerAgent from "./worker-agent.js";
import accessHeaders from "./access-headers.js";

/** {§web-worker-streams} An isolated management Run reads evidence, never conversation or control.
 * @param {string} target @param {string} threadId
 * @param {"session" | "none"} auth @param {AbortSignal} signal
 */
export default async function readEntry(target, threadId, auth, signal) {
    const agent = new WorkerAgent({
        url: "/agui", threadId,
        fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) }),
    });
    try {
        agent.headers = await accessHeaders(auth, signal);
        signal.throwIfAborted();
        const { result } = await agent.runAgent({ forwardedProps: { plurnk: { action: { kind: "entry.read", target } } } });
        signal.throwIfAborted();
        const { Validator } = await import("@plurnk/plurnk-contracts");
        if (result?.ok === false) {
            const problem = Validator.assertProblemDetails(result.problem);
            throw new Error(problem.detail, { cause: problem });
        }
        if (result?.ok !== true) throw new Error("Entry read was not acknowledged.");
        const outcome = Validator.assertEntryReadResult(result.result);
        if (outcome.entry === null) throw new Error(outcome.problem.detail, { cause: outcome.problem });
        return outcome.entry;
    } finally {
        agent.headers = {};
    }
}
