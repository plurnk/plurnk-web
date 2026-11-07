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
 *   toolCallId: string,
 *   name: string,
 *   title?: string,
 *   kind?: string,
 *   status?: string,
 *   rawInput?: unknown,
 *   rawOutput?: unknown,
 *   locations?: readonly { path: string, line?: number | null }[],
 *   content?: readonly Record<string, unknown>[],
 *   _meta?: { plurnk?: Record<string, any> } | null,
 * }} ToolCall
 */

/**
 * @typedef {{
 *   type: "text",
 *   text: string,
 * } | {
 *   type: "resource_link",
 *   uri: string,
 *   name?: string,
 *   mimeType?: string,
 * }} MessagePart
 */

/**
 * @typedef {{
 *   id: string,
 *   content?: string | readonly MessagePart[],
 *   name?: string,
 *   subagentRunId?: string,
 *   _meta?: { plurnk?: Record<string, any> } | null,
 * } & (
 *   | { role: "tool", toolCallId: string, rawOutput?: unknown, error?: string }
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
 *   method: "session/request_permission",
 *   sessionId?: string,
 *   toolCall?: Record<string, unknown>,
 *   options?: readonly Record<string, unknown>[],
 *   expiresAt?: string,
 *   _meta?: {
 *     plurnk?: {
 *       proposal?: import("@plurnk/plurnk-contracts").ProposalProjection,
 *     },
 *   } | null,
 * }} PermissionGate
 */

/**
 * @typedef {{
 *   id: string,
 *   method: "elicitation/create",
 *   sessionId?: string,
 *   mode?: "form" | "url",
 *   message?: string,
 *   requestedSchema?: Record<string, unknown>,
 *   url?: string,
 *   elicitationId?: string,
 *   expiresAt?: string,
 *   _meta?: {
 *     plurnk?: {
 *       interaction?: import("@plurnk/plurnk-contracts").ClientInteractionProjection,
 *       toolName?: string,
 *       arguments?: unknown,
 *     },
 *   } | null,
 * }} ElicitationGate
 */

/**
 * @typedef {PermissionGate | ElicitationGate} SessionGate
 */

/**
 * @typedef {{
 *   id: string,
 *   method: "session/request_permission",
 *   response: {
 *     outcome: { outcome: "selected", optionId: string } | { outcome: "cancelled" },
 *     _meta?: Record<string, unknown>,
 *   },
 * } | {
 *   id: string,
 *   method: "elicitation/create",
 *   response: {
 *     action: "accept",
 *     content?: Record<string, unknown>,
 *   } | {
 *     action: "decline" | "cancel",
 *   },
 * }} GateResolution
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
 *   onError?: (args: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown, settled?: boolean }) => void | Promise<void>,
 * }} SessionSubscriber
 */

/**
 * @typedef {{
 *   abortController?: AbortController,
 *   message?: { id: string, role: "user", content: string },
 *   resolutions?: readonly GateResolution[],
 *   action?: Record<string, unknown>,
 *   workspace?: string,
 *   projectRoot?: string,
 *   gates?: readonly string[],
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
            type: "resource_link",
            uri: content.uri,
            ...(typeof content.name === "string" ? { name: content.name } : {}),
            mimeType: typeof content.mimeType === "string" ? content.mimeType : defaultMime,
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
                        type: "resource_link",
                        uri: inner.uri,
                        ...(typeof inner.name === "string" ? { name: inner.name } : {}),
                        mimeType: typeof inner.mimeType === "string" ? inner.mimeType : "text/plain",
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

/**
 * @param {Message} item
 * @returns {number | undefined}
 */
function loopIdOf(item) {
    const p = item._meta?.plurnk;
    if (typeof p?.loopId === "number") return p.loopId;
    if (item.role === "assistant" && Array.isArray(item.toolCalls) && item.toolCalls.length > 0) {
        const cp = item.toolCalls[0]._meta?.plurnk;
        if (typeof cp?.loopId === "number") return cp.loopId;
    }
    return undefined;
}

/**
 * @param {Message[]} messages
 * @param {Message} item
 */
