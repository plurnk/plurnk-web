/** {§web-access-token} A browser request acquires its own bearer; none enters document state.
 * @param {"session" | "none"} auth @param {AbortSignal} signal
 * @returns {Promise<Record<string, string>>}
 */
export default async function accessHeaders(auth, signal) {
    if (auth === "none") return {};
    const response = await fetch("/auth/token", { method: "POST", signal });
    if (!response.ok) throw Object.assign(new Error(`Access credential request failed (${response.status}).`), { status: response.status });
    let token;
    try {
        token = await response.json();
    } catch (cause) {
        // A JSON parser's message may contain credential bytes; preserve it only as the cause.
        throw Object.assign(new Error("Access credential response is not valid JSON.", { cause }), { protocolFailure: true });
    }
    if (!token || token.token_type !== "Bearer" || typeof token.access_token !== "string" || !token.access_token) {
        throw Object.assign(new Error("Invalid access credential response."), { protocolFailure: true });
    }
    return { Authorization: `Bearer ${token.access_token}` };
}
