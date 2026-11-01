// {§web-browser-security} No dynamic code generation in the browser.
import "./schema-validation.js";
import {
    PROTOCOL_VERSION,
    client,
    methods,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { Validator } from "@plurnk/plurnk-contracts";
import problemFromResponse from "./problem-response.js";

export { PROTOCOL_VERSION, Validator, client, createHttpStream, methods };

/**
 * @typedef {{
 *   id: string,
 *   type: "function",
 *   function: { name: string, arguments: string },
 *   metadata?: { plurnk?: Record<string, any> },
 * }} ToolCall
 */

/**
 * @typedef {{
 *   type: "text",
 *   text: string,
 * } | {
 *   type: "document",
 *   source: { type: "url", value: string, mimeType: string },
 * }} MessagePart
 */

/**
 * @typedef {{
 *   id: string,
 *   content?: string | readonly MessagePart[],
 *   name?: string,
 *   subagentRunId?: string,
 *   metadata?: { plurnk?: Record<string, any> },
 * } & (
 *   | { role: "tool", toolCallId: string, error?: string }
 *   | { role: "assistant", toolCalls?: ToolCall[], error?: string }
 *   | { role: "activity", activityType?: string, error?: string }
 *   | { role: "user" | "reasoning" | "system" | "developer", error?: string }
 * )} Message
 */

/**
 * @typedef {Record<string, any> & { sessionUpdate: string, _meta?: { plurnk?: Record<string, any> } | null }} AcpSessionUpdate
 */

/**
 * @typedef {AcpSessionUpdate} AcpSessionUpdatePayload
 */

/**
 * @typedef {{
 *   id: string,
 *   reason: "approval" | "tool_call",
 *   expiresAt?: string,
 *   toolCallId?: string,
 *   message?: string,
 *   responseSchema?: Record<string, unknown>,
 *   metadata?: {
 *     plurnk?: {
 *       proposal?: import("@plurnk/plurnk-contracts").ProposalProjection,
 *       interaction?: import("@plurnk/plurnk-contracts").ClientInteractionProjection,
 *     }
 *   }
 * }} PendingInterrupt
 */

/**
 * @typedef {{
 *   interruptId: string,
 *   status: "resolved" | "cancelled",
 *   payload?: unknown,
 * }} ResumeResolution
 */

/**
 * @typedef {{
 *   messages: Message[],
 *   older: string | null,
 *   final?: boolean,
 *   hasMore?: boolean,
 *   beforeLoopSeq?: number | null,
 * }} MessagesSnapshot
 */

/**
 * @typedef {{
 *   onSessionUpdate?: (args: { update: AcpSessionUpdatePayload, sessionId: string }) => void | Promise<void>,
 *   onThoughtChunk?: (args: { update: AcpSessionUpdatePayload }) => void | Promise<void>,
 *   onMessagesChanged?: (args: { messages: Message[] }) => void | Promise<void>,
 *   onMessagesSnapshot?: (args: { snapshot: MessagesSnapshot }) => void | Promise<void>,
 *   onUserMessage?: (args: { messageId: string }) => void | Promise<void>,
 *   onStateChanged?: (args: { state: Record<string, unknown> }) => void | Promise<void>,
 *   onSettled?: (args: { stopReason: string, meta?: Record<string, unknown>, result?: unknown }) => void | Promise<void>,
 *   onError?: (args: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown }) => void | Promise<void>,
 * }} SessionSubscriber
 */

/**
 * @typedef {{
 *   abortController?: AbortController,
 *   message?: { id: string, role: "user", content: string },
 *   resume?: readonly ResumeResolution[],
 *   action?: Record<string, unknown>,
 *   workspace?: string,
 *   projectRoot?: string,
 *   interrupts?: readonly string[],
 * }} SessionRunOptions
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} content
 * @param {string} defaultMime
 * @returns {string | MessagePart[]}
 */
function extractChunkContent(content, defaultMime) {
    if (!isRecord(content)) return "";
    if (content.type === "resource_link" && typeof content.uri === "string") {
        return [{
            type: "document",
            source: {
                type: "url",
                value: content.uri,
                mimeType: typeof content.mimeType === "string" ? content.mimeType : defaultMime,
            },
        }];
    }
    if (content.type === "text" && typeof content.text === "string") {
        return content.text;
    }
    return "";
}

/**
 * @param {unknown} contentBlocks
 * @param {unknown} rawOutput
 * @returns {string | MessagePart[]}
 */
function extractToolResultContent(contentBlocks, rawOutput) {
    if (Array.isArray(contentBlocks)) {
        const hasResourceLink = contentBlocks.some(
            (block) => isRecord(block) && block.type === "content" && isRecord(block.content) && block.content.type === "resource_link",
        );
        if (hasResourceLink) {
            /** @type {MessagePart[]} */
            const parts = [];
            for (const block of contentBlocks) {
                if (!isRecord(block) || block.type !== "content" || !isRecord(block.content)) continue;
                const inner = block.content;
                if (inner.type === "text" && typeof inner.text === "string") {
                    parts.push({ type: "text", text: inner.text });
                } else if (inner.type === "resource_link" && typeof inner.uri === "string") {
                    parts.push({
                        type: "document",
                        source: {
                            type: "url",
                            value: inner.uri,
                            mimeType: typeof inner.mimeType === "string" ? inner.mimeType : "text/plain",
                        },
                    });
                }
            }
            if (!parts.some((p) => p.type === "text") && rawOutput !== undefined) {
                parts.unshift({
                    type: "text",
                    text: typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput),
                });
            }
            return parts;
        }
    }
    if (rawOutput !== undefined) {
        return typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    }
    if (Array.isArray(contentBlocks)) {
        const texts = [];
        for (const block of contentBlocks) {
            if (isRecord(block) && block.type === "content" && isRecord(block.content) && block.content.type === "text" && typeof block.content.text === "string") {
                texts.push(block.content.text);
            }
        }
        return texts.join("\n");
    }
    return "";
}

/** {§web-session-conversation} {§web-session-history} Project standard ACP v2 session updates into transcript messages. */
export class SessionTranslator {
    /** @type {Set<string>} */
    static #ambientCallIds = new Set();

    /**
     * @param {readonly Record<string, unknown>[]} updates
     * @param {readonly Message[]} [existing]
     * @returns {Message[]}
     */
    static projectMessages(updates, existing = []) {
        /** @type {Message[]} */
        const messages = existing.map((msg) => structuredClone(msg));
        for (const update of updates) {
            if (!isRecord(update) || typeof update.sessionUpdate !== "string") continue;
            const kind = update.sessionUpdate;
            const plurnk = isRecord(update._meta) && isRecord(update._meta.plurnk)
                ? update._meta.plurnk
                : undefined;
            const subagentRunId = typeof update.subagentRunId === "string"
                ? update.subagentRunId
                : typeof plurnk?.subagentRunId === "string"
                    ? plurnk.subagentRunId
                    : undefined;

            if (kind === "user_message_chunk") {
                const id = typeof update.messageId === "string" && update.messageId.length > 0
                    ? update.messageId
                    : typeof plurnk?.messageId === "string" && plurnk.messageId.length > 0
                        ? plurnk.messageId
                        : typeof plurnk?.coordinate === "string"
                            ? plurnk.coordinate
                            : `user-${messages.length + 1}`;
                const chunk = extractChunkContent(update.content, "text/plain");
                const found = messages.find((m) => m.id === id && m.role === "user");
                if (found) {
                    if (Array.isArray(chunk)) {
                        found.content = chunk;
                    } else if (typeof found.content === "string") {
                        if (
                            (plurnk?.id !== undefined && found.metadata?.plurnk?.id === plurnk.id)
                            || found.content === chunk
                            || found.metadata?.plurnk === undefined
                        ) {
                            found.content = chunk;
                        } else {
                            found.content += chunk;
                        }
                    } else {
                        found.content = chunk;
                    }
                    if (subagentRunId) found.subagentRunId = subagentRunId;
                    if (plurnk) {
                        found.metadata = {
                            ...found.metadata,
                            plurnk: {
                                ...(isRecord(found.metadata?.plurnk) ? found.metadata.plurnk : {}),
                                ...structuredClone(plurnk),
                            },
                        };
                    }
                } else {
                    messages.push({
                        id,
                        role: "user",
                        content: chunk,
                        ...(subagentRunId ? { subagentRunId } : {}),
                        ...(plurnk ? { metadata: { plurnk: structuredClone(plurnk) } } : {}),
                    });
                }
                continue;
            }

            if (kind === "agent_message_chunk") {
                const id = typeof update.messageId === "string" && update.messageId.length > 0
                    ? update.messageId
                    : typeof plurnk?.coordinate === "string"
                        ? plurnk.coordinate
                        : `assistant-${messages.length + 1}`;
                const chunk = extractChunkContent(update.content, "text/markdown");
                const found = messages.find((m) => m.id === id && m.role === "assistant");
                if (found) {
                    if (Array.isArray(chunk)) {
                        found.content = chunk;
                    } else if (typeof found.content === "string") {
                        if (plurnk?.id !== undefined && found.metadata?.plurnk?.id === plurnk.id) {
                            found.content = chunk;
                        } else {
                            found.content += chunk;
                        }
                    } else {
                        found.content = chunk;
                    }
                    if (subagentRunId) found.subagentRunId = subagentRunId;
                    if (plurnk) {
                        found.metadata = {
                            ...found.metadata,
                            plurnk: {
                                ...(isRecord(found.metadata?.plurnk) ? found.metadata.plurnk : {}),
                                ...structuredClone(plurnk),
                            },
                        };
                    }
                } else {
                    messages.push({
                        id,
                        role: "assistant",
                        content: chunk,
                        ...(subagentRunId ? { subagentRunId } : {}),
                        ...(plurnk ? { metadata: { plurnk: structuredClone(plurnk) } } : {}),
                    });
                }
                continue;
            }

            if (kind === "agent_thought_chunk") {
                const id = typeof update.messageId === "string" && update.messageId.length > 0
                    ? update.messageId
                    : typeof plurnk?.coordinate === "string"
                        ? `${plurnk.coordinate}/reasoning`
                        : `reasoning-${messages.length + 1}`;
                const block = isRecord(update.content) ? update.content : undefined;
                const linkBody = block?.type === "resource_link" && typeof block.uri === "string"
                    ? {
                        url: block.uri,
                        mimeType: typeof block.mimeType === "string" ? block.mimeType : "text/plain",
                    }
                    : undefined;
                const mergedPlurnk = plurnk || linkBody
                    ? {
                        ...(plurnk ? structuredClone(plurnk) : {}),
                        ...(linkBody && !isRecord(plurnk?.body) ? { body: linkBody } : {}),
                    }
                    : undefined;
                const found = messages.find((m) => m.id === id && m.role === "reasoning");
                if (found) {
                    if (subagentRunId) found.subagentRunId = subagentRunId;
                    if (mergedPlurnk) {
                        found.metadata = {
                            ...found.metadata,
                            plurnk: {
                                ...(isRecord(found.metadata?.plurnk) ? found.metadata.plurnk : {}),
                                ...mergedPlurnk,
                            },
                        };
                    }
                } else {
                    messages.push({
                        id,
                        role: "reasoning",
                        content: "",
                        ...(subagentRunId ? { subagentRunId } : {}),
                        ...(mergedPlurnk ? { metadata: { plurnk: mergedPlurnk } } : {}),
                    });
                }
                continue;
            }

            if (kind === "tool_call" || kind === "tool_call_update") {
                const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.length > 0
                    ? update.toolCallId
                    : typeof plurnk?.coordinate === "string"
                        ? plurnk.coordinate
                        : "";
                if (!toolCallId) continue;

                const isSyntheticInteraction = toolCallId.startsWith("int:") || isRecord(plurnk?.interaction);
                if (isSyntheticInteraction) {
                    const interaction = isRecord(plurnk?.interaction) ? plurnk.interaction : undefined;
                    const req = isRecord(interaction?.request) ? interaction.request : undefined;
                    const name = typeof update.name === "string" && update.name.length > 0
                        ? update.name
                        : typeof req?.toolName === "string"
                            ? req.toolName
                            : "question";
                    const rawArgs = update.rawInput !== undefined ? update.rawInput : req;
                    const args = rawArgs !== undefined
                        ? (typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs))
                        : "{}";
                    const existingCall = messages
                        .flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []))
                        .find((c) => c.id === toolCallId);
                    if (existingCall) {
                        if (typeof update.name === "string" && update.name.length > 0) {
                            existingCall.function.name = update.name;
                        }
                        if (update.rawInput !== undefined) {
                            existingCall.function.arguments = args;
                        }
                    } else {
                        messages.push({
                            id: `call:${toolCallId}`,
                            role: "assistant",
                            content: "",
                            toolCalls: [{
                                id: toolCallId,
                                type: "function",
                                function: { name, arguments: args },
                                metadata: {
                                    plurnk: {
                                        ...(plurnk ? structuredClone(plurnk) : {}),
                                        synthetic: true,
                                    },
                                },
                            }],
                        });
                    }
                    continue;
                }