function insertMessage(messages, item) {
    const isUnobservedUser = item.role === "user" && item._meta?.plurnk?.published === false;
    if (isUnobservedUser) {
        const targetLoopId = loopIdOf(item);
        if (targetLoopId !== undefined) {
            const idx = messages.findIndex((m) => {
                const lid = loopIdOf(m);
                return lid !== undefined && lid > targetLoopId;
            });
            if (idx !== -1) {
                messages.splice(idx, 0, item);
                return;
            }
        }
        messages.push(item);
        return;
    }

    let itemLoopId = loopIdOf(item);
    if (itemLoopId === undefined && item.role === "tool") {
        const callMsg = messages.find(
            (m) => m.role === "assistant" && m.toolCalls?.some((c) => c.toolCallId === item.toolCallId),
        );
        if (callMsg) {
            itemLoopId = loopIdOf(callMsg);
        }
    }
    const unobservedIdx = messages.findIndex((m) => {
        if (m.role !== "user" || m._meta?.plurnk?.published !== false) return false;
        const uLid = loopIdOf(m);
        if (itemLoopId !== undefined && uLid !== undefined) {
            return uLid >= itemLoopId;
        }
        if (itemLoopId === undefined) {
            const lc = m._meta?.plurnk?.lifecycle;
            return lc === "running" || lc === "queued" || lc === "parked";
        }
        return false;
    });
    if (unobservedIdx !== -1) {
        messages.splice(unobservedIdx, 0, item);
    } else {
        messages.push(item);
    }
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
        const messages = [...existing];
        /** @type {Set<Message>} */
        const cloned = new Set();
        /**
         * @param {number} index
         * @returns {Message}
         */
        const cloneAt = (index) => {
            const current = messages[index];
            if (!cloned.has(current)) {
                const copy = structuredClone(current);
                cloned.add(copy);
                messages[index] = copy;
                return copy;
            }
            return current;
        };
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
                const foundIdx = messages.findIndex((m) => m.id === id && m.role === "user");
                if (foundIdx !== -1) {
                    const found = cloneAt(foundIdx);
                    const wasUnobserved = found._meta?.plurnk?.published === false;
                    const nowPublished = plurnk !== undefined
                        && plurnk.published !== false
                        && (plurnk.id !== undefined || plurnk.coordinate !== undefined);
                    if (Array.isArray(chunk)) {
                        found.content = chunk;
                    } else if (typeof found.content === "string") {
                        if (
                            (plurnk?.id !== undefined && found._meta?.plurnk?.id === plurnk.id)
                            || found.content === chunk
                            || found._meta?.plurnk === undefined
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
                        const nextPlurnk = {
                            ...(isRecord(found._meta?.plurnk) ? found._meta.plurnk : {}),
                            ...structuredClone(plurnk),
                        };
                        if (nowPublished) {
                            delete nextPlurnk.published;
                        }
                        found._meta = {
                            ...found._meta,
                            plurnk: nextPlurnk,
                        };
                    }
                    if (wasUnobserved && nowPublished) {
                        const oldIdx = messages.indexOf(found);
                        if (oldIdx !== -1) {
                            messages.splice(oldIdx, 1);
                            insertMessage(messages, found);
                        }
                    }
                } else {
                    /** @type {Message} */
                    const created = {
                        id,
                        role: "user",
                        content: chunk,
                        ...(subagentRunId ? { subagentRunId } : {}),
                        ...(plurnk ? { _meta: { plurnk: structuredClone(plurnk) } } : {}),
                    };
                    cloned.add(created);
                    insertMessage(messages, created);
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
                const foundIdx = messages.findIndex((m) => m.id === id && m.role === "assistant");
                if (foundIdx !== -1) {
                    const found = cloneAt(foundIdx);
                    if (Array.isArray(chunk)) {
                        found.content = chunk;
                    } else if (typeof found.content === "string") {
                        if (plurnk?.id !== undefined && found._meta?.plurnk?.id === plurnk.id) {
                            found.content = chunk;
                        } else {
                            found.content += chunk;
                        }
                    } else {
                        found.content = chunk;
                    }
                    if (subagentRunId) found.subagentRunId = subagentRunId;
                    if (plurnk) {
                        found._meta = {
                            ...found._meta,
                            plurnk: {
                                ...(isRecord(found._meta?.plurnk) ? found._meta.plurnk : {}),
                                ...structuredClone(plurnk),
                            },
                        };
                    }
                } else {
                    /** @type {Message} */
                    const created = {
                        id,
                        role: "assistant",
                        content: chunk,
                        ...(subagentRunId ? { subagentRunId } : {}),
                        ...(plurnk ? { _meta: { plurnk: structuredClone(plurnk) } } : {}),
                    };
                    cloned.add(created);
                    insertMessage(messages, created);
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
                const foundIdx = messages.findIndex((m) => m.id === id && m.role === "reasoning");
                if (foundIdx !== -1) {
                    const found = cloneAt(foundIdx);
                    if (subagentRunId) found.subagentRunId = subagentRunId;
                    if (mergedPlurnk) {
                        found._meta = {
                            ...found._meta,
                            plurnk: {
                                ...(isRecord(found._meta?.plurnk) ? found._meta.plurnk : {}),
                                ...mergedPlurnk,
                            },
                        };
                    }
                } else {
                    /** @type {Message} */
                    const created = {
                        id,
                        role: "reasoning",
                        content: "",
                        ...(subagentRunId ? { subagentRunId } : {}),
                        ...(mergedPlurnk ? { _meta: { plurnk: mergedPlurnk } } : {}),
                    };
                    cloned.add(created);
                    insertMessage(messages, created);
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

                if (toolCallId.startsWith("int:") || isRecord(plurnk?.interaction)) {
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
                    const obsContent = plurnk.op === "send" || plurnk.op === "done" || plurnk.op === "fail"
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
                    const foundObsIdx = messages.findIndex((m) => m.id === obsId);
                    if (foundObsIdx !== -1) {
                        const foundObs = cloneAt(foundObsIdx);
                        foundObs.content = obsContent;
                        if (foundObs.role === "tool" && update.rawOutput !== undefined) {
                            foundObs.rawOutput = structuredClone(update.rawOutput);
                        }
                        foundObs._meta = { plurnk: structuredClone(plurnk) };
                    } else {
                        /** @type {Message} */
                        const created = {
                            id: obsId,
                            role: "tool",
                            toolCallId,
                            content: obsContent,
                            ...(update.rawOutput !== undefined ? { rawOutput: structuredClone(update.rawOutput) } : {}),
                            ...(subagentRunId ? { subagentRunId } : {}),
                            _meta: { plurnk: structuredClone(plurnk) },
                        };
                        cloned.add(created);
                        insertMessage(messages, created);
                    }
                    continue;
                }

                if (
                    (typeof plurnk?.origin === "string" && plurnk.origin !== "model")
                    || plurnk?.op === null
                    || (isRecord(plurnk?.attrs) && plurnk.attrs.kind === "emissionAttempt")
                    || (plurnk?.op === "note" && isRecord(plurnk?.attrs) && typeof plurnk.attrs.distilled === "string" && plurnk.attrs.distilled.trim().length > 0)
                ) {
                    continue;
                }

                const callOwnerIdx = messages.findIndex(
                    (m) => m.role === "assistant" && m.toolCalls?.some((c) => c.toolCallId === toolCallId),
                );
                const existingCall = callOwnerIdx !== -1
                    ? (() => {
                        const owner = cloneAt(callOwnerIdx);
                        return owner.role === "assistant"
                            ? owner.toolCalls?.find((c) => c.toolCallId === toolCallId)
                            : undefined;
                    })()
                    : undefined;
                const hasCallDefinition =
                    kind === "tool_call"
                    || typeof update.name === "string"
                    || typeof plurnk?.op === "string"
                    || update.rawInput !== undefined;

                if (existingCall) {
                    if (typeof update.name === "string" && update.name.length > 0) {
                        existingCall.name = update.name;
                    } else if (typeof plurnk?.op === "string" && plurnk.op.length > 0) {
                        existingCall.name = plurnk.op;
                    }
                    if (typeof update.title === "string") existingCall.title = update.title;
                    if (typeof update.kind === "string") existingCall.kind = update.kind;
                    if (typeof update.status === "string") existingCall.status = update.status;
                    if (update.rawInput !== undefined) {
                        existingCall.rawInput = structuredClone(update.rawInput);
                    }
                    if (update.rawOutput !== undefined) {
                        existingCall.rawOutput = structuredClone(update.rawOutput);
                    }
                    if (Array.isArray(update.locations)) {
                        existingCall.locations = structuredClone(update.locations);
                    }
                    if (Array.isArray(update.content)) {
                        existingCall.content = structuredClone(update.content);
                    }
                    if (plurnk) {
                        const prevPlurnk = isRecord(existingCall._meta?.plurnk)
                            ? { ...existingCall._meta.plurnk }
                            : {};
                        if ((update.status === "completed" || update.status === "failed") && plurnk.proposal === undefined) {
                            delete prevPlurnk.proposal;
                        }
                        existingCall._meta = {
                            ...existingCall._meta,
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
                    const callPlurnk = plurnk ? structuredClone(plurnk) : {};
                    /** @type {Message} */
                    const created = {
                        id: typeof update.messageId === "string" && update.messageId.length > 0
                            ? update.messageId
                            : `call:${toolCallId}`,
                        role: "assistant",
                        content: "",
                        ...(subagentRunId ? { subagentRunId } : {}),
                        toolCalls: [{
                            toolCallId,
                            name,
                            ...(typeof update.title === "string" ? { title: update.title } : {}),
                            ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
                            ...(typeof update.status === "string" ? { status: update.status } : {}),
                            ...(update.rawInput !== undefined ? { rawInput: structuredClone(update.rawInput) } : {}),
                            ...(update.rawOutput !== undefined ? { rawOutput: structuredClone(update.rawOutput) } : {}),
                            ...(Array.isArray(update.locations) ? { locations: structuredClone(update.locations) } : {}),
                            ...(Array.isArray(update.content) ? { content: structuredClone(update.content) } : {}),
                            ...(Object.keys(callPlurnk).length > 0 ? { _meta: { plurnk: callPlurnk } } : {}),
                        }],
                    };
                    cloned.add(created);
                    insertMessage(messages, created);
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
                    const existingResultIdx = messages.findIndex((m) => m.id === resultId && m.role === "tool");
                    if (existingResultIdx !== -1) {
                        const existingResult = cloneAt(existingResultIdx);
                        if (existingResult.role === "tool") {
                            existingResult.content = resultContent;
                            if (update.rawOutput !== undefined) {
                                existingResult.rawOutput = structuredClone(update.rawOutput);
                            }
                        }
                    } else {
                        /** @type {Message} */
                        const created = {
                            id: resultId,
                            role: "tool",
                            toolCallId,
                            content: resultContent,
                            ...(update.rawOutput !== undefined ? { rawOutput: structuredClone(update.rawOutput) } : {}),
                        };
                        cloned.add(created);
                        insertMessage(messages, created);
                    }
                }
                continue;
            }

            if (kind === "plan_update" && isRecord(update.plan)) {
                if (typeof plurnk?.origin === "string" && plurnk.origin !== "model") {
                    continue;
                }
                const plan = structuredClone(update.plan);
                const coordinate = typeof plurnk?.coordinate === "string" && plurnk.coordinate.length > 0
                    ? plurnk.coordinate
                    : "";
                let callOwnerIdx = coordinate
                    ? messages.findIndex((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.toolCallId === coordinate))
                    : -1;
                if (callOwnerIdx === -1) {
                    callOwnerIdx = messages.findLastIndex((m) => m.role === "assistant" && m.toolCalls?.some((c) =>
                        c.name === "todo" || (isRecord(c._meta?.plurnk) && c._meta.plurnk.op === "todo")));
                }
                if (callOwnerIdx !== -1) {
                    const owner = cloneAt(callOwnerIdx);
                    const targetCall = owner.role === "assistant"
                        ? (coordinate
                            ? owner.toolCalls?.find((c) => c.toolCallId === coordinate)
                            : owner.toolCalls?.findLast((c) => c.name === "todo" || (isRecord(c._meta?.plurnk) && c._meta.plurnk.op === "todo")))
                        : undefined;
                    if (targetCall) {
                        const prevPlurnk = isRecord(targetCall._meta?.plurnk) ? { ...targetCall._meta.plurnk } : {};
                        delete prevPlurnk.planRemoved;
                        targetCall._meta = {
                            ...targetCall._meta,
                            plurnk: {
                                ...prevPlurnk,
                                ...(plurnk ? structuredClone(plurnk) : {}),
                                op: "todo",
                                plan,
                            },
                        };
                    }
                } else {
                    const toolCallId = coordinate || "plan";
                    /** @type {Message} */
                    const created = {
                        id: `call:${toolCallId}`,
                        role: "assistant",
                        content: "",
                        ...(subagentRunId ? { subagentRunId } : {}),
                        toolCalls: [{
                            toolCallId,
                            name: "todo",
                            status: "completed",
                            _meta: {
                                plurnk: {
                                    ...(plurnk ? structuredClone(plurnk) : {}),
                                    op: "todo",
                                    plan,
                                },
                            },
                        }],
                    };
                    cloned.add(created);
                    insertMessage(messages, created);
                }
                continue;
            }

            if (kind === "plan_removed") {
                const targetLoopSeq = typeof plurnk?.loopSeq === "number" ? plurnk.loopSeq : null;
                for (let idx = 0; idx < messages.length; idx++) {
                    const msg = messages[idx];
                    if (msg.role !== "assistant" || !msg.toolCalls?.some((c) =>
                        c.name === "todo" || (isRecord(c._meta?.plurnk) && c._meta.plurnk.op === "todo"))) {
                        continue;
                    }
                    const owner = cloneAt(idx);
                    if (owner.role !== "assistant" || !owner.toolCalls) continue;
                    for (const call of owner.toolCalls) {
                        const callPlurnk = isRecord(call._meta?.plurnk) ? call._meta.plurnk : undefined;
                        if (call.name !== "todo" && callPlurnk?.op !== "todo") continue;
                        if (targetLoopSeq !== null && typeof callPlurnk?.loopSeq === "number" && callPlurnk.loopSeq !== targetLoopSeq) {
                            continue;
                        }
                        /** @type {Record<string, any>} */
                        const nextPlurnk = { ...(callPlurnk ?? {}), planRemoved: true };
                        delete nextPlurnk.plan;
                        call._meta = { ...call._meta, plurnk: nextPlurnk };
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
     *   method: "session/request_permission" | "elicitation/create",
     *   resolve: (value: Record<string, unknown>) => void,
     *   reject: (reason?: unknown) => void,
     * }>}
     */
    #gateResolvers = new Map();
    /** @type {Set<string>} */
    #cancelledSubmittedGates = new Set();
    /** @type {Set<string>} */
    #submittedGateIds = new Set();
    /** @type {SessionGate[]} */
    #allPendingGates = [];
    /** @type {readonly string[] | undefined} */
    #heldGateIds = undefined;
    /** @type {number} */
    #inFlightPostCount = 0;
    /** @type {Promise<void>} */
    #outboundPostChain = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    #gateCoalesceTimer = undefined;
    /** @type {(() => void) | undefined} */
    #onGateSettled = undefined;
    /** @type {((outcome: { stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown, settled?: boolean }, transportError?: Error }) => void) | undefined} */
    #onLiveOutcome = undefined;
    /** @type {{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown, settled?: boolean }, transportError?: Error } | undefined} */
    #queuedLiveOutcome = undefined;
    /** @type {Promise<{ result: unknown, meta?: Record<string, unknown> }> | undefined} */
    #inFlightRequest = undefined;
    /** @type {{ message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown } | undefined} */
    #streamProblem = undefined;
    /** @type {{ messageId: string, body: Record<string, unknown> } | undefined} */
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
     *   fetch?: typeof globalThis.fetch,
     * }} [config]
     */
    constructor(config = {}) {
        this.url = config.url ?? "/acp";
        this.sessionId = config.sessionId ?? null;
        this.headers = { ...config.headers };
        /** @type {Record<string, unknown>} */
        this.state = isRecord(config.state) ? structuredClone(config.state) : {};
        /** @type {Message[]} */
        this.messages = Array.isArray(config.messages) ? structuredClone(config.messages) : [];
        /** @type {SessionGate[]} */
        this.pendingGates = [];
        /** @type {AbortController | undefined} */
        this.abortController = undefined;
        /** @type {boolean} */
        this.isRunning = false;
        this.#fetch = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
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
        this.#heldGateIds = undefined;
        for (const [, entry] of this.#gateResolvers) {
            entry.reject(new DOMException("The operation was aborted.", "AbortError"));
        }
        this.#gateResolvers.clear();
        this.#allPendingGates = [];
        this.pendingGates = [];
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
     * @param {SessionGate} entry
     * @returns {string}
     */
    #gateSessionKey(entry) {
        if (entry.method === "session/request_permission") {
            const prop = entry._meta?.plurnk?.proposal;
            if (typeof prop?.session === "string") return prop.session;
            if (typeof prop?.sessionId === "number") return String(prop.sessionId);
            return "";
        }
        const inter = entry._meta?.plurnk?.interaction;
        if (typeof inter?.sessionId === "number") return String(inter.sessionId);
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
            for (const item of this.#allPendingGates) {
                const prop = item.method === "session/request_permission"
                    ? item._meta?.plurnk?.proposal
                    : undefined;
                const inter = item.method === "elicitation/create"
                    ? item._meta?.plurnk?.interaction
                    : undefined;
                const matchesProp = isRecord(prop)
                    && ((typeof d.id === "number" && prop.sessionId === d.id)
                        || (typeof d.name === "string" && prop.session === d.name));
                const matchesInter = isRecord(inter)
                    && typeof d.id === "number" && inter.sessionId === d.id;
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

    #syncPendingGates() {
        if (this.#allPendingGates.length === 0) {
            this.pendingGates = [];
        } else if (
            this.#heldGateIds !== undefined
            && this.#heldGateIds.length > 0
            && this.#heldGateIds.every((id) => this.#allPendingGates.some((item) => item.id === id))
        ) {
            this.pendingGates = this.#allPendingGates.filter((item) => this.#heldGateIds?.includes(item.id));
        } else {
            const firstSession = this.#gateSessionKey(this.#allPendingGates[0]);
            this.pendingGates = this.#allPendingGates.filter(
                (item) => this.#gateSessionKey(item) === firstSession,
            );
        }
        return this.#syncDescendantGates();
    }

    /**
     * @param {{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown, settled?: boolean }, transportError?: Error }} outcome
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
                this.#syncPendingGates();
                if (!this.#bufferingReplay) {
                    await this.#subscriber.onStateChanged?.({ state: this.state });
                }
                this.#onGateSettled?.();
                const held = this.#heldGateIds;
                const currentIds = this.pendingGates.map(({ id }) => id);
                const sameHeld = held !== undefined
                    && held.length === currentIds.length
                    && currentIds.every((id, idx) => id === held[idx]);
                if (!sameHeld && this.pendingGates.length > 0) {
                    this.#emitLiveOutcome({ stopReason: "interrupt" });
                }
            });
        });
    }

    /**
     * @param {string} gateId
     */
    #cancelGateById(gateId) {
        const existed = this.#gateResolvers.has(gateId)
            || this.#allPendingGates.some((item) => item.id === gateId);
        if (!existed) return;
        this.#gateResolvers.delete(gateId);
        this.#allPendingGates = this.#allPendingGates.filter((item) => item.id !== gateId);
        const changed = this.#syncPendingGates();
        if (this.#submittedGateIds.has(gateId)) {
            this.#cancelledSubmittedGates.add(gateId);
        }
        if (this.#connController?.signal.aborted) {
            return;
        }
        setTimeout(() => {
            void this.#notificationChain.then(async () => {
                if (this.#connController?.signal.aborted) return;
                if (changed && !this.#bufferingReplay) {
                    await this.#subscriber.onStateChanged?.({ state: this.state });
                }
                if (this.pendingGates.length > 0) {
                    this.#emitLiveOutcome({ stopReason: "interrupt" });
                } else if (this.#heldGateIds !== undefined) {
                    this.#emitLiveOutcome({ stopReason: "end_turn" });
                } else if (this.#inFlightRequest === undefined) {
                    const status = isRecord(this.state.plurnk) && isRecord(this.state.plurnk.status)
                        ? this.state.plurnk.status
                        : undefined;
                    const lifecycle = typeof status?.lifecycle === "string" ? status.lifecycle : "idle";
                    if (!["queued", "running", "parked"].includes(lifecycle)) {
                        this.#emitLiveOutcome({ stopReason: "end_turn" });
                    }
                }
            });
        });
    }

    /**
     * @param {readonly unknown[]} descendants
     */
    #pruneDescendantGatesFromStatus(descendants) {
        for (const item of [...this.#allPendingGates]) {
            const prop = item.method === "session/request_permission"
                ? item._meta?.plurnk?.proposal
                : undefined;
            const inter = item.method === "elicitation/create"
                ? item._meta?.plurnk?.interaction
                : undefined;
            const desc = descendants.find((d) => {
                if (!isRecord(d)) return false;
                if (typeof d.id === "number" && (prop?.sessionId === d.id || inter?.sessionId === d.id)) {
                    return true;
                }
                if (typeof d.name === "string" && prop?.session === d.name) {
                    return true;
                }
                return false;
            });
            if (isRecord(desc) && Array.isArray(desc.gates)) {
                const stillPending = desc.gates.some((g) => {
                    if (!isRecord(g)) return false;
                    if (typeof prop?.logEntryId === "number" && g.logEntryId === prop.logEntryId) return true;
                    if (typeof inter?.interactionId === "number" && g.interactionId === inter.interactionId) return true;
                    return false;
                });
                if (!stillPending) {
                    this.#cancelGateById(item.id);
                }
            }
        }
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
            const fetchSignal = init?.signal
                ? AbortSignal.any([init.signal, connController.signal])
                : connController.signal;
            if (init?.method === "GET") {
                const fetchPromise = this.#fetch(input, {
                    ...init,
                    headers: mergedHeaders,
                    signal: fetchSignal,
                });
                fetchPromise.catch((err) => {
                    if (!connController.signal.aborted && !init.signal?.aborted) {
                        this.#emitLiveOutcome({
                            stopReason: "transport_error",
                            transportError: err instanceof Error ? err : new Error(String(err)),
                        });
                    }
                });
                const initialResponse = await fetchPromise;
                if (!initialResponse.ok) {
                    if (this.#streamProblem === undefined) {
                        const refusalError = await problemFromResponse(initialResponse.clone());
                        this.#streamProblem = refusalError
                            ? {
                                message: refusalError.message,
                                status: refusalError.status,
                                problem: isRecord(refusalError.cause) ? refusalError.cause : undefined,
                            }
                            : {
                                message: initialResponse.statusText || `HTTP ${initialResponse.status}`,
                                status: initialResponse.status,
                            };
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
                    void this.#notificationChain.then(() => {
                        if (fetchSignal.aborted) return;
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
            if (isPost) {
                this.#inFlightPostCount += 1;
            }
            let response;
            try {
                const fetchPromise = this.#fetch(input, {
                    ...init,
                    headers: mergedHeaders,
                    signal: fetchSignal,
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

        app.onNotification(methods.client.elicitation.complete, (ctx) => {
            const elicitationId = isRecord(ctx.params) && typeof ctx.params.elicitationId === "string"
                ? ctx.params.elicitationId
                : "";
            if (!elicitationId) return;
            for (const item of [...this.#allPendingGates]) {
                if (item.method === "elicitation/create" && item.elicitationId === elicitationId) {
                    const resolver = this.#gateResolvers.get(item.id);
                    this.#cancelGateById(item.id);
                    resolver?.resolve({ action: "accept" });
                }
            }
        });

        app.onRequest(methods.client.session.requestPermission, async (ctx) => {
            await this.#notificationChain;
            const params = /** @type {Record<string, unknown>} */ (ctx.params);
            const metaPlurnk = isRecord(params._meta) && isRecord(params._meta.plurnk)
                ? params._meta.plurnk
                : undefined;
            const proposal = isRecord(metaPlurnk?.proposal) ? metaPlurnk.proposal : undefined;
            const logEntryId = typeof proposal?.logEntryId === "number" ? proposal.logEntryId : randomUUID();
            const gateId = `proposal:${logEntryId}:${randomUUID().slice(0, 8)}`;
            const rawExpires = proposal?.expiresAt;
            const expiresAt = typeof rawExpires === "number"
                ? new Date(rawExpires).toISOString()
                : typeof rawExpires === "string"
                    ? rawExpires
                    : undefined;
            /** @type {PermissionGate} */
            const entry = {
                id: gateId,
                method: "session/request_permission",
                ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
                ...(isRecord(params.toolCall) ? { toolCall: structuredClone(params.toolCall) } : {}),
                ...(Array.isArray(params.options) ? { options: structuredClone(params.options) } : {}),
                ...(expiresAt !== undefined ? { expiresAt } : {}),
                ...(proposal !== undefined
                    ? {
                        _meta: {
                            plurnk: {
                                proposal: /** @type {import("@plurnk/plurnk-contracts").ProposalProjection} */ (
                                    /** @type {unknown} */ (structuredClone(proposal))
                                ),
                            },
                        },
                    }
                    : {}),
            };
            this.#allPendingGates.push(entry);
            this.#syncPendingGates();

            return await new Promise((resolve, reject) => {
                this.#gateResolvers.set(gateId, {
                    method: "session/request_permission",
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
                    this.#cancelGateById(gateId);
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
            const gateId = `int:${interactionId}:${randomUUID().slice(0, 8)}`;
            const reqRecord = isRecord(interaction?.request) ? interaction.request : {};
            const message = typeof params.message === "string"
                ? params.message
                : typeof reqRecord.message === "string"
                    ? reqRecord.message
                    : undefined;
            const requestedSchema = isRecord(params.requestedSchema)
                ? params.requestedSchema
                : isRecord(reqRecord.requestedSchema)
                    ? reqRecord.requestedSchema
                    : undefined;
            const mode = params.mode === "url" ? "url" : "form";
            const rawExpires = interaction?.expiresAt;
            const expiresAt = typeof rawExpires === "number"
                ? new Date(rawExpires).toISOString()
                : typeof rawExpires === "string"
                    ? rawExpires
                    : undefined;

            /** @type {ElicitationGate} */
            const entry = {
                id: gateId,
                method: "elicitation/create",
                ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
                mode,
                ...(message !== undefined ? { message } : {}),
                ...(requestedSchema !== undefined ? { requestedSchema: structuredClone(requestedSchema) } : {}),
                ...(typeof params.url === "string" ? { url: params.url } : {}),
                ...(typeof params.elicitationId === "string" ? { elicitationId: params.elicitationId } : {}),
                ...(expiresAt !== undefined ? { expiresAt } : {}),
                ...(interaction !== undefined
                    ? {
                        _meta: {
                            plurnk: {
                                interaction: /** @type {import("@plurnk/plurnk-contracts").ClientInteractionProjection} */ (
                                    /** @type {unknown} */ (structuredClone(interaction))
                                ),
                            },
                        },
                    }
                    : {}),
            };
            this.#allPendingGates.push(entry);
            this.#syncPendingGates();

            return await new Promise((resolve, reject) => {
                this.#gateResolvers.set(gateId, {
                    method: "elicitation/create",
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
                    this.#cancelGateById(gateId);
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
                info: { name: "@plurnk/plurnk-web", version: "1.1.0" },
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
    async resume(options = {}, subscriber = {}) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        const { signal } = controller;
        const heldGates = Array.isArray(options.gates) ? [...options.gates] : [];

        try {
            this.#heldGateIds = heldGates.length > 0 ? heldGates : undefined;
            if (heldGates.length > 0 && this.#conn !== undefined) {
                const currentIds = this.pendingGates.map(({ id }) => id);
                const sameSet = currentIds.length === heldGates.length
                    && currentIds.every((id, idx) => id === heldGates[idx]);
                if (!sameSet) {
                    const stopReason = this.pendingGates.length > 0 ? "interrupt" : "end_turn";
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

            this.#allPendingGates = this.#allPendingGates.filter((item) => this.#gateResolvers.has(item.id));
            this.#syncPendingGates();
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

            if (this.pendingGates.length > 0) {
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
    async send(options = {}, subscriber = {}) {
        if (options.action) {
            return await this.#runAction(options, subscriber);
        }
        if (Array.isArray(options.resolutions) && options.resolutions.length > 0) {
            return await this.#runGateResolutions(options.resolutions, options, subscriber);
        }
        if (options.message) {
            return await this.#runPrompt(options.message, options, subscriber);
        }
        return await this.resume(options, subscriber);
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
                const value = String(actionParams.value ?? "");
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
        this.#heldGateIds = undefined;
        this.#allPendingGates = this.#allPendingGates.filter((item) => this.#gateResolvers.has(item.id));
        this.#syncPendingGates();
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
     * @param {readonly GateResolution[]} resolutions
     * @param {SessionRunOptions} options
     * @param {SessionSubscriber} subscriber
     */
    async #runGateResolutions(resolutions, options, subscriber) {
        const controller = options.abortController ?? this.abortController ?? new AbortController();
        this.#activeController = controller;
        this.isRunning = true;
        this.#subscriber = subscriber;
        this.#bufferingReplay = false;
        this.#replayUpdates = [];
        this.#submittedGateIds.clear();
        this.#cancelledSubmittedGates.clear();
        this.#queuedLiveOutcome = undefined;
        this.#heldGateIds = undefined;
        const { signal } = controller;

        try {
            this.#needsConnectionSse = false;
            await this.#ensureConnection(signal);
            let missingGate = false;
            const plurnkState = isRecord(this.state.plurnk) ? this.state.plurnk : undefined;
            const statusState = isRecord(plurnkState?.status) ? plurnkState.status : undefined;
            const rawParts = typeof this.sessionId === "string" ? this.sessionId.split("#") : [];
            const boundName = typeof statusState?.name === "string" ? statusState.name : (rawParts[1] || "user");
            const boundId = typeof statusState?.id === "number" ? String(statusState.id) : "";
            let resolvedDescendantOnly = resolutions.length > 0;
            for (const res of resolutions) {
                const existing = this.#allPendingGates.find((item) => item.id === res.id);
                if (existing) {
                    const key = this.#gateSessionKey(existing);
                    if (!key || key === boundName || key === boundId) {
                        resolvedDescendantOnly = false;
                    }
                } else {
                    resolvedDescendantOnly = false;
                }
            }

            for (const res of resolutions) {
                const gate = this.#gateResolvers.get(res.id);
                this.#allPendingGates = this.#allPendingGates.filter((item) => item.id !== res.id);
                if (!gate) {
                    missingGate = true;
                    continue;
                }
                this.#gateResolvers.delete(res.id);
                this.#submittedGateIds.add(res.id);
                gate.resolve(/** @type {Record<string, unknown>} */ (res.response));
            }

            const gatesChanged = this.#syncPendingGates();

            if (missingGate) {
                await subscriber.onError?.({
                    message: "Request is no longer pending.",
                    settled: true,
                });
            }

            if (this.pendingGates.length === 0 && this.#inFlightRequest !== undefined) {
                return await this.#awaitRequestOrInterrupt(this.#inFlightRequest, signal, subscriber);
            }

            const boundLifecycle = typeof statusState?.lifecycle === "string" ? statusState.lifecycle : "idle";
            if (
                (resolvedDescendantOnly && !["queued", "running", "parked"].includes(boundLifecycle))
                || this.pendingGates.length > 0
            ) {
                await new Promise((r) => setTimeout(r));
                await this.#outboundPostChain;
                await this.#drainNotifications();
                if (gatesChanged && !this.#bufferingReplay) {
                    await subscriber.onStateChanged?.({ state: this.state });
                }
                if (this.#cancelledSubmittedGates.size > 0 && !missingGate) {
                    await subscriber.onError?.({
                        message: "Request is no longer pending.",
                        settled: true,
                    });
                }
                const nextStop = this.pendingGates.length > 0 ? "interrupt" : "end_turn";
                if (nextStop === "interrupt") {
                    this.#queuedLiveOutcome = undefined;
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
            if (this.#cancelledSubmittedGates.size > 0 && !missingGate) {
                await subscriber.onError?.({
                    message: "Request is no longer pending.",
                    settled: true,
                });
            }
            const stopReason = outcome.stopReason;
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
                if (this.#queuedLiveOutcome?.stopReason === "interrupt") {
                    this.#queuedLiveOutcome = undefined;
                }
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
            || this.pendingGates.length > 0;
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
            await subscriber.onError?.({
                message: "Request is no longer pending.",
                settled: true,
            });
        }

        if (liveOutcome?.stopReason === "eof" && !hasImmediateOutcome) {
            this.close();
            return { result: rawResult, stopReason: "end_turn", meta: metaPlurnk };
        }
        const rawStopReason = this.pendingGates.length > 0
            ? "interrupt"
            : typeof liveOutcome?.stopReason === "string"
                ? liveOutcome.stopReason
                : typeof metaPlurnk?.stopReason === "string"
                    ? metaPlurnk.stopReason
                    : typeof rawResult.stopReason === "string"
                        ? rawResult.stopReason
                        : "end_turn";
        const stopReason = rawStopReason === "eof" ? "end_turn" : rawStopReason;
        if (stopReason === "interrupt" && this.#queuedLiveOutcome?.stopReason === "interrupt") {
            this.#queuedLiveOutcome = undefined;
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
     * @returns {Promise<{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown, settled?: boolean } }>}
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
            /** @param {{ stopReason: string, meta?: Record<string, unknown>, error?: { message: string, status?: number, problem?: Record<string, unknown>, terminal?: unknown, settled?: boolean }, transportError?: Error }} outcome */
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
                if (Array.isArray(status.descendants)) {
                    this.#pruneDescendantGatesFromStatus(status.descendants);
                }
                prevPlurnk.status = {
                    ...(isRecord(prevPlurnk.status) ? prevPlurnk.status : {}),
                    ...structuredClone(status),
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
            this.#syncDescendantGates();
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
            throw signal.reason instanceof Error
                ? signal.reason
                : new DOMException("The operation was aborted.", "AbortError");
        }
        await this.#drainNotifications();
        if (signal.aborted && this.#streamProblem === undefined) {
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
        const idx = this.messages.findIndex((m) => m.id === pending.messageId && m.role === "reasoning");
        const found = idx !== -1 ? this.messages[idx] : undefined;
        if (!found || (isRecord(found._meta?.plurnk) && found._meta.plurnk.body !== undefined)) {
            return;
        }
        const updated = {
            ...found,
            _meta: {
                ...found._meta,
                plurnk: {
                    ...(isRecord(found._meta?.plurnk) ? found._meta.plurnk : {}),
                    body: pending.body,
                },
            },
        };
        this.messages = this.messages.with(idx, updated);
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
        let projectedUpdate = update;
        if (kind === "agent_thought_chunk") {
            const id = typeof update.messageId === "string" && update.messageId.length > 0
                ? update.messageId
                : typeof plurnk?.coordinate === "string"
                    ? `${plurnk.coordinate}/reasoning`
                    : "";
            if (this.#pendingLiveThought && this.#pendingLiveThought.messageId !== id) {
                await this.#finalizeLiveThought(subscriber);
            }
            const isResourceLink = isRecord(update.content) && update.content.type === "resource_link";
            if (isResourceLink) {
                this.#pendingLiveThought = undefined;
            } else if (id && isRecord(plurnk?.body)) {
                this.#pendingLiveThought = { messageId: id, body: structuredClone(plurnk.body) };
                const { body: _body, ...restPlurnk } = plurnk;
                projectedUpdate = {
                    ...update,
                    _meta: {
                        ...(isRecord(update._meta) ? update._meta : {}),
                        plurnk: restPlurnk,
                    },
                };
            }
            if (
                isRecord(update.content)
                && update.content.type === "text"
                && typeof update.content.text === "string"
                && update.content.text.length > 0
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
        this.messages = SessionTranslator.projectMessages([projectedUpdate], this.messages);
        await subscriber.onMessagesChanged?.({ messages: this.messages });
    }

    /**
     * @param {string} sessionId
     * @param {AcpSessionUpdatePayload} update
     * @param {SessionSubscriber} subscriber
     */
    async #handleSessionUpdate(sessionId, update, subscriber) {
        const kind = update.sessionUpdate;
        if (!(this.#bufferingReplay && kind === "agent_thought_chunk")) {
            await subscriber.onSessionUpdate?.({ update, sessionId });
        }
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
                if (stateObj.state === "idle") {
                    for (const item of [...this.#allPendingGates]) {
                        const key = this.#gateSessionKey(item);
                        if (key === childName || key === String(childId)) {
                            this.#cancelGateById(item.id);
                        }
                    }
                } else if (stateObj.state === "running") {
                    const coord = typeof plurnk?.coordinate === "string"
                        ? plurnk.coordinate.split("#")[1]
                        : undefined;
                    for (const item of [...this.#allPendingGates]) {
                        const key = this.#gateSessionKey(item);
                        if (key !== childName && key !== String(childId)) continue;
                        if (item.method === "session/request_permission") {
                            const prop = item._meta?.plurnk?.proposal;
                            if (coord !== undefined && prop?.coordinate === coord) {
                                this.#cancelGateById(item.id);
                            }
                        } else if (item.method === "elicitation/create") {
                            this.#cancelGateById(item.id);
                        }
                    }
                }
                if (Array.isArray(plurnk?.gates)) {
                    this.#pruneDescendantGatesFromStatus([{ id: childId, name: childName, gates: plurnk.gates }]);
                }
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
            if (update.state === "running" || update.state === "idle") {
                if (this.#inFlightPostCount > 0 && this.#submittedGateIds.size > 0) {
                    for (const id of this.#submittedGateIds) {
                        this.#cancelledSubmittedGates.add(id);
                    }
                }
                if (this.#bufferingReplay) {
                    for (const item of [...this.#allPendingGates]) {
                        this.#cancelGateById(item.id);
                    }
                } else {
                    const plurnkState = isRecord(this.state.plurnk) ? this.state.plurnk : undefined;
                    const statusState = isRecord(plurnkState?.status) ? plurnkState.status : undefined;
                    const rawParts = typeof this.sessionId === "string" ? this.sessionId.split("#") : [];
                    const boundName = typeof statusState?.name === "string" ? statusState.name : (rawParts[1] || "user");
                    const boundId = typeof statusState?.id === "number" ? String(statusState.id) : "";
                    for (const item of [...this.#allPendingGates]) {
                        const key = this.#gateSessionKey(item);
                        if (!key || key === boundName || key === boundId) {
                            this.#cancelGateById(item.id);
                        }
                    }
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
            if (notice?.kind === "turn_generated" || typeof plurnk?.id === "number") {
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
                if (Array.isArray(plurnk.status.descendants)) {
                    this.#pruneDescendantGatesFromStatus(plurnk.status.descendants);
                }
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
                this.#syncDescendantGates();
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
            || kind === "plan_update"
            || kind === "plan_removed"
        ) {
            if (
                (kind === "tool_call" || kind === "tool_call_update")
                && typeof update.toolCallId === "string"
                && typeof update.status === "string"
                && update.status !== "pending"
            ) {
                for (const item of [...this.#allPendingGates]) {
                    if (item.method === "session/request_permission") {
                        const prop = item._meta?.plurnk?.proposal;
                        if (
                            prop?.coordinate === update.toolCallId
                            || (isRecord(item.toolCall) && item.toolCall.toolCallId === update.toolCallId)
                        ) {
                            this.#cancelGateById(item.id);
                        }
                    } else if (
                        item.method === "elicitation/create"
                        && (update.status === "completed" || update.status === "failed")
                    ) {
                        const inter = item._meta?.plurnk?.interaction;
                        if (typeof inter?.interactionId === "number" && `int:${inter.interactionId}` === update.toolCallId) {
                            this.#cancelGateById(item.id);
                        }
                    }
                }
            }
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
