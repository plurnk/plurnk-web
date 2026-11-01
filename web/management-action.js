import { PROTOCOL_VERSION, client, createHttpStream, methods } from "./session-agent.js";
import accessHeaders from "./access-headers.js";
import problemFromResponse from "./problem-response.js";

/** {§web-session-commands} Isolated action delivery never owns observation, conversation or work lifetime. A refusal, before the
 * stream opens or as an ACP error, is the daemon's Problem: the thrown Error carries it as its cause.
 * @param {string} kind @param {Record<string, unknown>} params @param {string} sessionId
 * @param {"session" | "none"} auth @param {AbortSignal} signal
 * @returns {Promise<unknown>}
 */
export default async function managementAction(kind, params, sessionId, auth, signal) {
    const { Validator } = await import("@plurnk/plurnk-contracts");
    /** @param {unknown} value */
    const refused = (value) => {
        const problem = Validator.assertProblemDetails(value);
        return Object.assign(new Error(problem.detail ?? problem.title, { cause: problem }), { status: problem.status });
    };
    const headers = await accessHeaders(auth, signal);
    signal.throwIfAborted();
    /** @type {Error | undefined} */
    let httpFailure;
    /** @type {typeof fetch} */
    const acpFetch = async (input, init) => {
        const response = await fetch(input, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        });
        if (!response.ok && httpFailure === undefined) {
            const refusalError = await problemFromResponse(response.clone());
            httpFailure = refusalError !== null
                ? refusalError
                : Object.assign(new Error(response.statusText || `Request failed (${response.status}).`), { status: response.status });
        }
        return response;
    };
    const stream = createHttpStream(new URL("/acp", window.location.origin).href, {
        fetch: acpFetch,
        headers,
        cookies: "omit",
    });
    const app = client({ name: "@plurnk/plurnk-web" });
    const conn = app.connect(stream);
    const onAbort = () => { conn.close(); };
    signal.onabort = onAbort;
    if (signal.aborted) onAbort();
    try {
        await conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-web", version: "1.0.0" },
        });
        signal.throwIfAborted();
        let outcome;
        if (kind === "providers/list") {
            outcome = await conn.agent.request(methods.agent.providers.list, {});
        } else if (kind === "session/resume") {
            outcome = await conn.agent.request(methods.agent.session.resume, {
                sessionId,
                cwd: "/",
                replayFrom: null,
                ...params,
                _meta: {
                    plurnk: {
                        control: false,
                        ...(typeof params._meta === "object" && params._meta !== null && "plurnk" in params._meta
                            && typeof params._meta.plurnk === "object" && params._meta.plurnk !== null ? params._meta.plurnk : {}),
                    },
                },
            });
        } else if (kind === "session/set_config_option") {
            outcome = await conn.agent.request(methods.agent.session.setConfigOption, {
                sessionId,
                type: "id",
                configId: String(params.configId ?? ""),
                value: String(params.value ?? ""),
            });
        } else if (kind === "session/cancel") {
            await conn.agent.notify(methods.agent.session.cancel, { sessionId });
            outcome = {};
        } else {
            outcome = await conn.agent.request("_plurnk/action", {
                kind,
                params,
                ...(sessionId ? { sessionId } : {}),
            });
        }
        signal.throwIfAborted();
        if (outcome === undefined || outcome === null || typeof outcome !== "object") {
            throw new Error(`${kind} returned no matching action outcome.`);
        }
        return outcome;
    } catch (error) {
        if (httpFailure !== undefined) throw httpFailure;
        if (typeof error === "object" && error !== null && "data" in error) {
            const data = /** @type {Record<string, unknown> | null | undefined} */ (error.data);
            const plurnk = data && typeof data.plurnk === "object" && data.plurnk !== null
                ? /** @type {Record<string, unknown>} */ (data.plurnk)
                : undefined;
            const rawProblem = data && "problem" in data ? data.problem : (plurnk && "problem" in plurnk ? plurnk.problem : data);
            if (rawProblem && typeof rawProblem === "object" && "type" in rawProblem && "status" in rawProblem) {
                throw refused(rawProblem);
            }
        }
        throw error;
    } finally {
        signal.onabort = null;
        conn.close();
    }
}
