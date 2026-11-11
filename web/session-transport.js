import problemFromResponse from "./problem-response.js";
import { isRecord } from "./session-translator.js";

/**
 * @typedef {{
 *   message: string,
 *   status?: number,
 *   problem?: Record<string, unknown>,
 *   terminal?: unknown,
 *   settled?: boolean,
 * }} SessionErrorPayload
 */

/**
 * @typedef {{
 *   stopReason: string,
 *   meta?: Record<string, unknown>,
 *   error?: SessionErrorPayload,
 *   transportError?: Error,
 * }} LiveOutcome
 */

/**
 * @param {string} url
 * @returns {string}
 */
export function resolveAcpUrl(url) {
    const baseOrigin = typeof globalThis.location?.origin === "string" && globalThis.location.origin !== "null"
        ? globalThis.location.origin
        : "http://127.0.0.1";
    return new URL(url, baseOrigin).href;
}

/**
 * @param {{
 *   fetchImpl: typeof globalThis.fetch,
 *   getHeaders: () => Record<string, string>,
 *   getSessionId: () => string | null,
 *   needsConnectionSse: () => boolean,
 *   connSignal: AbortSignal,
 *   getNotificationChain: () => Promise<void>,
 *   getStreamProblem: () => SessionErrorPayload | undefined,
 *   setStreamProblem: (problem: SessionErrorPayload) => void,
 *   emitLiveOutcome: (outcome: LiveOutcome) => void,
 *   onPostStart: (promise: Promise<Response>) => void,
 *   onPostEnd: () => void,
 * }} hooks
 * @returns {typeof globalThis.fetch}
 */
export function createAcpFetch(hooks) {
    return async (input, init) => {
        if (init?.method === "DELETE") {
            return new Response(null, { status: 204 });
        }
        const mergedHeaders = new Headers(init?.headers);
        for (const [key, value] of Object.entries(hooks.getHeaders())) {
            mergedHeaders.set(key, value);
        }
        if (Boolean(hooks.getSessionId()) && !hooks.needsConnectionSse() && init?.method === "GET" && !mergedHeaders.has("acp-session-id")) {
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
        const fetchSignal = init?.signal
            ? AbortSignal.any([init.signal, hooks.connSignal])
            : hooks.connSignal;
        if (init?.method === "GET") {
            const fetchPromise = hooks.fetchImpl(input, {
                ...init,
                headers: mergedHeaders,
                signal: fetchSignal,
            });
            fetchPromise.catch((err) => {
                if (!hooks.connSignal.aborted && !init.signal?.aborted) {
                    hooks.emitLiveOutcome({
                        stopReason: "transport_error",
                        transportError: err instanceof Error ? err : new Error(String(err)),
                    });
                }
            });
            const initialResponse = await fetchPromise;
            if (!initialResponse.ok) {
                if (hooks.getStreamProblem() === undefined) {
                    const refusalError = await problemFromResponse(initialResponse.clone());
                    hooks.setStreamProblem(refusalError
                        ? {
                            message: refusalError.message,
                            status: refusalError.status,
                            problem: isRecord(refusalError.cause) ? refusalError.cause : undefined,
                        }
                        : {
                            message: initialResponse.statusText || `HTTP ${initialResponse.status}`,
                            status: initialResponse.status,
                        });
                }
                return initialResponse;
            }
            if (
                !initialResponse.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
                || !initialResponse.body
            ) {
                return initialResponse;
            }
            const reader = initialResponse.body.getReader();
            const notifyStreamEnd = () => {
                if (fetchSignal.aborted) return;
                void hooks.getNotificationChain().then(() => {
                    if (fetchSignal.aborted) return;
                    const streamProblem = hooks.getStreamProblem();
                    if (streamProblem !== undefined) {
                        hooks.emitLiveOutcome({ stopReason: "error", error: streamProblem });
                    } else {
                        hooks.emitLiveOutcome({ stopReason: "eof" });
                    }
                });
            };
            const wrappedBody = new ReadableStream({
                pull: async (controller) => {
                    try {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            notifyStreamEnd();
                            return;
                        }
                        controller.enqueue(value);
                    } catch (err) {
                        notifyStreamEnd();
                        controller.error(err);
                    }
                },
                cancel: (reason) => reader.cancel(reason),
            });
            return new Response(wrappedBody, {
                status: initialResponse.status,
                statusText: initialResponse.statusText,
                headers: initialResponse.headers,
            });
        }
        const isPost = init?.method === "POST";
        let response;
        try {
            const fetchPromise = hooks.fetchImpl(input, {
                ...init,
                headers: mergedHeaders,
                signal: fetchSignal,
            });
            if (isPost) {
                hooks.onPostStart(fetchPromise);
            }
            response = await fetchPromise;
        } catch (err) {
            if (!hooks.connSignal.aborted && !init?.signal?.aborted) {
                hooks.emitLiveOutcome({
                    stopReason: "transport_error",
                    transportError: err instanceof Error ? err : new Error(String(err)),
                });
            }
            throw err;
        } finally {
            if (isPost) {
                hooks.onPostEnd();
            }
        }
        if (!response.ok && hooks.getStreamProblem() === undefined) {
            const refusalError = await problemFromResponse(response.clone());
            if (refusalError) {
                hooks.setStreamProblem({
                    message: refusalError.message,
                    status: refusalError.status,
                    problem: isRecord(refusalError.cause) ? refusalError.cause : undefined,
                });
            } else {
                hooks.setStreamProblem({
                    message: response.statusText || `HTTP ${response.status}`,
                    status: response.status,
                });
            }
        }
        return response;
    };
}

