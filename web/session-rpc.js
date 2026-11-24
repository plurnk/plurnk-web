import { withAccessTokenQuery } from "./oidc.js";
import { extractRpcFailure, resolveAcpUrl } from "./session-transport.js";
import { isRecord } from "./session-translator.js";

/** @typedef {import("./session-transport.js").SessionErrorPayload} SessionErrorPayload */
/** @typedef {import("./session-transport.js").LiveOutcome} LiveOutcome */

/**
 * {§web-session-input} Split inline `$<name>` references matching advertised `type: "skill"` commands into ACP `skill` content blocks.
 * @param {string} promptText
 * @param {readonly unknown[]} [availableCommands]
 * @returns {Array<{ type: "text", text: string } | { type: "skill", name: string }>}
 */
export function buildPromptBlocks(promptText, availableCommands = []) {
    const skillNames = new Set(
        availableCommands
            .filter((cmd) => isRecord(cmd) && cmd.type === "skill" && typeof cmd.name === "string" && cmd.name.length > 0)
            .map((cmd) => /** @type {string} */ (Reflect.get(Object(cmd), "name"))),
    );
    if (skillNames.size === 0 || !promptText.includes("$")) {
        return [{ type: "text", text: promptText }];
    }
    /** @type {Array<{ type: "text", text: string } | { type: "skill", name: string }>} */
    const blocks = [];
    let cursor = 0;
    const tokenPattern = /(?<=^|[\s([{,])\$([^\s,;:!?)\]}]+)/gu;
    for (const match of promptText.matchAll(tokenPattern)) {
        const rawBody = match[1] ?? "";
        const dollarIndex = match.index ?? 0;
        let candidate = rawBody;
        while (candidate.length > 0 && !skillNames.has(candidate) && candidate.endsWith(".")) {
            candidate = candidate.slice(0, -1);
        }
        if (!skillNames.has(candidate)) {
            continue;
        }
        if (dollarIndex > cursor) {
            blocks.push({ type: "text", text: promptText.slice(cursor, dollarIndex) });
        }
        blocks.push({ type: "skill", name: candidate });
        cursor = dollarIndex + 1 + candidate.length;
    }
    if (blocks.length === 0) {
        return [{ type: "text", text: promptText }];
    }
    if (cursor < promptText.length) {
        blocks.push({ type: "text", text: promptText.slice(cursor) });
    }
    return blocks;
}

/**
 * Build the WebSocket target URL and monitored browser `WebSocket` subclass for ACP v2 streams.
 * @param {{
 *   readonly baseUrl: string,
 *   readonly headers: Record<string, string>,
 *   readonly connSignal: AbortSignal,
 *   readonly getNotificationChain: () => Promise<void>,
 *   readonly getStreamProblem: () => SessionErrorPayload | undefined,
 *   readonly emitLiveOutcome: (outcome: LiveOutcome) => void,
 *   readonly onOpened: () => void,
 *   readonly onCancelRequest: () => void,
 * }} options
 */
export function buildMonitoredWebSocketConfig({
    baseUrl,
    headers,
    connSignal,
    getNotificationChain,
    getStreamProblem,
    emitLiveOutcome,
    onOpened,
    onCancelRequest,
}) {
    const authHeader = headers.Authorization ?? headers.authorization ?? "";
    const bearerMatch = /^Bearer\s+(\S+)$/iu.exec(authHeader.trim());
    const wsTarget = new URL(withAccessTokenQuery(resolveAcpUrl(baseUrl), bearerMatch ? bearerMatch[1] : null));
    wsTarget.protocol = wsTarget.protocol === "https:" ? "wss:" : "ws:";

    const MonitoredWebSocket = class extends globalThis.WebSocket {
        /**
         * @param {string | URL} url
         * @param {string | string[]} [protocols]
         */
        constructor(url, protocols) {
            super(url, protocols);
            let opened = false;
            this.onopen = () => {
                opened = true;
                onOpened();
            };
            /** @param {MessageEvent} event */
            this.onmessage = (event) => {
                if (typeof event.data !== "string" || !event.data.includes("$/cancel_request")) return;
                try {
                    const parsed = JSON.parse(event.data);
                    if (isRecord(parsed) && parsed.method === "$/cancel_request") {
                        onCancelRequest();
                    }
                } catch { /* ignore */ }
            };
            /** @param {CloseEvent} event */
            this.onclose = (event) => {
                if (connSignal.aborted) return;
                void getNotificationChain().then(() => {
                    if (connSignal.aborted) return;
                    const problem = getStreamProblem();
                    if (problem !== undefined) {
                        emitLiveOutcome({ stopReason: "error", error: problem });
                        return;
                    }
                    if (!opened || !event.wasClean || event.code !== 1000) {
                        emitLiveOutcome({
                            stopReason: "transport_error",
                            transportError: new Error(event.reason || "ACP WebSocket disconnected."),
                        });
                        return;
                    }
                    emitLiveOutcome({ stopReason: "eof" });
                });
            };
        }
    };

    return {
        href: wsTarget.href,
        WebSocketClass: /** @type {any} */ (MonitoredWebSocket),
    };
}