                if (typeof plurnk?.coordinate === "string" && plurnk.coordinate === toolCallId) {
                    if (plurnk.origin === "model") SessionTranslator.#ambientCallIds.delete(toolCallId);
                    else if (typeof plurnk.origin === "string") SessionTranslator.#ambientCallIds.add(toolCallId);
                }

                // Later observation discharging an earlier tool call (coordinate !== toolCallId).
                if (typeof plurnk?.coordinate === "string" && plurnk.coordinate !== toolCallId) {
                    if (SessionTranslator.#ambientCallIds.has(toolCallId)) {
                        continue;
                    }
                    const obsId = plurnk.coordinate;
                    const obsContent = plurnk.op === "SEND"
                        ? (() => {
                            if (Array.isArray(update.content)) {
                                const first = update.content[0];
                                if (isRecord(first) && first.type === "content" && isRecord(first.content)) {
                                    return extractChunkContent(first.content, "text/markdown");
                                }
                            }
                            return extractToolResultContent(update.content, update.rawOutput);
                        })()
                        : extractToolResultContent(update.content, update.rawOutput);
                    const foundObs = messages.find((m) => m.id === obsId);
                    if (foundObs) {
                        foundObs.content = obsContent;
                        foundObs.metadata = { plurnk: structuredClone(plurnk) };
                    } else {
                        messages.push({
                            id: obsId,
                            role: "tool",
                            toolCallId,
                            content: obsContent,
                            ...(subagentRunId ? { subagentRunId } : {}),
                            metadata: { plurnk: structuredClone(plurnk) },
                        });
                    }
                    continue;
                }

                if (
                    (typeof plurnk?.origin === "string" && plurnk.origin !== "model")
                    || plurnk?.op === null
                    || (isRecord(plurnk?.attrs) && plurnk.attrs.kind === "emissionAttempt")
                ) {
                    continue;
                }

                const existingCall = messages
                    .flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []))
                    .find((c) => c.id === toolCallId);
                const hasCallDefinition =
                    kind === "tool_call"
                    || typeof update.name === "string"
                    || typeof plurnk?.op === "string"
                    || update.rawInput !== undefined;

                if (existingCall) {
                    if (typeof update.name === "string" && update.name.length > 0) {
                        existingCall.function.name = update.name;
                    } else if (typeof plurnk?.op === "string" && plurnk.op.length > 0) {
                        existingCall.function.name = plurnk.op;
                    }
                    if (update.rawInput !== undefined) {
                        existingCall.function.arguments = typeof update.rawInput === "string"
                            ? update.rawInput
                            : JSON.stringify(update.rawInput);
                    }
                    if (plurnk) {
                        const prevPlurnk = isRecord(existingCall.metadata?.plurnk)
                            ? { ...existingCall.metadata.plurnk }
                            : {};
                        if ((update.status === "completed" || update.status === "failed") && plurnk.proposal === undefined) {
                            delete prevPlurnk.proposal;
                        }
                        existingCall.metadata = {
                            ...existingCall.metadata,
                            plurnk: {
                                ...prevPlurnk,
                                ...structuredClone(plurnk),
                            },
                        };
                    }
                } else if (hasCallDefinition) {
                    const name = typeof update.name === "string" && update.name.length > 0
                        ? update.name
                        : typeof plurnk?.op === "string" && plurnk.op.length > 0
                            ? plurnk.op
                            : typeof update.title === "string" && update.title.length > 0
                                ? update.title
                                : "tool";
                    const args = update.rawInput !== undefined
                        ? (typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput))
                        : "{}";
                    messages.push({
                        id: typeof update.messageId === "string" && update.messageId.length > 0
                            ? update.messageId
                            : `call:${toolCallId}`,
                        role: "assistant",
                        content: "",
                        ...(subagentRunId ? { subagentRunId } : {}),
                        toolCalls: [{
                            id: toolCallId,
                            type: "function",
                            function: { name, arguments: args },
                            ...(plurnk ? { metadata: { plurnk: structuredClone(plurnk) } } : {}),
                        }],
                    });
                }

                const hasReceipt =
                    update.status !== "pending"
                    && (update.rawOutput !== undefined
                        || (Array.isArray(update.content)
                            && update.content.some((b) => isRecord(b) && b.type === "content")));
                if (hasReceipt) {
                    const resultId = typeof plurnk?.messageId === "string" && plurnk.messageId.length > 0
                        ? plurnk.messageId
                        : `${toolCallId}:result`;
                    const resultContent = extractToolResultContent(update.content, update.rawOutput);
                    const existingResult = messages.find((m) => m.id === resultId && m.role === "tool");
                    if (existingResult) {
                        existingResult.content = resultContent;
                    } else {
                        messages.push({
                            id: resultId,
                            role: "tool",
                            toolCallId,
                            content: resultContent,
                        });
                    }
                }
            }
        }
        return messages;
    }
}

