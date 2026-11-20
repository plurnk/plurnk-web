import { PROTOCOL_VERSION, client, createHttpStream, methods } from "./session-agent.js";
import accessHeaders from "./access-headers.js";
import problemFromResponse from "./problem-response.js";

// Firefox delays resolving fetch() on chunked text/event-stream responses until the first body byte arrives.
const SSE_HEADERS_FLUSH_MS = 25;

const DAEMON_SCOPED_ACTIONS = new Set([
    "models.local",
    "service.env.list",
    "service.env.set",
    "service.update",
    "workspace.list",
    "workspace.create",
    "workspace.attach",
]);

/** {§web-session-commands} {§web-workspace-settings} Isolated action delivery never owns observation, conversation or work lifetime. A refusal, before the
 * stream opens or as an ACP error, is the daemon's Problem: the thrown Error carries it as its cause.
 * @param {string} kind @param {Record<string, unknown>} params @param {string} sessionId
 * @param {"session" | "none"} auth @param {AbortSignal} signal
 * @param {{ workspaceId?: number }} [options]
 * @returns {Promise<unknown>}
 */
export default async function managementAction(kind, params, sessionId, auth, signal, options = {}) {
    /** @param {unknown} value */
    const refused = async (value) => {
        const { Validator } = await import("@plurnk/plurnk-contracts");
        const problem = Validator.assertProblemDetails(value);
        return Object.assign(new Error(problem.detail ?? problem.title, { cause: problem }), { status: problem.status });
    };
    const headers = await accessHeaders(auth, signal);
    signal.throwIfAborted();
    /** @type {Error | undefined} */
    let httpFailure;
    let connected = false;
    const needsConnSse = !sessionId
        || kind === "providers/list"
        || kind === "session/new"
        || kind === "session/fork"
        || kind === "session/delete"
        || kind === "session/list"
        || DAEMON_SCOPED_ACTIONS.has(kind);
    /** @type {typeof fetch} */
    const acpFetch = async (input, init) => {
        if (init?.method === "DELETE") {
            if (connected && !signal.aborted && httpFailure === undefined && kind !== "session/cancel") {
                await fetch(input, init).catch(() => {});
            }
            return new Response(null, { status: 204 });
        }
        const reqHeaders = new Headers(init?.headers);
        if (init?.method === "GET" && ((!needsConnSse && !reqHeaders.has("acp-session-id")) || kind === "session/cancel")) {
            return new Response(new ReadableStream({
                start(controller) {
                    if (init.signal) {
                        init.signal.onabort = () => {
                            try { controller.close(); } catch { /* ignore */ }
                        };
                    }
                },
            }), {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        }
        const fetchSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
        if (init?.method === "GET" && navigator.userAgent.includes("Firefox")) {
            const fetchPromise = fetch(input, { ...init, signal: fetchSignal });
            const initial = await Promise.race([
                fetchPromise,
                new Promise((resolve) => setTimeout(() => resolve(null), SSE_HEADERS_FLUSH_MS)),
            ]);
            if (initial !== null) {
                if (!initial.ok && httpFailure === undefined) {
                    const refusalError = await problemFromResponse(initial.clone());
                    httpFailure = refusalError !== null
                        ? refusalError
                        : Object.assign(new Error(initial.statusText || `Request failed (${initial.status}).`), { status: initial.status });
                }
                return initial;
            }
            /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
            let reader;
            return new Response(new ReadableStream({
                async pull(controller) {
                    if (!reader) {
                        const resolved = await fetchPromise;
                        if (!resolved.ok && httpFailure === undefined) {
                            const refusalError = await problemFromResponse(resolved.clone());
                            httpFailure = refusalError !== null
                                ? refusalError
                                : Object.assign(new Error(resolved.statusText || `Request failed (${resolved.status}).`), { status: resolved.status });
                        }
                        if (!resolved.ok || !resolved.body) {
                            controller.error(httpFailure ?? new Error("ACP SSE stream failed."));
                            return;
                        }
                        reader = resolved.body.getReader();
                    }
                    const { done, value } = await reader.read();
                    if (done) controller.close();
                    else controller.enqueue(value);
                },
                cancel: (reason) => reader ? reader.cancel(reason) : undefined,
            }), {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        }
        const response = await fetch(input, {
            ...init,
            signal: fetchSignal,
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
            info: { name: "@plurnk/plurnk-web", version: "3.0.0" },
        });
        connected = true;
        signal.throwIfAborted();
        let outcome;
        if (kind === "providers/list") {
            outcome = await conn.agent.request(methods.agent.providers.list, {});
        } else if (kind === "session/new") {
            const rawMeta = typeof params._meta === "object" && params._meta !== null && !Array.isArray(params._meta)
                ? /** @type {Record<string, unknown>} */ (params._meta)
                : undefined;
            outcome = await conn.agent.request(methods.agent.session.new, {
                cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : "/",
                ...(rawMeta ? { _meta: rawMeta } : {}),
            });
        } else if (kind === "session/fork") {
            outcome = await conn.agent.request(methods.agent.session.fork, {
                sessionId,
                cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : "/",
                ...(typeof params.name === "string" && params.name
                    ? { _meta: { plurnk: { sessionName: params.name } } }
                    : {}),
            });
        } else if (kind === "session/delete") {
            outcome = await conn.agent.request(methods.agent.session.delete, {
                sessionId: typeof params.sessionId === "string" && params.sessionId ? params.sessionId : sessionId,
            });
        } else if (kind === "session/resume") {
            outcome = await conn.agent.request(methods.agent.session.resume, {
                sessionId,
                cwd: "/",
                replayFrom: null,
                ...params,
                _meta: {
                    plurnk: {
                        control: false,
                        reasoning: "link",
                        bodies: "link",
                        ...(typeof params._meta === "object" && params._meta !== null && "plurnk" in params._meta
                            && typeof params._meta.plurnk === "object" && params._meta.plurnk !== null ? params._meta.plurnk : {}),
                    },
                },
            });
        } else if (kind === "session/set_config_option") {
            outcome = await conn.agent.request(methods.agent.session.setConfigOption, {
                sessionId,
                ...(typeof params.value === "boolean"
                    ? { type: "boolean", configId: String(params.configId ?? ""), value: params.value }
                    : { type: "id", configId: String(params.configId ?? ""), value: String(params.value ?? "") }),
            });
        } else if (kind === "session/cancel") {
            await conn.agent.notify(methods.agent.session.cancel, { sessionId });
            outcome = {};
        } else {
            outcome = await conn.agent.request("_plurnk/action", {
                kind,
                params,
                ...(sessionId && !DAEMON_SCOPED_ACTIONS.has(kind) ? { sessionId } : {}),
                ...(typeof options.workspaceId === "number" && !DAEMON_SCOPED_ACTIONS.has(kind) ? { workspaceId: options.workspaceId } : {}),
            });
        }
        signal.throwIfAborted();
        if (outcome === undefined || outcome === null || typeof outcome !== "object") {
            throw new Error(`${kind} returned no matching action outcome.`);
        }
        return outcome;
    } catch (error) {
        if (httpFailure !== undefined) throw httpFailure;
        if (signal.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError");
        }
        if (typeof error === "object" && error !== null && "data" in error) {
            const data = /** @type {Record<string, unknown> | null | undefined} */ (error.data);
            const plurnk = data && typeof data.plurnk === "object" && data.plurnk !== null
                ? /** @type {Record<string, unknown>} */ (data.plurnk)
                : undefined;
            const rawProblem = data && "problem" in data ? data.problem : (plurnk && "problem" in plurnk ? plurnk.problem : data);
            if (rawProblem && typeof rawProblem === "object" && "type" in rawProblem && "status" in rawProblem) {
                throw await refused(rawProblem);
            }
        }
        throw error;
    } finally {
        signal.onabort = null;
        conn.close();
    }
}