/**
 * Probe HTTP `/acp` when a WebSocket handshake fails before opening so `401` challenges enter OIDC recovery.
 * @param {{
 *   readonly fetchImpl: typeof globalThis.fetch,
 *   readonly url: string,
 *   readonly headers: Record<string, string>,
 *   readonly protocolVersion: number,
 *   readonly clientInfo: { readonly name: string, readonly version: string },
 *   readonly signal: AbortSignal,
 * }} options
 */
export async function probeWebSocketAuthFailure({
    fetchImpl,
    url,
    headers,
    protocolVersion,
    clientInfo,
    signal,
}) {
    try {
        const probe = await fetchImpl(resolveAcpUrl(url), {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "initialize",
                params: { protocolVersion, info: clientInfo },
            }),
            cache: "no-store",
            signal,
        });
        if (probe.status === 401) {
            throw Object.assign(new Error("Sign in required."), { status: 401 });
        }
    } catch (probeError) {
        if (Reflect.get(Object(probeError), "status") === 401) {
            throw probeError;
        }
    }
}

/**
 * Dispatch an ACP management or session action on a connected `conn.agent` RPC client.
 * @param {{
 *   readonly request: (method: any, params: any) => Promise<unknown>,
 *   readonly notify: (method: any, params: any) => Promise<void>,
 * }} agentRpc
 * @param {{
 *   readonly session: {
 *     readonly new: unknown,
 *     readonly setConfigOption: unknown,
 *     readonly resume: unknown,
 *     readonly fork: unknown,
 *     readonly cancel: unknown,
 *     readonly list: unknown,
 *     readonly setTitle: unknown,
 *     readonly archive: unknown,
 *     readonly unarchive: unknown,
 *     readonly delete: unknown,
 *   },
 *   readonly providers: { readonly list: unknown },
 * }} agentMethods
 * @param {{
 *   readonly sessionId: string | null,
 *   readonly actionKind: string,
 *   readonly actionParams: Record<string, unknown>,
 *   readonly workspace?: string,
 *   readonly projectRoot?: string,
 * }} options
 * @returns {Promise<unknown>}
 */