/** {§web-session-input} Message identity generation works on ordinary HTTP as well as secure contexts. */
export function randomUUID() {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * {§web-session-approval} {§web-session-questions} Build a complete ordered resolution array for the presented interrupts.
 * @param {readonly PendingInterrupt[]} pendingInterrupts
 * @param {Record<string, { status: "resolved" | "cancelled", payload?: unknown }>} resolutions
 * @returns {ResumeResolution[]}
 */
export function buildResumeArray(pendingInterrupts, resolutions) {
    if (!Array.isArray(pendingInterrupts) || pendingInterrupts.length === 0) {
        throw new Error("No pending interrupts to resume.");
    }
    if (!resolutions || typeof resolutions !== "object") {
        throw new Error("Resolutions must be an object keyed by interrupt ID.");
    }
    const ids = new Set(pendingInterrupts.map(({ id }) => id));
    for (const key of Object.keys(resolutions)) {
        if (!ids.has(key)) throw new Error(`Unknown interrupt ID: ${key}`);
    }
    return pendingInterrupts.map(({ id }) => {
        const entry = resolutions[id];
        if (!entry || (entry.status !== "resolved" && entry.status !== "cancelled")) {
            throw new Error(`Missing resolution for interrupt: ${id}`);
        }
        return {
            interruptId: id,
            status: entry.status,
            ...(Object.hasOwn(entry, "payload") ? { payload: entry.payload } : {}),
        };
    });
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} params
 * @returns {Record<string, unknown>}
 */
function buildElicitationResponseSchema(toolName, params) {
    if (params.mode === "url") {
        return {
            oneOf: [{
                type: "object",
                required: ["action"],
                additionalProperties: false,
                properties: {
                    action: { enum: ["accept", "decline", "cancel"] },
                },
            }],
        };
    }
    const requestedSchema = isRecord(params.requestedSchema) ? params.requestedSchema : { type: "object" };
    if (toolName === "mcp_input_required") {
        return {
            oneOf: [
                {
                    type: "object",
                    required: ["action", "content"],
                    additionalProperties: false,
                    properties: {
                        action: { const: "accept" },
                        content: requestedSchema,
                    },
                },
                {
                    type: "object",
                    required: ["action"],
                    additionalProperties: false,
                    properties: {
                        action: { enum: ["decline", "cancel"] },
                    },
                },
            ],
        };
    }
    return requestedSchema;
}

/** {§web-session-observer} {§web-session-reasoning} Official ACP v2 client over `/acp`. */
export default class SessionAgent {
    /** @type {typeof globalThis.fetch} */
    #fetch;
    /** @type {ReturnType<ReturnType<typeof client>["connect"]> | undefined} */
    #conn = undefined;
    /** @type {AbortController | undefined} */
    #connController = undefined;
    /** @type {Promise<void>} */
    #notificationChain = Promise.resolve();
    /** @type {SessionSubscriber} */
    #subscriber = {};
    /** @type {boolean} */
    #bufferingReplay = false;
    /** @type {AcpSessionUpdatePayload[]} */
    #replayUpdates = [];
    /** @type {AbortController | undefined} */
    #activeController = undefined;
    /**
     * @type {Map<string, {
     *   kind: "proposal" | "interaction",
     *   toolName?: string,
     *   mode?: string,
     *   options?: readonly Record<string, unknown>[],
     *   resolve: (value: Record<string, unknown>) => void,
     *   reject: (reason?: unknown) => void,
     * }>}
     */
    #gateResolvers = new Map();
    /** @type {Set<string>} */
    #cancelledSubmittedGates = new Set();
    /** @type {Set<string>} */
    #submittedGateIds = new Set();
    /** @type {PendingInterrupt[]} */
    #allPendingInterrupts = [];
    /** @type {readonly string[] | undefined} */
    #heldInterruptIds = undefined;
    /** @type {number} */
    #inFlightPostCount = 0;
    /** @type {Promise<void>} */
    #outboundPostChain = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    #gateCoalesceTimer = undefined;
    /** @type {(() => void) | undefined} */
    #onGateSettled = undefined;
    /** @type {((outcome: { stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown }, transportError?: Error }) => void) | undefined} */
    #onLiveOutcome = undefined;
    /** @type {{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown }, transportError?: Error } | undefined} */
    #queuedLiveOutcome = undefined;
    /** @type {Promise<{ result: unknown, meta?: Record<string, unknown> }> | undefined} */
    #inFlightRequest = undefined;
    /** @type {{ message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown } | undefined} */
    #streamProblem = undefined;
    /** @type {{ messageId: string, coordinate: string } | undefined} */
    #pendingLiveThought = undefined;
    /** @type {boolean} */
    #needsConnectionSse = false;

    /**
     * @param {{
     *   url?: string,
     *   sessionId?: string | null,
     *   headers?: Record<string, string>,
     *   state?: Record<string, unknown>,
     *   messages?: Message[],
     *   initialMessages?: Message[],
     *   fetch?: typeof globalThis.fetch,
     * }} [config]
     */
    constructor(config = {}) {
        this.url = config.url ?? "/acp";
        this.sessionId = config.sessionId ?? null;
        this.headers = { ...config.headers };
        /** @type {Record<string, unknown>} */
        this.state = isRecord(config.state) ? structuredClone(config.state) : {};
        const initial = config.messages ?? config.initialMessages;
        /** @type {Message[]} */
        this.messages = Array.isArray(initial) ? structuredClone(initial) : [];
        /** @type {PendingInterrupt[]} */
        this.pendingInterrupts = [];
        /** @type {AbortController | undefined} */
        this.abortController = undefined;
        /** @type {boolean} */
        this.isRunning = false;
        this.#fetch = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
    }

    /**
     * @param {Message} message
     */
    addMessage(message) {
        this.messages.push(structuredClone(message));
    }

    abortRun() {
        this.#activeController?.abort();
        this.abortController?.abort();
    }

    close() {
        if (this.#gateCoalesceTimer !== undefined) {
            clearTimeout(this.#gateCoalesceTimer);
            this.#gateCoalesceTimer = undefined;
        }
        this.#onGateSettled = undefined;
        this.#onLiveOutcome = undefined;
        this.#queuedLiveOutcome = undefined;
        this.#inFlightRequest = undefined;
        this.#pendingLiveThought = undefined;
        this.#streamProblem = undefined;
        this.#heldInterruptIds = undefined;
        for (const [, entry] of this.#gateResolvers) {
            entry.reject(new DOMException("The operation was aborted.", "AbortError"));
        }
        this.#gateResolvers.clear();
        this.#allPendingInterrupts = [];
        this.#submittedGateIds.clear();
        this.#cancelledSubmittedGates.clear();
        this.#connController?.abort();
        this.#connController = undefined;
        const prev = this.#conn;
        this.#conn = undefined;
        if (prev) {
            prev.close();
        }
    }

    /**
     * @param {PendingInterrupt} entry
     * @returns {string}
     */
    #interruptSessionKey(entry) {
        const plurnk = isRecord(entry.metadata) && isRecord(entry.metadata.plurnk)
            ? entry.metadata.plurnk
            : undefined;
        const proposal = isRecord(plurnk?.proposal) ? plurnk.proposal : undefined;
        if (typeof proposal?.session === "string") return proposal.session;
        if (typeof proposal?.sessionId === "number") return String(proposal.sessionId);
        const interaction = isRecord(plurnk?.interaction) ? plurnk.interaction : undefined;
        if (typeof interaction?.session === "string") return interaction.session;
        if (typeof interaction?.sessionId === "number") return String(interaction.sessionId);
        return "";
    }

    #syncDescendantGates() {
        const plurnk = isRecord(this.state.plurnk) ? this.state.plurnk : undefined;
        const status = isRecord(plurnk?.status) ? plurnk.status : undefined;
        if (!Array.isArray(status?.descendants)) return false;
        let changed = false;
        const nextDescendants = status.descendants.map((d) => {
            if (!isRecord(d)) return d;
            const matchingGates = [];
            for (const item of this.#allPendingInterrupts) {
                const itemPlurnk = isRecord(item.metadata) && isRecord(item.metadata.plurnk)
                    ? item.metadata.plurnk
                    : undefined;
                const prop = isRecord(itemPlurnk?.proposal) ? itemPlurnk.proposal : undefined;
                const inter = isRecord(itemPlurnk?.interaction) ? itemPlurnk.interaction : undefined;
                const matchesProp = prop !== undefined
                    && ((typeof d.id === "number" && prop.sessionId === d.id)
                        || (typeof d.name === "string" && prop.session === d.name));
                const matchesInter = inter !== undefined
                    && ((typeof d.id === "number" && inter.sessionId === d.id)
                        || (typeof d.name === "string" && inter.session === d.name));
                if (matchesProp && prop !== undefined) {
                    matchingGates.push(structuredClone(prop));
                } else if (matchesInter && inter !== undefined) {
                    matchingGates.push(structuredClone(inter));
                }
            }
            const prevLen = Array.isArray(d.gates) ? d.gates.length : 0;
            if (prevLen !== matchingGates.length) {
                changed = true;
                return { ...d, gates: matchingGates };
            }
            return d;
        });
        if (changed) {
            this.state = {
                ...this.state,
                plurnk: {
                    ...plurnk,
                    status: {
                        ...status,
                        descendants: nextDescendants,
                    },
                },
            };
        }
        return changed;
    }

    #syncPendingInterrupts() {
        if (this.#allPendingInterrupts.length === 0) {
            this.pendingInterrupts = [];
        } else {
            const firstSession = this.#interruptSessionKey(this.#allPendingInterrupts[0]);
            this.pendingInterrupts = this.#allPendingInterrupts.filter(
                (item) => this.#interruptSessionKey(item) === firstSession,
            );
        }
        return this.#syncDescendantGates();
    }

    /**
     * @param {{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown }, transportError?: Error }} outcome
     */
    #emitLiveOutcome(outcome) {
        if (this.#onLiveOutcome !== undefined) {
            this.#onLiveOutcome(outcome);
        } else {
            this.#queuedLiveOutcome = outcome;
        }
    }

    #scheduleGateCoalesce() {
        if (this.#gateCoalesceTimer !== undefined) {
            clearTimeout(this.#gateCoalesceTimer);
        }
        this.#gateCoalesceTimer = setTimeout(() => {
            this.#gateCoalesceTimer = undefined;
            void this.#notificationChain.then(async () => {
                if (this.#connController?.signal.aborted) return;
                this.#syncPendingInterrupts();
                if (!this.#bufferingReplay) {
                    await this.#subscriber.onStateChanged?.({ state: this.state });
                }
                this.#onGateSettled?.();
                const held = this.#heldInterruptIds;
                const currentIds = this.pendingInterrupts.map(({ id }) => id);
                const sameHeld = held !== undefined
                    && held.length === currentIds.length
                    && currentIds.every((id, idx) => id === held[idx]);
                if (!sameHeld) {
                    this.#emitLiveOutcome({ stopReason: "interrupt" });
                }
            });
        });
    }

    async #drainNotifications() {
        await new Promise((resolve) => setTimeout(resolve));
        await this.#notificationChain;
    }

    /**
     * @param {AbortSignal} signal
     */
    async #ensureConnection(signal) {
        if (this.#conn !== undefined && this.#connController !== undefined && !this.#connController.signal.aborted) {
            return this.#conn;
        }
        this.close();
        const connController = new AbortController();
        this.#connController = connController;
        this.#streamProblem = undefined;

        const baseOrigin = typeof globalThis.location?.origin === "string" && globalThis.location.origin !== "null"
            ? globalThis.location.origin
            : "http://127.0.0.1";
        const resolvedUrl = new URL(this.url, baseOrigin).href;

        /** @type {typeof globalThis.fetch} */
        const acpFetch = async (input, init) => {
            if (init?.method === "DELETE") {
                return new Response(null, { status: 204 });
            }
            const mergedHeaders = new Headers(init?.headers);
            for (const [key, value] of Object.entries(this.headers)) {
                mergedHeaders.set(key, value);
            }
            if (Boolean(this.sessionId) && !this.#needsConnectionSse && init?.method === "GET" && !mergedHeaders.has("acp-session-id")) {
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
            const isPost = init?.method === "POST";
            if (isPost) {
                this.#inFlightPostCount += 1;
            }
            let response;
            try {
                const fetchPromise = this.#fetch(input, {
                    ...init,
                    headers: mergedHeaders,
                });
                if (isPost) {
                    this.#outboundPostChain = this.#outboundPostChain
                        .catch(() => undefined)
                        .then(() => fetchPromise.then(() => undefined, () => undefined));
                }
                response = await fetchPromise;
            } catch (err) {
                if (!connController.signal.aborted && !init?.signal?.aborted) {
                    this.#emitLiveOutcome({
                        stopReason: "transport_error",
                        transportError: err instanceof Error ? err : new Error(String(err)),
                    });
                }
                throw err;
            } finally {
                if (isPost) {
                    this.#inFlightPostCount = Math.max(0, this.#inFlightPostCount - 1);
                }
            }
            if (!response.ok && this.#streamProblem === undefined) {
                const refusalError = await problemFromResponse(response.clone());
                if (refusalError) {
                    this.#streamProblem = {
                        message: refusalError.message,
                        status: refusalError.status,
                        problem: isRecord(refusalError.cause) ? refusalError.cause : undefined,
                    };
                } else {
                    this.#streamProblem = {
                        message: response.statusText || `HTTP ${response.status}`,
                        status: response.status,
                    };
                }
            }
            if (
                response.ok
                && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
                && response.body
            ) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const notifyStreamEnd = () => {
                    if (init?.signal?.aborted) return;
                    void this.#notificationChain.then(() => {
                        if (init?.signal?.aborted) return;
                        if (this.#streamProblem !== undefined) {
                            this.#emitLiveOutcome({ stopReason: "error", error: this.#streamProblem });
                        } else {
                            this.#emitLiveOutcome({ stopReason: "eof" });
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
                            if (value && this.#submittedGateIds.size > 0) {
                                const text = decoder.decode(value, { stream: true });
                                if (text.includes('"$/cancel_request"')) {
                                    for (const id of this.#submittedGateIds) {
                                        this.#cancelledSubmittedGates.add(id);
                                    }
                                }
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
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            }
            return response;
        };

        const stream = createHttpStream(resolvedUrl, {
            fetch: acpFetch,
            headers: this.headers,
            cookies: "omit",
        });

        const app = client({ name: "@plurnk/plurnk-web" });

        app.onNotification(methods.client.session.update, (ctx) => {
            this.#notificationChain = this.#notificationChain.then(async () => {
                if (connController.signal.aborted) return;
                const sessionId = typeof ctx.params.sessionId === "string"
                    ? ctx.params.sessionId
                    : (this.sessionId ?? "");
                const rawUpdate = /** @type {Record<string, unknown>} */ (ctx.params.update);
                if (!isRecord(rawUpdate)) return;
                const plurnk = isRecord(rawUpdate._meta) && isRecord(rawUpdate._meta.plurnk)
                    ? rawUpdate._meta.plurnk
                    : undefined;
                const update = /** @type {AcpSessionUpdatePayload} */ (
                    typeof plurnk?.subagentRunId === "string" && rawUpdate.subagentRunId === undefined
                        ? { ...rawUpdate, subagentRunId: plurnk.subagentRunId }
                        : rawUpdate
                );
                await this.#handleSessionUpdate(sessionId, update, this.#subscriber);
            });
        });

        app.onNotification(methods.client.elicitation.complete, () => {});

        app.onRequest(methods.client.session.requestPermission, async (ctx) => {
            await this.#notificationChain;
            const params = /** @type {Record<string, unknown>} */ (ctx.params);
            const metaPlurnk = isRecord(params._meta) && isRecord(params._meta.plurnk)
                ? params._meta.plurnk
                : undefined;
            const proposal = isRecord(metaPlurnk?.proposal) ? metaPlurnk.proposal : undefined;
            const logEntryId = typeof proposal?.logEntryId === "number" ? proposal.logEntryId : randomUUID();
            const interruptId = `proposal:${logEntryId}:${randomUUID().slice(0, 8)}`;
            const rawExpires = proposal?.expiresAt;
            const expiresAt = typeof rawExpires === "number"
                ? new Date(rawExpires).toISOString()
                : typeof rawExpires === "string"
                    ? rawExpires
                    : undefined;
            /** @type {PendingInterrupt} */
            const entry = {
                id: interruptId,
                reason: "approval",
                ...(expiresAt !== undefined ? { expiresAt } : {}),
                ...(proposal !== undefined
                    ? {
                        metadata: {
                            plurnk: {
                                proposal: /** @type {import("@plurnk/plurnk-contracts").ProposalProjection} */ (
                                    /** @type {unknown} */ (structuredClone(proposal))
                                ),
                            },
                        },
                    }
                    : {}),
            };
            this.#allPendingInterrupts.push(entry);
            this.#syncPendingInterrupts();

            return await new Promise((resolve, reject) => {
                const options = Array.isArray(params.options)
                    ? /** @type {readonly Record<string, unknown>[]} */ (params.options)
                    : [];
                this.#gateResolvers.set(interruptId, {
                    kind: "proposal",
                    options,
                    resolve: (res) => {
                        ctx.signal.removeEventListener("abort", onCancel);
                        resolve(/** @type {never} */ (res));
                    },
                    reject: (err) => {
                        ctx.signal.removeEventListener("abort", onCancel);
                        reject(err);
                    },
                });
                const onCancel = () => {
                    this.#gateResolvers.delete(interruptId);
                    this.#allPendingInterrupts = this.#allPendingInterrupts.filter((item) => item.id !== interruptId);
                    const changed = this.#syncPendingInterrupts();
                    if (this.#submittedGateIds.has(interruptId)) {
                        this.#cancelledSubmittedGates.add(interruptId);
                    }
                    if (connController.signal.aborted) {
                        reject(new DOMException("The operation was aborted.", "AbortError"));
                        return;
                    }
                    setTimeout(() => {
                        void this.#notificationChain.then(async () => {
                            if (connController.signal.aborted) return;
                            if (changed && !this.#bufferingReplay) {
                                await this.#subscriber.onStateChanged?.({ state: this.state });
                            }
                            if (this.pendingInterrupts.length > 0) {
                                this.#onLiveOutcome?.({ stopReason: "interrupt" });
                            } else if (this.#inFlightRequest === undefined) {
                                const status = isRecord(this.state.plurnk) && isRecord(this.state.plurnk.status)
                                    ? this.state.plurnk.status
                                    : undefined;
                                const lifecycle = typeof status?.lifecycle === "string" ? status.lifecycle : "idle";
                                if (!["queued", "running", "parked"].includes(lifecycle)) {
                                    this.#onLiveOutcome?.({ stopReason: "end_turn" });
                                }
                            }
                        });
                    });
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                };
                ctx.signal.onabort = onCancel;
                this.#scheduleGateCoalesce();
            });
        });

        app.onRequest(methods.client.elicitation.create, async (ctx) => {
            await this.#notificationChain;
            const params = /** @type {Record<string, unknown>} */ (ctx.params);
            const metaPlurnk = isRecord(params._meta) && isRecord(params._meta.plurnk)
                ? params._meta.plurnk
                : undefined;
            const interaction = isRecord(metaPlurnk?.interaction) ? metaPlurnk.interaction : undefined;
            const interactionId = typeof interaction?.interactionId === "number"
                ? interaction.interactionId
                : randomUUID();
            const interruptId = `int:${interactionId}:${randomUUID().slice(0, 8)}`;
            const toolCallId = typeof params.toolCallId === "string"
                ? params.toolCallId
                : `int:${interactionId}`;
            const reqRecord = isRecord(interaction?.request) ? interaction.request : {};
            const toolName = typeof reqRecord.toolName === "string" ? reqRecord.toolName : "question";
            const message = typeof params.message === "string"
                ? params.message
                : typeof reqRecord.message === "string"
                    ? reqRecord.message
                    : undefined;
            const responseSchema = buildElicitationResponseSchema(toolName, params);

            const hasCall = this.messages
                .flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []))
                .some((c) => c.id === toolCallId);
            if (!hasCall) {
                const argsPayload = toolName === "mcp_input_required" && params.mode === "url"
                    ? { requests: { authorize: { params: { url: params.url, message: params.message, elicitationId: params.elicitationId } } } }
                    : reqRecord;
                this.messages = SessionTranslator.projectMessages([
                    {
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        name: toolName,
                        title: toolName,
                        kind: "other",
                        status: "in_progress",
                        rawInput: argsPayload,
                        ...(interaction ? { _meta: { plurnk: { interaction } } } : {}),
                    },
                ], this.messages);
            } else if (toolName === "mcp_input_required" && params.mode === "url") {
                const call = this.messages
                    .flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []))
                    .find((c) => c.id === toolCallId);
                if (call) {
                    call.function.arguments = JSON.stringify({
                        requests: {
                            authorize: {
                                params: {
                                    url: params.url,
                                    message: params.message,
                                    elicitationId: params.elicitationId,
                                },
                            },
                        },
                    });
                }
            }

            /** @type {PendingInterrupt} */
            const entry = {
                id: interruptId,
                reason: "tool_call",
                toolCallId,
                ...(message !== undefined ? { message } : {}),
                responseSchema: structuredClone(responseSchema),
                ...(interaction !== undefined
                    ? {
                        metadata: {
                            plurnk: {
                                interaction: /** @type {import("@plurnk/plurnk-contracts").ClientInteractionProjection} */ (
                                    /** @type {unknown} */ (structuredClone(interaction))
                                ),
                            },
                        },
                    }
                    : {}),
            };
            this.#allPendingInterrupts.push(entry);
            this.#syncPendingInterrupts();

            return await new Promise((resolve, reject) => {
                this.#gateResolvers.set(interruptId, {
                    kind: "interaction",
                    toolName,
                    mode: typeof params.mode === "string" ? params.mode : "form",
                    resolve: (res) => {
                        ctx.signal.removeEventListener("abort", onCancel);
                        resolve(/** @type {never} */ (res));
                    },
                    reject: (err) => {
                        ctx.signal.removeEventListener("abort", onCancel);
                        reject(err);
                    },
                });
                const onCancel = () => {
                    this.#gateResolvers.delete(interruptId);
                    this.#allPendingInterrupts = this.#allPendingInterrupts.filter((item) => item.id !== interruptId);
                    const changed = this.#syncPendingInterrupts();
                    if (this.#submittedGateIds.has(interruptId)) {
                        this.#cancelledSubmittedGates.add(interruptId);
                    }
                    if (connController.signal.aborted) {
                        reject(new DOMException("The operation was aborted.", "AbortError"));
                        return;
                    }
                    setTimeout(() => {
                        void this.#notificationChain.then(async () => {
                            if (connController.signal.aborted) return;
                            if (changed && !this.#bufferingReplay) {
                                await this.#subscriber.onStateChanged?.({ state: this.state });
                            }
                            if (this.pendingInterrupts.length > 0) {
                                this.#onLiveOutcome?.({ stopReason: "interrupt" });
                            } else if (this.#inFlightRequest === undefined) {
                                const status = isRecord(this.state.plurnk) && isRecord(this.state.plurnk.status)
                                    ? this.state.plurnk.status
                                    : undefined;
                                const lifecycle = typeof status?.lifecycle === "string" ? status.lifecycle : "idle";
                                if (!["queued", "running", "parked"].includes(lifecycle)) {
                                    this.#onLiveOutcome?.({ stopReason: "end_turn" });
                                }
                            }
                        });
                    });
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                };
                ctx.signal.onabort = onCancel;
                this.#scheduleGateCoalesce();
            });
        });

        const conn = app.connect(stream);
        this.#conn = conn;
        try {
            await conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-web", version: "1.0.0" },
                capabilities: {},
            });
        } catch (error) {
            const streamProblem = /** @type {{ message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown } | undefined} */ (this.#streamProblem);
            this.close();
            if (streamProblem !== undefined && !signal.aborted) {
                throw Object.assign(new Error(streamProblem.message, { cause: streamProblem.problem }), {
                    status: streamProblem.status,
                    problem: streamProblem.problem,
                });
            }
            throw error;
        }
        return conn;
    }

    /**
     * @param {SessionRunOptions} [options]
     * @param {SessionSubscriber} [subscriber]
     */
    async connectAgent(options = {}, subscriber = {}) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        const { signal } = controller;
        const heldInterrupts = Array.isArray(options.interrupts) ? [...options.interrupts] : [];

        try {
            this.#heldInterruptIds = heldInterrupts.length > 0 ? heldInterrupts : undefined;
            if (heldInterrupts.length > 0 && this.#conn !== undefined) {
                const currentIds = this.pendingInterrupts.map(({ id }) => id);
                const sameSet = currentIds.length === heldInterrupts.length
                    && currentIds.every((id, idx) => id === heldInterrupts[idx]);
                if (!sameSet) {
                    const stopReason = this.pendingInterrupts.length > 0 ? "interrupt" : "end_turn";
                    await subscriber.onSettled?.({ stopReason, result: {} });
                    return { result: {}, stopReason };
                }
                const outcome = await this.#waitForLiveOutcome(signal);
                if (outcome.error) {
                    this.close();
                    await subscriber.onError?.(outcome.error);
                    return { result: undefined, stopReason: "error" };
                }
                if (outcome.stopReason === "eof") {
                    this.close();
                    return { result: {}, stopReason: "end_turn" };
                }
                await subscriber.onSettled?.({ stopReason: outcome.stopReason, meta: outcome.meta, result: {} });
                return { result: {}, stopReason: outcome.stopReason, meta: outcome.meta };
            }

            this.#allPendingInterrupts = [];
            this.pendingInterrupts = [];
            this.#queuedLiveOutcome = undefined;
            this.#pendingLiveThought = undefined;
            this.#bufferingReplay = true;
            this.#replayUpdates = [];
            this.#needsConnectionSse = false;
            const conn = await this.#ensureConnection(signal);

            const params = {
                sessionId: this.sessionId ?? "",
                cwd: "/",
                replayFrom: { type: /** @type {const} */ ("start") },
                _meta: {
                    plurnk: {
                        control: false,
                        reasoning: "link",
                        ...(options.workspace ? { workspace: options.workspace } : {}),
                        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
                    },
                },
            };

            const response = /** @type {unknown} */ (
                await conn.agent.request(methods.agent.session.resume, params)
            );
            await this.#drainNotifications();
            const rawResult = isRecord(response) ? response : {};
            const metaPlurnk = isRecord(rawResult._meta) && isRecord(rawResult._meta.plurnk)
                ? rawResult._meta.plurnk
                : undefined;

            this.#applyResponseState(rawResult, metaPlurnk);
            if (Object.keys(this.state).length > 0) {
                await subscriber.onStateChanged?.({ state: this.state });
            }

            if (this.#bufferingReplay) {
                this.#bufferingReplay = false;
                const replayed = this.#replayUpdates.splice(0);
                const history = isRecord(metaPlurnk?.history) ? metaPlurnk.history : undefined;
                if (history !== undefined) {
                    this.messages = SessionTranslator.projectMessages(replayed, []);
                    const statusObj = isRecord(metaPlurnk?.status) ? metaPlurnk.status : undefined;
                    const wsObj = isRecord(metaPlurnk?.workspace) ? metaPlurnk.workspace : undefined;
                    const numericSessionId = typeof metaPlurnk?.sessionId === "number"
                        ? metaPlurnk.sessionId
                        : (isRecord(metaPlurnk?.session) && typeof metaPlurnk.session.id === "number" ? metaPlurnk.session.id : undefined);
                    const inboxItems = Array.isArray(statusObj?.inbox) ? statusObj.inbox : [];
                    if (inboxItems.length > 0 && typeof wsObj?.id === "number" && typeof numericSessionId === "number") {
                        const existingIds = new Set(this.messages.map((m) => m.id));
                        const baseOrigin = typeof globalThis.location?.origin === "string" && globalThis.location.origin !== "null"
                            ? globalThis.location.origin
                            : "http://127.0.0.1";
                        for (const item of inboxItems) {
                            if (!isRecord(item) || typeof item.id !== "string" || typeof item.path !== "string" || existingIds.has(item.id)) {
                                continue;
                            }
                            const entryUrl = new URL(
                                `/acp/${encodeURIComponent(String(wsObj.id))}/${encodeURIComponent(String(numericSessionId))}/entry?target=${encodeURIComponent(item.path)}`,
                                new URL(this.url, baseOrigin).origin,
                            ).href;
                            const res = await this.#fetch(entryUrl, { headers: new Headers(this.headers), signal });
                            if (res.ok) {
                                const content = await res.text();
                                this.messages.push({ id: item.id, role: "user", content });
                                existingIds.add(item.id);
                            }
                        }
                    }
                    const older = typeof history.older === "string" ? history.older : null;
                    await subscriber.onMessagesSnapshot?.({
                        snapshot: {
                            messages: this.messages,
                            older,
                            hasMore: typeof history.hasMore === "boolean" ? history.hasMore : Boolean(older),
                            beforeLoopSeq: typeof history.beforeLoopSeq === "number" ? history.beforeLoopSeq : null,
                        },
                    });
                    await subscriber.onMessagesChanged?.({ messages: this.messages });
                } else {
                    for (const u of replayed) {
                        await this.#applyLiveMessageUpdate(u, subscriber);
                    }
                }
            }

            if (this.#gateCoalesceTimer !== undefined) {
                await new Promise((r) => {
                    this.#onGateSettled = () => {
                        this.#onGateSettled = undefined;
                        r(undefined);
                    };
                });
            }

            if (this.pendingInterrupts.length > 0) {
                this.#queuedLiveOutcome = undefined;
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: metaPlurnk, result: rawResult });
                return { result: rawResult, stopReason: "interrupt", meta: metaPlurnk };
            }

            const outcome = await this.#waitForLiveOutcome(signal);
            if (outcome.error) {
                this.close();
                await subscriber.onError?.(outcome.error);
                return { result: undefined, stopReason: "error", meta: outcome.meta };
            }
            if (outcome.stopReason === "eof") {
                this.close();
                return { result: rawResult, stopReason: "end_turn", meta: metaPlurnk };
            }
            const stopReason = outcome.stopReason;
            if (stopReason !== "interrupt") {
                this.close();
            }
            await subscriber.onSettled?.({ stopReason, meta: outcome.meta ?? metaPlurnk, result: rawResult });
            return { result: rawResult, stopReason, meta: outcome.meta ?? metaPlurnk };
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
        }
    }

    /**
     * @param {SessionRunOptions} [options]
     * @param {SessionSubscriber} [subscriber]
     */
    async runAgent(options = {}, subscriber = {}) {
        if (options.action) {
            return await this.#runAction(options, subscriber);
        }
        if (Array.isArray(options.resume) && options.resume.length > 0) {
            return await this.#runResume(options.resume, options, subscriber);
        }
        const lastMessage = this.messages.at(-1);
        const message = options.message ?? (
            lastMessage?.role === "user" && typeof lastMessage.content === "string"
                ? {
                    id: lastMessage.id,
                    role: /** @type {const} */ ("user"),
                    content: lastMessage.content,
                }
                : undefined
        );
        if (message) {
            return await this.#runPrompt(message, options, subscriber);
        }
        return await this.connectAgent(options, subscriber);
    }

    /**
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runAction(options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        const { signal } = controller;
        const rawAction = options.action ?? {};
        const { kind, params: nestedParams, ...rest } = rawAction;
        const actionParams = isRecord(nestedParams) ? nestedParams : rest;
        const actionKind = typeof kind === "string" ? kind : "";
        const needsConnSse = !this.sessionId || actionKind === "session/new" || actionKind === "providers/list" || actionKind === "session/list";
        if (needsConnSse && !this.#needsConnectionSse && this.#conn !== undefined) {
            this.close();
        }
        this.#needsConnectionSse = needsConnSse;
        const hadConn = this.#conn !== undefined && this.#connController !== undefined && !this.#connController.signal.aborted;

        try {
            const conn = await this.#ensureConnection(signal);
            let response;
            if (actionKind === "session/new") {
                response = await conn.agent.request(methods.agent.session.new, {
                    cwd: "/",
                    _meta: {
                        plurnk: {
                            ...(this.sessionId ? { session: this.sessionId } : {}),
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/set_config_option") {
                const configId = String(actionParams.configId ?? "");
                const rawVal = String(actionParams.value ?? "");
                const value = configId === "spawn_model" && rawVal === "" ? "inherit" : rawVal;
                response = await conn.agent.request(methods.agent.session.setConfigOption, {
                    sessionId: this.sessionId ?? "user",
                    type: "id",
                    configId,
                    value,
                    _meta: {
                        plurnk: {
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/resume") {
                response = await conn.agent.request(methods.agent.session.resume, {
                    sessionId: this.sessionId ?? "user",
                    cwd: "/",
                    ...(actionParams.replayFrom !== undefined
                        ? { replayFrom: /** @type {import("@agentclientprotocol/sdk/experimental/v2/unstable").ReplayFrom | null} */ (actionParams.replayFrom) }
                        : {}),
                    _meta: {
                        plurnk: {
                            control: false,
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/fork") {
                response = await conn.agent.request(methods.agent.session.fork, {
                    sessionId: this.sessionId ?? "user",
                    cwd: "/",
                    ...(typeof actionParams.name === "string" ? { title: actionParams.name } : {}),
                    _meta: {
                        plurnk: {
                            ...(typeof actionParams.name === "string" ? { name: actionParams.name } : {}),
                            ...(options.workspace ? { workspace: options.workspace } : {}),
                            ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                        },
                    },
                });
            } else if (actionKind === "session/cancel") {
                await conn.agent.notify(methods.agent.session.cancel, {
                    sessionId: this.sessionId ?? "user",
                    ...(typeof actionParams.reason === "string"
                        ? { _meta: { plurnk: { reason: actionParams.reason } } }
                        : {}),
                });
                response = { cancelled: true };
            } else if (actionKind === "session/list") {
                response = await conn.agent.request(methods.agent.session.list, {
                    cwd: typeof actionParams.cwd === "string" ? actionParams.cwd : undefined,
                    ...(isRecord(actionParams._meta) ? { _meta: actionParams._meta } : {}),
                });
            } else if (actionKind === "session/delete") {
                response = await conn.agent.request(methods.agent.session.delete, {
                    sessionId: typeof actionParams.sessionId === "string" ? actionParams.sessionId : (this.sessionId ?? "user"),
                });
            } else if (actionKind === "providers/list") {
                response = await conn.agent.request(methods.agent.providers.list, {});
            } else {
                response = await conn.agent.request("_plurnk/action", {
                    kind: actionKind,
                    params: actionParams,
                    ...(this.sessionId ? { sessionId: this.sessionId } : {}),
                    ...(options.workspace ? { workspace: options.workspace } : {}),
                    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                });
            }
            await this.#drainNotifications();
            const rawResult = isRecord(response) ? response : {};
            const metaPlurnk = isRecord(rawResult._meta) && isRecord(rawResult._meta.plurnk)
                ? rawResult._meta.plurnk
                : undefined;
            this.#applyResponseState(rawResult, metaPlurnk);
            if (Object.keys(this.state).length > 0) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            const result = Object.hasOwn(rawResult, "ok")
                ? rawResult
                : { kind: actionKind, ok: true, result: response };
            await subscriber.onSettled?.({ stopReason: "end_turn", meta: metaPlurnk, result });
            return { result, stopReason: "end_turn", meta: metaPlurnk };
        } catch (error) {
            return await this.#handleError(error, signal, subscriber, actionKind);
        } finally {
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
            if (!hadConn) {
                this.close();
            }
        }
    }

    /**
     * @param {{ id: string, role: "user", content: string }} message
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runPrompt(message, options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        this.#bufferingReplay = false;
        this.#replayUpdates = [];
        this.#pendingLiveThought = undefined;
        this.#queuedLiveOutcome = undefined;
        this.#allPendingInterrupts = [];
        this.pendingInterrupts = [];
        const { signal } = controller;

        try {
            this.#needsConnectionSse = false;
            const conn = await this.#ensureConnection(signal);
            const params = {
                sessionId: this.sessionId ?? "user",
                messageId: message.id,
                prompt: [{ type: /** @type {const} */ ("text"), text: message.content }],
                _meta: {
                    plurnk: {
                        messageId: message.id,
                        reasoning: "link",
                        ...(options.workspace ? { workspace: options.workspace } : {}),
                        ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                    },
                },
            };

            const requestPromise = conn.agent.request(methods.agent.session.prompt, params).then((res) => {
                const rawResult = /** @type {Record<string, unknown>} */ (isRecord(res) ? res : {});
                const metaPlurnk = isRecord(rawResult._meta) && isRecord(rawResult._meta.plurnk)
                    ? rawResult._meta.plurnk
                    : undefined;
                return { result: rawResult, meta: metaPlurnk };
            });
            this.#inFlightRequest = requestPromise;
            void requestPromise.then(
                () => {
                    if (this.#inFlightRequest === requestPromise) {
                        this.#inFlightRequest = undefined;
                    }
                },
                () => {
                    if (this.#inFlightRequest === requestPromise) {
                        this.#inFlightRequest = undefined;
                    }
                },
            );

            return await this.#awaitRequestOrInterrupt(requestPromise, signal, subscriber);
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
        }
    }

    /**
     * @param {readonly ResumeResolution[]} resolutions
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runResume(resolutions, options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        this.#bufferingReplay = false;
        this.#replayUpdates = [];
        this.#submittedGateIds.clear();
        this.#cancelledSubmittedGates.clear();
        this.#queuedLiveOutcome = undefined;
        const { signal } = controller;

        try {
            this.#needsConnectionSse = false;
            await this.#ensureConnection(signal);
            let missingGateKind = /** @type {"proposal" | "interaction" | undefined} */ (undefined);
            const plurnkState = isRecord(this.state.plurnk) ? this.state.plurnk : undefined;
            const statusState = isRecord(plurnkState?.status) ? plurnkState.status : undefined;
            const rawParts = typeof this.sessionId === "string" ? this.sessionId.split("#") : [];
            const boundName = typeof statusState?.name === "string" ? statusState.name : (rawParts[1] || "user");
            const boundId = typeof statusState?.id === "number" ? String(statusState.id) : "";
            let resolvedDescendantOnly = resolutions.length > 0;
            for (const res of resolutions) {
                const existing = this.#allPendingInterrupts.find((item) => item.id === res.interruptId);
                if (existing) {
                    const key = this.#interruptSessionKey(existing);
                    if (!key || key === boundName || key === boundId) {
                        resolvedDescendantOnly = false;
                    }
                } else {
                    resolvedDescendantOnly = false;
                }
            }

            for (const res of resolutions) {
                const gate = this.#gateResolvers.get(res.interruptId);
                this.#allPendingInterrupts = this.#allPendingInterrupts.filter((item) => item.id !== res.interruptId);
                if (!gate) {
                    missingGateKind = res.interruptId.startsWith("int:") ? "interaction" : "proposal";
                    continue;
                }
                this.#gateResolvers.delete(res.interruptId);
                this.#submittedGateIds.add(res.interruptId);
                if (gate.kind === "proposal") {
                    if (res.status === "cancelled") {
                        gate.resolve({ outcome: { outcome: "cancelled" } });
                    } else {
                        const payload = isRecord(res.payload) ? res.payload : {};
                        const decision = payload.decision === "reject" ? "reject" : "accept";
                        const scope = payload.scope === "always" ? "always" : "once";
                        const targetKind = `${decision === "accept" ? "allow" : "reject"}_${scope}`;
                        const matched = gate.options?.find((opt) => opt.kind === targetKind || opt.optionId === targetKind);
                        const optionId = typeof matched?.optionId === "string" ? matched.optionId : targetKind;
                        gate.resolve({
                            outcome: {
                                outcome: "selected",
                                optionId,
                            },
                        });
                    }
                } else {
                    if (res.status === "cancelled") {
                        gate.resolve({ action: "cancel" });
                    } else if (
                        isRecord(res.payload)
                        && (res.payload.action === "accept" || res.payload.action === "decline" || res.payload.action === "cancel")
                        && (gate.toolName === "mcp_input_required" || gate.mode === "url")
                    ) {
                        gate.resolve(res.payload);
                    } else {
                        gate.resolve({
                            action: "accept",
                            content: isRecord(res.payload) ? res.payload : { value: res.payload },
                        });
                    }
                }
            }

            const gatesChanged = this.#syncPendingInterrupts();

            if (missingGateKind !== undefined) {
                const isInteraction = missingGateKind === "interaction";
                const problem = {
                    type: isInteraction
                        ? "https://problems.plurnk.xyz/interaction/resolution/interaction-not-pending"
                        : "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending",
                    title: isInteraction ? "Interaction not pending" : "Proposal not pending",
                    status: 409,
                    detail: isInteraction ? "Interaction is no longer pending." : "Proposal is no longer pending.",
                };
                await subscriber.onError?.({
                    message: problem.detail,
                    status: 409,
                    problem,
                });
            }

            if (this.#inFlightRequest !== undefined) {
                return await this.#awaitRequestOrInterrupt(this.#inFlightRequest, signal, subscriber);
            }

            const boundLifecycle = typeof statusState?.lifecycle === "string" ? statusState.lifecycle : "idle";
            if (
                (resolvedDescendantOnly && !["queued", "running", "parked"].includes(boundLifecycle))
                || this.pendingInterrupts.length > 0
            ) {
                await new Promise((r) => setTimeout(r));
                await this.#outboundPostChain;
                await this.#drainNotifications();
                if (gatesChanged && !this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
                if (this.#cancelledSubmittedGates.size > 0 && missingGateKind === undefined) {
                    const firstId = [...this.#cancelledSubmittedGates][0] ?? "";
                    const isInteraction = firstId.startsWith("int:");
                    const problem = {
                        type: isInteraction
                            ? "https://problems.plurnk.xyz/interaction/resolution/interaction-not-pending"
                            : "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending",
                        title: isInteraction ? "Interaction not pending" : "Proposal not pending",
                        status: 409,
                        detail: isInteraction ? "Interaction is no longer pending." : "Proposal is no longer pending.",
                    };
                    await subscriber.onError?.({
                        message: problem.detail,
                        status: 409,
                        problem,
                    });
                }
                const nextStop = this.pendingInterrupts.length > 0 ? "interrupt" : "end_turn";
                if (nextStop !== "interrupt") {
                    this.close();
                }
                await subscriber.onSettled?.({ stopReason: nextStop, result: {} });
                return { result: {}, stopReason: nextStop };
            }

            const outcome = await this.#waitForLiveOutcome(signal);
            await this.#outboundPostChain;
            await this.#drainNotifications();
            if (outcome.error) {
                this.close();
                await subscriber.onError?.(outcome.error);
                return { result: undefined, stopReason: "error", meta: outcome.meta };
            }
            if (outcome.stopReason === "eof") {
                this.close();
                return { result: {}, stopReason: "end_turn", meta: outcome.meta };
            }
            if (this.#cancelledSubmittedGates.size > 0 && missingGateKind === undefined) {
                const firstId = [...this.#cancelledSubmittedGates][0] ?? "";
                const isInteraction = firstId.startsWith("int:");
                const problem = {
                    type: isInteraction
                        ? "https://problems.plurnk.xyz/interaction/resolution/interaction-not-pending"
                        : "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending",
                    title: isInteraction ? "Interaction not pending" : "Proposal not pending",
                    status: 409,
                    detail: isInteraction ? "Interaction is no longer pending." : "Proposal is no longer pending.",
                };
                await subscriber.onError?.({
                    message: problem.detail,
                    status: 409,
                    problem,
                });
            }
            const stopReason = outcome.stopReason;
            if (stopReason !== "interrupt") {
                this.close();
            }
            const metaPlurnk = outcome.meta;
            const terminalResult = isRecord(metaPlurnk?.terminal) && isRecord(metaPlurnk.terminal.result)
                ? metaPlurnk.terminal.result
                : isRecord(metaPlurnk?.result)
                    ? metaPlurnk.result
                    : undefined;
            const failedTerminal = typeof terminalResult?.status === "number"
                && terminalResult.status >= 400
                && terminalResult.status !== 499;
            if (failedTerminal || stopReason === "error" || stopReason === "refusal") {
                const problem = isRecord(terminalResult?.problem) ? terminalResult.problem : terminalResult;
                const message = typeof problem?.detail === "string"
                    ? problem.detail
                    : typeof problem?.title === "string"
                        ? problem.title
                        : "Session loop failed.";
                await subscriber.onError?.({
                    message,
                    status: typeof terminalResult?.status === "number" ? terminalResult.status : undefined,
                    problem,
                    terminal: metaPlurnk?.terminal ?? terminalResult,
                });
            } else {
                await subscriber.onSettled?.({ stopReason, meta: outcome.meta, result: {} });
            }
            return { result: {}, stopReason, meta: outcome.meta };
        } catch (error) {
            return await this.#handleError(error, signal, subscriber);
        } finally {
            this.isRunning = false;
            if (this.#activeController === controller) {
                this.#activeController = undefined;
            }
        }
    }

    /**
     * @param {Promise<{ result: unknown, meta?: Record<string, unknown> }>} requestPromise
     * @param {AbortSignal} signal
     * @param {SessionSubscriber} subscriber
     */
    async #awaitRequestOrInterrupt(requestPromise, signal, subscriber) {
        const outcomePromise = this.#waitForLiveOutcome(signal);
        const raced = await Promise.race([
            requestPromise.then((res) => ({ kind: /** @type {const} */ ("response"), ...res })),
            outcomePromise.then((out) => ({ kind: /** @type {const} */ ("outcome"), ...out })),
        ]);

        if (raced.kind === "outcome") {
            void requestPromise.catch(() => undefined);
            this.#onLiveOutcome = undefined;
            if (raced.error) {
                this.close();
                await subscriber.onError?.(raced.error);
                return { result: undefined, stopReason: "error", meta: raced.meta };
            }
            if (raced.stopReason === "interrupt") {
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: raced.meta, result: {} });
                return { result: {}, stopReason: "interrupt", meta: raced.meta };
            }
            if (raced.stopReason === "eof") {
                this.close();
                return { result: undefined, stopReason: "end_turn", meta: raced.meta };
            }
        }

        const { result, meta: initialMeta } = raced.kind === "response"
            ? raced
            : await requestPromise;
        await this.#drainNotifications();
        const rawResult = isRecord(result) ? result : {};
        let metaPlurnk = initialMeta;
        this.#applyResponseState(rawResult, metaPlurnk);
        if (Object.keys(this.state).length > 0) {
            await subscriber.onStateChanged?.({ state: this.state });
        }

        if (this.#gateCoalesceTimer !== undefined) {
            await new Promise((r) => {
                this.#onGateSettled = () => {
                    this.#onGateSettled = undefined;
                    r(undefined);
                };
            });
        }

        /** @type {Awaited<typeof outcomePromise> | undefined} */
        let liveOutcome = raced.kind === "outcome" ? raced : undefined;
        const hasImmediateOutcome = typeof rawResult.stopReason === "string"
            || typeof metaPlurnk?.stopReason === "string"
            || metaPlurnk?.terminal !== undefined
            || this.pendingInterrupts.length > 0;
        if (liveOutcome === undefined && !hasImmediateOutcome) {
            liveOutcome = await outcomePromise;
        }
        this.#onLiveOutcome = undefined;

        if (liveOutcome !== undefined) {
            if (liveOutcome.error) {
                this.close();
                await subscriber.onError?.(liveOutcome.error);
                return { result: undefined, stopReason: "error", meta: liveOutcome.meta };
            }
            if (liveOutcome.meta) {
                metaPlurnk = metaPlurnk ? { ...metaPlurnk, ...liveOutcome.meta } : liveOutcome.meta;
                this.#applyResponseState(rawResult, metaPlurnk);
                if (Object.keys(this.state).length > 0) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
        }

        if (this.#cancelledSubmittedGates.size > 0) {
            const firstId = [...this.#cancelledSubmittedGates][0] ?? "";
            const isInteraction = firstId.startsWith("int:");
            const problem = {
                type: isInteraction
                    ? "https://problems.plurnk.xyz/interaction/resolution/interaction-not-pending"
                    : "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending",
                title: isInteraction ? "Interaction not pending" : "Proposal not pending",
                status: 409,
                detail: isInteraction ? "Interaction is no longer pending." : "Proposal is no longer pending.",
            };
            await subscriber.onError?.({
                message: problem.detail,
                status: 409,
                problem,
            });
        }

        if (liveOutcome?.stopReason === "eof" && !hasImmediateOutcome) {
            this.close();
            return { result: rawResult, stopReason: "end_turn", meta: metaPlurnk };
        }
        const rawStopReason = this.pendingInterrupts.length > 0
            ? "interrupt"
            : typeof liveOutcome?.stopReason === "string"
                ? liveOutcome.stopReason
                : typeof metaPlurnk?.stopReason === "string"
                    ? metaPlurnk.stopReason
                    : typeof rawResult.stopReason === "string"
                        ? rawResult.stopReason
                        : "end_turn";
        const stopReason = rawStopReason === "eof" ? "end_turn" : rawStopReason;
        if (stopReason !== "interrupt") {
            this.close();
        }
        const terminalResult = isRecord(metaPlurnk?.terminal) && isRecord(metaPlurnk.terminal.result)
            ? metaPlurnk.terminal.result
            : isRecord(metaPlurnk?.result)
                ? metaPlurnk.result
                : undefined;
        const failedTerminal = typeof terminalResult?.status === "number"
            && terminalResult.status >= 400
            && terminalResult.status !== 499;
        if (failedTerminal || stopReason === "error" || stopReason === "refusal") {
            const problem = isRecord(terminalResult?.problem) ? terminalResult.problem : terminalResult;
            const message = typeof problem?.detail === "string"
                ? problem.detail
                : typeof problem?.title === "string"
                    ? problem.title
                    : "Session loop failed.";
            await subscriber.onError?.({
                message,
                status: typeof terminalResult?.status === "number" ? terminalResult.status : undefined,
                problem,
                terminal: metaPlurnk?.terminal ?? terminalResult,
            });
        } else {
            await subscriber.onSettled?.({
                stopReason,
                meta: metaPlurnk,
                result: rawResult,
            });
        }
        return { result: rawResult, stopReason, meta: metaPlurnk };
    }

    /**
     * @param {AbortSignal} signal
     * @returns {Promise<{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown } }>}
     */
    #waitForLiveOutcome(signal) {
        if (this.#queuedLiveOutcome !== undefined) {
            const outcome = this.#queuedLiveOutcome;
            this.#queuedLiveOutcome = undefined;
            if (outcome.transportError !== undefined) {
                return Promise.reject(outcome.transportError);
            }
            return Promise.resolve(outcome);
        }
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                if (this.#onLiveOutcome === settle) {
                    this.#onLiveOutcome = undefined;
                }
                reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : new DOMException("The operation was aborted.", "AbortError"),
                );
            };
            /** @param {{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown }, transportError?: Error }} outcome */
            const settle = (outcome) => {
                signal.onabort = null;
                if (this.#onLiveOutcome === settle) {
                    this.#onLiveOutcome = undefined;
                }
                if (outcome.transportError !== undefined) {
                    reject(outcome.transportError);
                    return;
                }
                resolve(outcome);
            };
            this.#onLiveOutcome = settle;
            signal.onabort = onAbort;
            if (signal.aborted) {
                onAbort();
            }
        });
    }

    /**
     * @param {Record<string, unknown>} rawResult
     * @param {Record<string, unknown> | undefined} metaPlurnk
     */
    #applyResponseState(rawResult, metaPlurnk) {
        const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
        if (Array.isArray(rawResult.configOptions)) {
            prevPlurnk.configOptions = structuredClone(rawResult.configOptions);
        }
        if (Array.isArray(rawResult.availableCommands)) {
            prevPlurnk.availableCommands = structuredClone(rawResult.availableCommands);
        }
        if (metaPlurnk) {
            const {
                stopReason: _stopReason,
                terminal: _terminal,
                result: _result,
                history: _history,
                action: _action,
                proposal: _proposal,
                interaction: _interaction,
                budget,
                status,
                workspace,
                ...rest
            } = metaPlurnk;
            Object.assign(prevPlurnk, structuredClone(rest));
            if (isRecord(status)) {
                const normalizedStatus = structuredClone(status);
                for (const field of ["claimedAt", "terminatedAt"]) {
                    if (typeof normalizedStatus[field] === "string") {
                        const raw = normalizedStatus[field];
                        const parsed = Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
                        normalizedStatus[field] = Number.isFinite(parsed) ? parsed : null;
                    }
                }
                prevPlurnk.status = {
                    ...(isRecord(prevPlurnk.status) ? prevPlurnk.status : {}),
                    ...normalizedStatus,
                };
            }
            if (isRecord(workspace)) {
                prevPlurnk.workspace = {
                    ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
                    ...structuredClone(workspace),
                };
            }
            this.state = {
                ...this.state,
                plurnk: prevPlurnk,
                ...(budget !== undefined ? { budget: structuredClone(budget) } : {}),
            };
        } else if (Array.isArray(rawResult.configOptions) || Array.isArray(rawResult.availableCommands)) {
            this.state = {
                ...this.state,
                plurnk: prevPlurnk,
            };
        }
    }

    /**
     * @param {unknown} error
     * @param {AbortSignal} signal
     * @param {SessionSubscriber} subscriber
     * @param {string} [actionKind]
     */
    async #handleError(error, signal, subscriber, actionKind) {
        if (signal.aborted && this.#streamProblem === undefined) {
            if (this.pendingInterrupts.length === 0) {
                this.close();
            }
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError");
        }
        await this.#drainNotifications();
        if (signal.aborted && this.#streamProblem === undefined) {
            if (this.pendingInterrupts.length === 0) {
                this.close();
            }
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError");
        }
        if (this.#streamProblem === undefined && error instanceof Error && error.message === "ACP session SSE stream closed") {
            this.close();
            return { result: undefined, stopReason: "end_turn" };
        }
        if (this.#streamProblem !== undefined) {
            const sp = this.#streamProblem;
            this.#streamProblem = undefined;
            if (sp.status === 401) {
                throw Object.assign(new Error(sp.message, { cause: sp.problem }), {
                    status: 401,
                    problem: sp.problem,
                });
            }
            if (sp.problem !== undefined) {
                await subscriber.onError?.(sp);
                const errorResult = actionKind !== undefined
                    ? { kind: actionKind, ok: false, problem: sp.problem }
                    : undefined;
                return { result: errorResult, stopReason: "error" };
            }
            throw Object.assign(new Error(sp.message), { status: sp.status });
        }
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
        if (status === 401) {
            throw Object.assign(new Error(message, { cause: problem }), { status: 401, problem });
        }
        if (problem !== undefined || terminal !== undefined) {
            await subscriber.onError?.({ message, status, problem, terminal });
            const errorResult = actionKind !== undefined && problem !== undefined
                ? { kind: actionKind, ok: false, problem }
                : undefined;
            return { result: errorResult, stopReason: "error" };
        }
        throw error;
    }

    /**
     * @param {SessionSubscriber} subscriber
     */
    async #finalizeLiveThought(subscriber) {
        const pending = this.#pendingLiveThought;
        if (!pending) return;
        this.#pendingLiveThought = undefined;
        const found = this.messages.find((m) => m.id === pending.messageId && m.role === "reasoning");
        if (!found || (isRecord(found.metadata?.plurnk) && found.metadata.plurnk.body !== undefined)) {
            return;
        }
        const plurnkState = isRecord(this.state.plurnk) ? this.state.plurnk : undefined;
        const ws = isRecord(plurnkState?.workspace) ? plurnkState.workspace : undefined;
        const st = isRecord(plurnkState?.status) ? plurnkState.status : undefined;
        const rawParts = typeof this.sessionId === "string" ? this.sessionId.split("#") : [];
        const workspaceId = typeof ws?.id === "number"
            ? String(ws.id)
            : typeof plurnkState?.workspaceId === "number"
                ? String(plurnkState.workspaceId)
                : (rawParts[0] || "1");
        const numericSessionId = typeof st?.id === "number"
            ? String(st.id)
            : typeof plurnkState?.sessionId === "number"
                ? String(plurnkState.sessionId)
                : isRecord(plurnkState?.session) && typeof plurnkState.session.id === "number"
                    ? String(plurnkState.session.id)
                    : (rawParts[1] && /^[1-9]\d*$/u.test(rawParts[1]) ? rawParts[1] : "1");
        const sessionName = typeof st?.name === "string" ? st.name : (rawParts[1] || "user");
        const target = `reasoning://${sessionName}/${pending.coordinate}`;
        const body = {
            url: `/acp/${encodeURIComponent(workspaceId)}/${encodeURIComponent(numericSessionId)}/entry?target=${encodeURIComponent(target)}`,
            mimeType: "text/plain",
        };
        found.metadata = {
            ...found.metadata,
            plurnk: {
                ...(isRecord(found.metadata?.plurnk) ? found.metadata.plurnk : {}),
                coordinate: pending.coordinate,
                body,
            },
        };
        await subscriber.onMessagesChanged?.({ messages: this.messages });
    }

    /**
     * @param {AcpSessionUpdatePayload} update
     * @param {SessionSubscriber} subscriber
     */
    async #applyLiveMessageUpdate(update, subscriber) {
        const kind = update.sessionUpdate;
        const plurnk = isRecord(update._meta) && isRecord(update._meta.plurnk)
            ? update._meta.plurnk
            : undefined;
        if (kind === "user_message_chunk" && typeof update.messageId === "string") {
            await subscriber.onUserMessage?.({ messageId: update.messageId });
        }
        if (kind === "agent_thought_chunk") {
            const id = typeof update.messageId === "string" && update.messageId.length > 0
                ? update.messageId
                : typeof plurnk?.coordinate === "string"
                    ? `${plurnk.coordinate}/reasoning`
                    : "";
            if (this.#pendingLiveThought && this.#pendingLiveThought.messageId !== id) {
                await this.#finalizeLiveThought(subscriber);
            }
            const hasExplicitBody = (isRecord(update.content) && update.content.type === "resource_link")
                || plurnk?.body !== undefined;
            if (hasExplicitBody) {
                this.#pendingLiveThought = undefined;
            } else if (id && typeof plurnk?.coordinate === "string") {
                this.#pendingLiveThought = { messageId: id, coordinate: plurnk.coordinate };
            }
            if (
                isRecord(update.content)
                && update.content.type === "text"
                && typeof update.content.text === "string"
                && update.content.text.length > 0
                && !hasExplicitBody
            ) {
                await subscriber.onThoughtChunk?.({ update });
            }
        } else if (
            kind === "agent_message_chunk"
            || kind === "tool_call"
            || kind === "tool_call_update"
        ) {
            await this.#finalizeLiveThought(subscriber);
        }
        this.messages = SessionTranslator.projectMessages([update], this.messages);
        await subscriber.onMessagesChanged?.({ messages: this.messages });
    }

    /**
     * @param {string} sessionId
     * @param {AcpSessionUpdatePayload} update
     * @param {SessionSubscriber} subscriber
     */
    async #handleSessionUpdate(sessionId, update, subscriber) {
        await subscriber.onSessionUpdate?.({ update, sessionId });
        const kind = update.sessionUpdate;
        const plurnk = isRecord(update._meta) && isRecord(update._meta.plurnk)
            ? update._meta.plurnk
            : undefined;

        if (kind === "config_option_update") {
            const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
            if (Array.isArray(update.configOptions)) {
                prevPlurnk.configOptions = structuredClone(update.configOptions);
            }
            if (plurnk) {
                const { budget, status, workspace, ...rest } = structuredClone(plurnk);
                Object.assign(prevPlurnk, rest);
                if (isRecord(status)) {
                    prevPlurnk.status = {
                        ...(isRecord(prevPlurnk.status) ? prevPlurnk.status : {}),
                        ...status,
                    };
                }
                if (isRecord(workspace)) {
                    prevPlurnk.workspace = {
                        ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
                        ...workspace,
                    };
                }
                this.state = {
                    ...this.state,
                    plurnk: prevPlurnk,
                    ...(budget !== undefined ? { budget } : {}),
                };
            } else {
                this.state = {
                    ...this.state,
                    plurnk: prevPlurnk,
                };
            }
            if (!this.#bufferingReplay) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            return;
        }

        if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
            const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
            prevPlurnk.availableCommands = structuredClone(update.availableCommands);
            this.state = {
                ...this.state,
                plurnk: prevPlurnk,
            };
            if (!this.#bufferingReplay) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            return;
        }

        if (kind === "usage_update") {
            const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
            const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
            if (plurnk) {
                if (isRecord(plurnk.status)) {
                    Object.assign(prevStatus, structuredClone(plurnk.status));
                }
                if (isRecord(plurnk.workspace)) {
                    prevPlurnk.workspace = {
                        ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
                        ...structuredClone(plurnk.workspace),
                    };
                }
            }
            if (Object.keys(prevStatus).length > 0) {
                prevPlurnk.status = prevStatus;
            }
            const budget = isRecord(plurnk?.budget)
                ? structuredClone(plurnk.budget)
                : typeof update.used === "number" && typeof update.size === "number"
                    ? {
                        ...(isRecord(this.state.budget) ? this.state.budget : {}),
                        contextTokens: update.used,
                        contextCapacity: update.size,
                    }
                    : undefined;
            this.state = {
                ...this.state,
                plurnk: prevPlurnk,
                ...(budget !== undefined ? { budget } : {}),
            };
            if (!this.#bufferingReplay) {
                await subscriber.onStateChanged?.({ state: this.state });
            }
            return;
        }

        if (kind === "subagent_update") {
            const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
            const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
            const descendants = Array.isArray(prevStatus.descendants)
                ? prevStatus.descendants.map((d) => structuredClone(d))
                : [];
            const childId = typeof plurnk?.id === "number" ? plurnk.id : undefined;
            const childName = typeof plurnk?.name === "string"
                ? plurnk.name
                : typeof update.title === "string"
                    ? update.title
                    : undefined;
            const stateObj = isRecord(update.state) ? update.state : {};
            const rawLifecycle = typeof plurnk?.lifecycle === "string"
                ? plurnk.lifecycle
                : stateObj.state === "running"
                    ? "running"
                    : stateObj.state === "requires_action"
                        ? "running"
                        : stateObj.stopReason === "cancelled"
                            ? "cancelled"
                            : stateObj.stopReason === "refusal" || stateObj.stopReason === "error"
                                ? "failed"
                                : "completed";
            if (childId !== undefined && childName !== undefined) {
                const idx = descendants.findIndex((d) => isRecord(d) && (d.id === childId || d.name === childName));
                const nextEntry = {
                    ...(idx !== -1 && isRecord(descendants[idx]) ? descendants[idx] : {}),
                    id: childId,
                    name: childName,
                    parentSessionId: typeof plurnk?.parentSessionId === "number" ? plurnk.parentSessionId : null,
                    kind: typeof plurnk?.kind === "string" ? plurnk.kind : "session",
                    lifecycle: rawLifecycle,
                    gates: Array.isArray(plurnk?.gates)
                        ? structuredClone(plurnk.gates)
                        : (idx !== -1 && isRecord(descendants[idx]) && Array.isArray(descendants[idx].gates)
                            ? descendants[idx].gates
                            : []),
                };
                if (idx === -1) descendants.push(nextEntry);
                else descendants[idx] = nextEntry;
                prevStatus.descendants = descendants;
                prevPlurnk.status = prevStatus;
                this.state = {
                    ...this.state,
                    plurnk: prevPlurnk,
                };
                this.#syncDescendantGates();
                if (!this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
            return;
        }

        if (kind === "state_update") {
            if (
                (update.state === "running" || update.state === "idle")
                && this.#inFlightPostCount > 0
                && this.#submittedGateIds.size > 0
            ) {
                for (const id of this.#submittedGateIds) {
                    this.#cancelledSubmittedGates.add(id);
                }
            }
            await this.#finalizeLiveThought(subscriber);
            const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
            const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
            if (isRecord(plurnk?.status)) {
                Object.assign(prevStatus, structuredClone(plurnk.status));
            }
            if (update.state === "running" && prevStatus.lifecycle !== "queued") {
                prevStatus.lifecycle = "running";
                prevStatus.waitUntil = null;
            } else if (update.state === "idle" && isRecord(plurnk?.terminal)) {
                const termStatus = typeof plurnk.terminal.status === "number" ? plurnk.terminal.status : 200;
                prevStatus.lifecycle = termStatus === 499 ? "cancelled" : termStatus >= 400 ? "failed" : "completed";
                prevStatus.waitUntil = null;
            }
            if (Object.keys(prevStatus).length > 0) {
                prevPlurnk.status = prevStatus;
                this.state = {
                    ...this.state,
                    plurnk: prevPlurnk,
                };
                if (!this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
            if (update.state === "requires_action" && !this.#bufferingReplay) {
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: plurnk, result: {} });
            }
            if (update.state === "idle" && isRecord(plurnk?.terminal)) {
                const stopReason = typeof update.stopReason === "string" ? update.stopReason : "end_turn";
                const termResult = isRecord(plurnk.terminal.result) ? plurnk.terminal.result : undefined;
                const termStatus = typeof termResult?.status === "number" ? termResult.status : 200;
                if (termStatus >= 400 && termStatus !== 499) {
                    const problem = isRecord(termResult?.problem) ? termResult.problem : termResult;
                    const message = typeof problem?.detail === "string"
                        ? problem.detail
                        : typeof problem?.title === "string"
                            ? problem.title
                            : "Session loop failed.";
                    this.#emitLiveOutcome({
                        stopReason: "error",
                        meta: plurnk,
                        error: {
                            message,
                            status: termStatus,
                            problem,
                            terminal: plurnk.terminal,
                        },
                    });
                } else {
                    this.#emitLiveOutcome({
                        stopReason,
                        meta: plurnk,
                    });
                }
            }
            return;
        }

        if (kind === "notice") {
            const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
            const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
            const notice = isRecord(plurnk?.notice) ? plurnk.notice : undefined;
            if (notice?.kind === "turn_generated") {
                await this.#finalizeLiveThought(subscriber);
            }
            let stateChanged = false;

            if (notice?.source === "engine:lifecycle" && notice.kind === "loop_status") {
                const code = typeof notice.status === "number" ? notice.status : 102;
                prevStatus.lifecycle = code === 100 ? "queued" : code === 202 ? "parked" : "running";
                if (typeof notice.loopSeq === "number") prevStatus.loopSeq = notice.loopSeq;
                if (typeof notice.packetCount === "number") prevStatus.packetCount = notice.packetCount;
                if (notice.waitUntil === null || typeof notice.waitUntil === "number") {
                    prevStatus.waitUntil = notice.waitUntil;
                }
                if (notice.claimedAt === null || typeof notice.claimedAt === "number") {
                    prevStatus.claimedAt = notice.claimedAt;
                }
                prevStatus.terminatedAt = null;
                prevPlurnk.status = prevStatus;
                stateChanged = true;
            }
            if (notice?.source === "engine:derivation" && notice.kind === "search_progress") {
                const ws = isRecord(prevPlurnk.workspace) ? { ...prevPlurnk.workspace } : {};
                ws.activity = notice.phase === "complete"
                    ? null
                    : {
                        kind: "derivation",
                        phase: notice.phase,
                        ...(typeof notice.completed === "number" ? { completed: notice.completed } : {}),
                        ...(typeof notice.total === "number" ? { total: notice.total } : {}),
                        ...(typeof notice.percent === "number" ? { percent: notice.percent } : {}),
                        ...(typeof notice.message === "string" ? { message: notice.message } : {}),
                    };
                prevPlurnk.workspace = ws;
                stateChanged = true;
            }
            if (isRecord(plurnk?.status)) {
                Object.assign(prevStatus, structuredClone(plurnk.status));
                prevPlurnk.status = prevStatus;
                stateChanged = true;
            }
            if (isRecord(plurnk?.workspace)) {
                prevPlurnk.workspace = {
                    ...(isRecord(prevPlurnk.workspace) ? prevPlurnk.workspace : {}),
                    ...structuredClone(plurnk.workspace),
                };
                stateChanged = true;
            }
            if (Array.isArray(plurnk?.preparation) && isRecord(prevPlurnk.workspace)) {
                prevPlurnk.workspace = {
                    ...prevPlurnk.workspace,
                    preparation: structuredClone(plurnk.preparation),
                };
                stateChanged = true;
            }
            if (stateChanged) {
                this.state = {
                    ...this.state,
                    plurnk: prevPlurnk,
                };
                if (!this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
            if (update.severity === "error" && isRecord(plurnk?.problem)) {
                const problem = plurnk.problem;
                const status = typeof problem.status === "number" ? problem.status : undefined;
                const message = typeof problem.detail === "string"
                    ? problem.detail
                    : typeof problem.title === "string"
                        ? problem.title
                        : "Stream error.";
                if (!this.#bufferingReplay) {
                    this.#streamProblem = { message, status, problem };
                }
                if (status === 401 || this.#submittedGateIds.size > 0) {
                    this.#streamProblem = { message, status, problem };
                    this.#emitLiveOutcome({
                        stopReason: "error",
                        error: { message, status, problem },
                    });
                }
            }
            return;
        }

        if (kind === "terminal_update") {
            const prevPlurnk = isRecord(this.state.plurnk) ? { ...this.state.plurnk } : {};
            const prevStatus = isRecord(prevPlurnk.status) ? { ...prevPlurnk.status } : {};
            const streams = Array.isArray(prevStatus.streams)
                ? prevStatus.streams.map((s) => structuredClone(s))
                : [];
            const entryId = typeof plurnk?.entryId === "number" ? plurnk.entryId : undefined;
            const target = typeof plurnk?.target === "string" ? plurnk.target : undefined;
            if (entryId !== undefined && target !== undefined) {
                if (isRecord(update.exitStatus)) {
                    prevStatus.streams = streams.filter((s) => !(isRecord(s) && s.entryId === entryId));
                } else {
                    const idx = streams.findIndex((s) => isRecord(s) && s.entryId === entryId);
                    const chName = typeof plurnk?.channel === "string" ? plurnk.channel : "stdout";
                    const chState = typeof plurnk?.state === "string" ? plurnk.state : "open";
                    const chMime = typeof plurnk?.mimetype === "string" ? plurnk.mimetype : "text/plain";
                    if (idx === -1) {
                        streams.push({
                            entryId,
                            sessionId: typeof plurnk?.sessionId === "number" ? plurnk.sessionId : 1,
                            target,
                            lifetime: "turn",
                            ...(typeof plurnk?.loop_seq === "number" ? { loop_seq: plurnk.loop_seq } : {}),
                            ...(typeof plurnk?.turn_seq === "number" ? { turn_seq: plurnk.turn_seq } : {}),
                            ...(typeof plurnk?.sequence === "number" ? { sequence: plurnk.sequence } : {}),
                            channels: [{ channel: chName, state: chState, mimetype: chMime }],
                        });
                    } else if (isRecord(streams[idx])) {
                        const existingChannels = Array.isArray(streams[idx].channels) ? [...streams[idx].channels] : [];
                        const cIdx = existingChannels.findIndex((c) => isRecord(c) && c.channel === chName);
                        const chEntry = { channel: chName, state: chState, mimetype: chMime };
                        if (cIdx === -1) existingChannels.push(chEntry);
                        else existingChannels[cIdx] = chEntry;
                        streams[idx] = { ...streams[idx], channels: existingChannels };
                    }
                    prevStatus.streams = streams;
                }
                prevPlurnk.status = prevStatus;
                this.state = {
                    ...this.state,
                    plurnk: prevPlurnk,
                };
                if (!this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
            }
            return;
        }

        if (
            kind === "user_message_chunk"
            || kind === "agent_message_chunk"
            || kind === "agent_thought_chunk"
            || kind === "tool_call"
            || kind === "tool_call_update"
        ) {
            if (this.#bufferingReplay) {
                this.#replayUpdates.push(update);
                return;
            }
            if (kind === "tool_call_update" && (plurnk?.proposal !== undefined || plurnk?.interaction !== undefined)) {
                await subscriber.onSettled?.({ stopReason: "interrupt", meta: plurnk, result: {} });
            }
            await this.#applyLiveMessageUpdate(update, subscriber);
        }
    }
}
