import WorkerAgent from "./worker-agent.js";
import accessHeaders from "./access-headers.js";

/** {§web-worker-commands} Isolated action delivery never owns observation, conversation or work lifetime.
 * @param {string} kind @param {Record<string, unknown>} params @param {string} threadId
 * @param {"session" | "none"} auth @param {AbortSignal} signal
 * @returns {Promise<unknown>}
 */
export default async function managementAction(kind, params, threadId, auth, signal) {
    const agent = new WorkerAgent({
        url: "/agui", threadId,
        fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) }),
    });
    try {
        agent.headers = await accessHeaders(auth, signal);
        signal.throwIfAborted();
        const { result } = await agent.runAgent({ forwardedProps: { plurnk: { action: { ...params, kind } } } });
        signal.throwIfAborted();
        if (result?.kind !== kind) throw new Error(`${kind} returned no matching action outcome.`);
        if (result.ok === false) {
            const { Validator } = await import("@plurnk/plurnk-contracts");
            const problem = Validator.assertProblemDetails(result.problem);
            throw new Error(problem.detail, { cause: problem });
        }
        if (result.ok !== true || !Object.hasOwn(result, "result")) throw new Error(`${kind} was not acknowledged.`);
        return result.result;
    } finally {
        agent.headers = {};
    }
}