export async function executeAgentAction(agentRpc, agentMethods, {
    sessionId,
    actionKind,
    actionParams,
    workspace,
    projectRoot,
}) {
    if (actionKind === "session/new") {
        return await agentRpc.request(agentMethods.session.new, {
            cwd: "/",
            _meta: {
                plurnk: {
                    ...(sessionId ? { session: sessionId } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(projectRoot !== undefined ? { projectRoot } : {}),
                },
            },
        });
    }
    if (actionKind === "session/set_config_option") {
        const configId = String(actionParams.configId ?? "");
        const value = String(actionParams.value ?? "");
        return await agentRpc.request(agentMethods.session.setConfigOption, {
            sessionId: sessionId ?? "session1",
            type: "id",
            configId,
            value,
            _meta: {
                plurnk: {
                    ...(workspace ? { workspace } : {}),
                    ...(projectRoot !== undefined ? { projectRoot } : {}),
                },
            },
        });
    }
    if (actionKind === "session/resume") {
        return await agentRpc.request(agentMethods.session.resume, {
            sessionId: sessionId ?? "session1",
            cwd: "/",
            ...(actionParams.replayFrom !== undefined ? { replayFrom: actionParams.replayFrom } : {}),
            _meta: {
                plurnk: {
                    control: false,
                    ...(workspace ? { workspace } : {}),
                    ...(projectRoot !== undefined ? { projectRoot } : {}),
                },
            },
        });
    }
    if (actionKind === "session/fork") {
        return await agentRpc.request(agentMethods.session.fork, {
            sessionId: sessionId ?? "session1",
            cwd: "/",
            ...(typeof actionParams.name === "string" ? { title: actionParams.name } : {}),
            _meta: {
                plurnk: {
                    ...(typeof actionParams.name === "string" ? { sessionName: actionParams.name, name: actionParams.name } : {}),
                    ...(workspace ? { workspace } : {}),
                    ...(projectRoot !== undefined ? { projectRoot } : {}),
                },
            },
        });
    }
    if (actionKind === "session/cancel") {
        await agentRpc.notify(agentMethods.session.cancel, {
            sessionId: sessionId ?? "session1",
            ...(typeof actionParams.reason === "string"
                ? { _meta: { plurnk: { reason: actionParams.reason } } }
                : {}),
        });
        return { cancelled: true };
    }
    if (actionKind === "session/list") {
        return await agentRpc.request(agentMethods.session.list, {
            ...(typeof actionParams.cwd === "string" ? { cwd: actionParams.cwd } : {}),
            ...(actionParams.archived === "exclude" || actionParams.archived === "include" || actionParams.archived === "only"
                ? { archived: actionParams.archived }
                : {}),
            ...(isRecord(actionParams._meta) ? { _meta: actionParams._meta } : {}),
        });
    }
    if (actionKind === "session/set_title") {
        return await agentRpc.request(agentMethods.session.setTitle, {
            sessionId: typeof actionParams.sessionId === "string" ? actionParams.sessionId : (sessionId ?? "session1"),
            title: String(actionParams.title ?? ""),
        });
    }
    if (actionKind === "session/archive") {
        return await agentRpc.request(agentMethods.session.archive, {
            sessionId: typeof actionParams.sessionId === "string" ? actionParams.sessionId : (sessionId ?? "session1"),
        });
    }
    if (actionKind === "session/unarchive") {
        return await agentRpc.request(agentMethods.session.unarchive, {
            sessionId: typeof actionParams.sessionId === "string" ? actionParams.sessionId : (sessionId ?? "session1"),
        });
    }
    if (actionKind === "session/delete") {
        return await agentRpc.request(agentMethods.session.delete, {
            sessionId: typeof actionParams.sessionId === "string" ? actionParams.sessionId : (sessionId ?? "session1"),
        });
    }
    if (actionKind === "providers/list") {
        return await agentRpc.request(agentMethods.providers.list, {});
    }
    return await agentRpc.request("_plurnk/action", {
        kind: actionKind,
        params: actionParams,
        ...(sessionId ? { sessionId } : {}),
        ...(workspace ? { workspace } : {}),
        ...(projectRoot !== undefined ? { projectRoot } : {}),
    });
}

/**
 * Normalize stream or JSON-RPC errors into subscriber `onError` notifications or rethrown transport/auth errors.
 * @param {unknown} error
 * @param {{
 *   readonly signal: AbortSignal,
 *   readonly drainNotifications: () => Promise<void>,
 *   readonly getStreamProblem: () => SessionErrorPayload | undefined,
 *   readonly takeStreamProblem: () => SessionErrorPayload | undefined,
 *   readonly closeConnection: () => void,
 *   readonly onError?: (payload: SessionErrorPayload) => void | Promise<void>,
 *   readonly actionKind?: string,
 * }} hooks
 */
export async function normalizeSessionRunError(error, {
    signal,
    drainNotifications,
    getStreamProblem,
    takeStreamProblem,
    closeConnection,
    onError,
    actionKind,
}) {
    if (signal.aborted && getStreamProblem() === undefined) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError");
    }
    await drainNotifications();
    if (signal.aborted && getStreamProblem() === undefined) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError");
    }
    if (getStreamProblem() === undefined && error instanceof Error && error.message === "ACP session SSE stream closed") {
        closeConnection();
        return { result: undefined, stopReason: "end_turn" };
    }
    const sp = takeStreamProblem();
    if (sp !== undefined) {
        if (sp.status === 401) {
            throw Object.assign(new Error(sp.message, { cause: sp.problem }), {
                status: 401,
                problem: sp.problem,
            });
        }
        if (sp.problem !== undefined) {
            await onError?.(sp);
            const errorResult = actionKind !== undefined
                ? { kind: actionKind, ok: false, problem: sp.problem }
                : undefined;
            return { result: errorResult, stopReason: "error" };
        }
        throw Object.assign(new Error(sp.message), { status: sp.status });
    }
    const { message, status, problem, terminal } = extractRpcFailure(error);
    if (status === 401) {
        throw Object.assign(new Error(message, { cause: problem }), { status: 401, problem });
    }
    if (problem !== undefined || terminal !== undefined) {
        await onError?.({ message, status, problem, terminal });
        const errorResult = actionKind !== undefined && problem !== undefined
            ? { kind: actionKind, ok: false, problem }
            : undefined;
        return { result: errorResult, stopReason: "error" };
    }
    if (!(error instanceof Error)) {
        throw new Error("ACP WebSocket connection failed.", { cause: error });
    }
    throw error;
}
