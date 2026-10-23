import WorkerAgent from "./worker-agent.js";
import accessHeaders from "./access-headers.js";

/** {§web-worker-commands} Isolated action delivery never owns observation, conversation or work lifetime. A refusal, before the
 * stream opens or as its `RUN_ERROR`, is the daemon's Problem: the thrown Error carries it as its cause.
 * @param {string} kind @param {Record<string, unknown>} params @param {string} threadId
 * @param {"session" | "none"} auth @param {AbortSignal} signal
 * @returns {Promise<unknown>}
 */
export default async function managementAction(kind, params, threadId, auth, signal) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    /** @param {unknown} value */
    const refused = (value) => {
        const problem = Validator.assertProblemDetails(value);
        return Object.assign(new Error(problem.detail ?? problem.title, { cause: problem }), { status: problem.status });
    };
    const agent = new WorkerAgent({
        url: "/agui", threadId,
        fetch: async (url, init) => {
            const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
            if (!response.ok && response.headers.get("content-type")?.split(";")[0]?.trim() === "application/problem+json") {
                throw refused(await response.json());
            }
            return response;
        },
    });
    /** @type {Error | undefined} */
    let failed;
    try {
        agent.headers = await accessHeaders(auth, signal);
        signal.throwIfAborted();
        let outcome;
        try {
            outcome = await agent.runAgent({ forwardedProps: { plurnk: { action: { ...params, kind } } } }, {
                onRunErrorEvent: ({ event }) => {
                    const problem = /** @type {{ plurnk?: { problem?: unknown } } | undefined} */ (event.metadata)?.plurnk?.problem;
                    failed = problem === undefined ? new Error(event.message) : refused(problem);
                },
            });
        } catch (error) {
            throw failed ?? error;
        }
        signal.throwIfAborted();
        if (failed !== undefined) throw failed;
        const { result } = outcome;
        if (result?.kind !== kind) throw new Error(`${kind} returned no matching action outcome.`);
        if (result.ok === false) {
            const problem = Validator.assertProblemDetails(result.problem);
            throw new Error(problem.detail, { cause: problem });
        }
        if (result.ok !== true || !Object.hasOwn(result, "result")) throw new Error(`${kind} was not acknowledged.`);
        return result.result;
    } finally {
        agent.headers = {};
    }
}
