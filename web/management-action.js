import { on } from "on_the_money";
import { PROTOCOL_VERSION, client, createHttpStream, methods } from "./session-agent.js";
import accessHeaders from "./access-headers.js";
import { acpUrl, recordDaemonPolicy, recordServiceVersion } from "./endpoints.js";
import { recoverFromUnauthorized } from "./oidc.js";
import problemFromResponse from "./problem-response.js";

// Firefox delays resolving fetch() on chunked text/event-stream responses until the first body byte arrives.
const SSE_HEADERS_FLUSH_MS = 25;

const DAEMON_SCOPED_ACTIONS = new Set([
    "models.list",
    "service.update",
    "workspace.list",
    "workspace.create",
    "workspace.attach",
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * {§web-session-commands} {§web-workspace-settings} Isolated action delivery never owns observation, conversation or work lifetime.
 * A refusal, before the stream opens or as an ACP error, is the daemon's Problem: the thrown Error carries it as its cause.
 *
 * @param {string} kind
 * @param {Record<string, unknown>} params
 * @param {string} sessionId
 * @param {AbortSignal} signal
 * @param {{
 *   workspaceId?: number,
 *   workspace?: string,
 *   redirectOn401?: boolean,
 *   returnTo?: string,
 * }} [options]
 * @returns {Promise<unknown>}
 */
export default async function managementAction(kind, params, sessionId, signal, options = {}) {
    /** @param {unknown} value */
    const refused = async (value) => {
        const { Validator } = await import("@plurnk/plurnk-contracts");
        const problem = Validator.assertProblemDetails(value);
        return Object.assign(new Error(problem.detail ?? problem.title, { cause: problem }), { status: problem.status });
    };

    const executeOnce = async () => {
        const headers = await accessHeaders(signal);
        signal.throwIfAborted();
        /** @type {(Error & { status?: number }) | undefined} */
        let httpFailure;
        let connected = false;
        let deleteSent = false;
        const needsConnSse = !sessionId
            || kind === "providers/list"
            || kind === "session/new"
            || kind === "session/list"
            || DAEMON_SCOPED_ACTIONS.has(kind);
        /** @type {typeof fetch} */
        const acpFetch = async (input, init) => {
            if (init?.method === "DELETE") {
                if (connected && !deleteSent && !signal.aborted && httpFailure === undefined && kind !== "session/cancel") {
                    deleteSent = true;
                    await fetch(input, { ...init, credentials: "same-origin", cache: "no-store" }).catch(() => {});
                }
                return new Response(null, { status: 204 });
            }
            const reqHeaders = new Headers(init?.headers);
            if (init?.method === "GET" && ((!needsConnSse && !reqHeaders.has("acp-session-id")) || kind === "session/cancel")) {
                return new Response(new ReadableStream({
                    start(controller) {
                        if (init.signal) {
                            const closeStream = () => {
                                try { controller.close(); } catch { /* ignore */ }
                            };
                            if (init.signal.aborted) closeStream();
                            else on.target(init.signal, "abort", closeStream, { once: true });
                        }
                    },
                }), {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }
            const fetchSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
            if (init?.method === "GET" && navigator.userAgent.includes("Firefox")) {
                const fetchPromise = fetch(input, { ...init, credentials: "same-origin", cache: "no-store", signal: fetchSignal });
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
            // {§web-bff-auth} Keep same-origin browser cookies on HTTP /acp while leaving SDK cookie-jar emulation disabled (`cookies: "omit"`).
            const response = await fetch(input, {
                ...init,
                credentials: "same-origin",
                cache: "no-store",
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
        const stream = createHttpStream(acpUrl(), {
            fetch: acpFetch,
            headers,
            cookies: "omit",
        });
        const app = client({ name: "@plurnk/plurnk-web" });
        const conn = app.connect(stream);
        const onAbort = () => { conn.close(); };
        const offAbort = on.target(signal, "abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        try {
            const initRes = /** @type {unknown} */ (await conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-web", version: "4.1.0" },
            }));
            if (isRecord(initRes)) {
                if (isRecord(initRes.info)) recordServiceVersion(initRes.info.version);
                if (isRecord(initRes._meta) && isRecord(initRes._meta.plurnk)) {
                    recordDaemonPolicy(initRes._meta.plurnk.policy);
                }
            }
            connected = true;
            signal.throwIfAborted();
            let outcome;
            if (kind === "providers/list") {
                outcome = await conn.agent.request(methods.agent.providers.list, {});
            } else if (kind === "session/list") {
                outcome = await conn.agent.request(methods.agent.session.list, {
                    ...(typeof params.cwd === "string" && params.cwd ? { cwd: params.cwd } : {}),
                    ...(params.archived === "exclude" || params.archived === "include" || params.archived === "only"
                        ? { archived: params.archived }
                        : {}),
                    ...(isRecord(params._meta) ? { _meta: params._meta } : {}),
                });
            } else if (kind === "session/options") {
                outcome = await conn.agent.request(methods.agent.session.options, {
                    cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : "/",
                    ...(sessionId ? { sessionId } : {}),
                    ...(typeof options.workspaceId === "number"
                        ? { _meta: { plurnk: { workspaceId: options.workspaceId } } }
                        : {}),
                });
            } else if (kind === "session/new") {
                const rawMeta = isRecord(params._meta) ? params._meta : undefined;
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
            } else if (kind === "session/archive") {
                outcome = await conn.agent.request(methods.agent.session.archive, {
                    sessionId: typeof params.sessionId === "string" && params.sessionId ? params.sessionId : sessionId,
                });
            } else if (kind === "session/unarchive") {
                outcome = await conn.agent.request(methods.agent.session.unarchive, {
                    sessionId: typeof params.sessionId === "string" && params.sessionId ? params.sessionId : sessionId,
                });
            } else if (kind === "session/set_title") {
                outcome = await conn.agent.request(methods.agent.session.setTitle, {
                    sessionId: typeof params.sessionId === "string" && params.sessionId ? params.sessionId : sessionId,
                    title: String(params.title ?? ""),
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
                            ...(isRecord(params._meta) && isRecord(params._meta.plurnk) ? params._meta.plurnk : {}),
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
                    ...(typeof options.workspace === "string" && options.workspace !== "" && !DAEMON_SCOPED_ACTIONS.has(kind) ? { workspace: options.workspace } : {}),
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
            if (isRecord(error) && "data" in error) {
                const data = isRecord(error.data) ? error.data : undefined;
                const plurnk = data && isRecord(data.plurnk) ? data.plurnk : undefined;
                const rawProblem = data && "problem" in data ? data.problem : (plurnk && "problem" in plurnk ? plurnk.problem : data);
                if (isRecord(rawProblem) && "type" in rawProblem && "status" in rawProblem) {
                    throw await refused(rawProblem);
                }
            }
            throw error;
        } finally {
            offAbort();
            conn.close();
        }
    };

    try {
        return await executeOnce();
    } catch (error) {
        if (Reflect.get(Object(error), "status") === 401 && !signal.aborted) {
            const recovery = await recoverFromUnauthorized({
                signal,
                returnTo: options.returnTo,
                redirectOnDiscovery: options.redirectOn401 !== false,
            });
            if (recovery.status === "refreshed") {
                return await executeOnce();
            }
        }
        throw error;
    }
}