/**
 * @param {Record<string, unknown> | undefined} metaPlurnk
 * @param {string} stopReason
 * @returns {SessionErrorPayload | undefined}
 */
export function extractTerminalFailure(metaPlurnk, stopReason) {
    const terminalResult = isRecord(metaPlurnk?.terminal) && isRecord(metaPlurnk.terminal.result)
        ? metaPlurnk.terminal.result
        : isRecord(metaPlurnk?.result)
            ? metaPlurnk.result
            : undefined;
    const failedTerminal = typeof terminalResult?.status === "number"
        && terminalResult.status >= 400
        && terminalResult.status !== 499;
    if (!failedTerminal && stopReason !== "error" && stopReason !== "refusal") {
        return undefined;
    }
    const problem = isRecord(terminalResult?.problem) ? terminalResult.problem : terminalResult;
    const message = typeof problem?.detail === "string"
        ? problem.detail
        : typeof problem?.title === "string"
            ? problem.title
            : "Session loop failed.";
    return {
        message,
        status: typeof terminalResult?.status === "number" ? terminalResult.status : undefined,
        problem,
        terminal: metaPlurnk?.terminal ?? terminalResult,
    };
}

/**
 * @param {unknown} error
 * @returns {{ message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown }}
 */
export function extractRpcFailure(error) {
    const data = isRecord(error) && isRecord(error.data) ? error.data : undefined;
    const bodyData = isRecord(data?.body) ? data.body : undefined;
    const plurnkData = isRecord(data?.plurnk) ? data.plurnk : (bodyData ?? data);
    const problem = isRecord(plurnkData?.problem)
        ? plurnkData.problem
        : (isRecord(plurnkData) && typeof plurnkData.type === "string" && typeof plurnkData.status === "number"
            ? plurnkData
            : undefined);
    const terminal = plurnkData?.terminal;
    const status = typeof problem?.status === "number"
        ? problem.status
        : typeof data?.status === "number"
            ? data.status
            : typeof Reflect.get(Object(error), "status") === "number"
                ? Reflect.get(Object(error), "status")
                : undefined;
    const message = typeof problem?.detail === "string"
        ? problem.detail
        : typeof problem?.title === "string"
            ? problem.title
            : error instanceof Error
                ? error.message
                : String(error);
    return { message, status, problem, terminal };
}
