/** {§web-worker-commands} A failed daemon action's diagnostic, with the recovery and status of the Problem that caused it.
 * @param {unknown} error
 * @returns {Promise<{ message: string, recovery: string, status: number | null }>}
 */
export default async function describeFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause === null || typeof cause !== "object" || cause instanceof Error) return { message, recovery: "", status: null };
    const { Validator } = await import("@plurnk/plurnk-contracts");
    if (!Validator.validateProblemDetails(cause).valid) return { message, recovery: "", status: null };
    const problem = Validator.assertProblemDetails(cause);
    return { message, recovery: typeof problem.recovery === "string" ? problem.recovery : "", status: problem.status };
}
