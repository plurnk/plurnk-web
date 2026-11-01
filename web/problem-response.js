/** {§web-session-observer} A refusal the daemon explains is its Problem: the Error carries it as its cause, and its status.
 * @param {Response} response
 * @returns {Promise<(Error & { status: number }) | null>}
 */
export default async function refusal(response) {
    if (response.ok || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/problem+json") return null;
    const { Validator } = await import("@plurnk/plurnk-contracts");
    const problem = Validator.assertProblemDetails(await response.json());
    return Object.assign(new Error(problem.detail ?? problem.title, { cause: problem }), { status: problem.status });
}
