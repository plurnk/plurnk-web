import { SAFE_RASTER_IMAGE_MIMES } from "./inline-images.js";

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
 * } | {
 *   type: "image",
 *   mimeType: string,
 *   data: string,
 *   name?: string,
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
 *   messages: Message[],
 *   older: string | null,
 *   final?: boolean,
 *   hasMore?: boolean,
 *   beforeLoopSeq?: number | null,
 * }} MessagesSnapshot
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

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
    if (
        content.type === "image"
        && typeof content.mimeType === "string"
        && SAFE_RASTER_IMAGE_MIMES.has(content.mimeType.toLowerCase())
        && typeof content.data === "string"
        && content.data.length > 0
    ) {
        const name = typeof content.uri === "string" && content.uri.length > 0
            ? content.uri
            : typeof content.name === "string" && content.name.length > 0
                ? content.name
                : undefined;
        return [{
            type: "image",
            mimeType: content.mimeType.toLowerCase(),
            data: content.data,
            ...(name ? { name } : {}),
        }];
    }
    if (content.type === "skill" && typeof content.name === "string" && content.name.length > 0) {
        return `$${content.name}`;
    }
    if (content.type === "text" && typeof content.text === "string") {
        return content.text;
    }
    return "";
}

/**
 * @param {string | readonly MessagePart[] | undefined} existing
 * @param {MessagePart[]} incoming
 * @returns {MessagePart[]}
 */
function mergeChunkParts(existing, incoming) {
    if (!incoming.some((part) => part.type === "image")) return incoming;
    if (typeof existing === "string" && existing.length > 0) {
        return [{ type: "text", text: existing }, ...incoming];
    }
    if (Array.isArray(existing)) {
        return [...existing, ...incoming];
    }
    return incoming;
}

/**
 * @param {unknown} contentBlocks
 * @param {unknown} rawOutput
 * @returns {string | MessagePart[]}
 */
function extractToolResultContent(contentBlocks, rawOutput) {
    if (Array.isArray(contentBlocks)) {
        const hasStructuredPart = contentBlocks.some(
            (block) => isRecord(block)
                && block.type === "content"
                && isRecord(block.content)
                && (block.content.type === "resource_link"
                    || (block.content.type === "image"
                        && typeof block.content.mimeType === "string"
                        && SAFE_RASTER_IMAGE_MIMES.has(block.content.mimeType.toLowerCase())
                        && typeof block.content.data === "string"
                        && block.content.data.length > 0)),
        );
        if (hasStructuredPart) {
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
                } else if (
                    inner.type === "image"
                    && typeof inner.mimeType === "string"
                    && SAFE_RASTER_IMAGE_MIMES.has(inner.mimeType.toLowerCase())
                    && typeof inner.data === "string"
                    && inner.data.length > 0
                ) {
                    const name = typeof inner.uri === "string" && inner.uri.length > 0
                        ? inner.uri
                        : typeof inner.name === "string" && inner.name.length > 0
                            ? inner.name
                            : undefined;
                    parts.push({
                        type: "image",
                        mimeType: inner.mimeType.toLowerCase(),
                        data: inner.data,
                        ...(name ? { name } : {}),
                    });
                }
            }
            if (!parts.some((p) => p.type === "text" || p.type === "image") && rawOutput !== undefined) {
                parts.unshift({
                    type: "text",
                    text: typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput),
                });
            }
            return parts;
        }
    }
    if (Array.isArray(contentBlocks)) {
        const texts = [];
        for (const block of contentBlocks) {
            if (isRecord(block) && block.type === "content" && isRecord(block.content) && block.content.type === "text" && typeof block.content.text === "string") {
                texts.push(block.content.text);
            }
        }
        if (texts.length > 0) {
            const joined = texts.join("\n");
            if (rawOutput === undefined) return joined;
            if (isRecord(rawOutput) && !Object.hasOwn(rawOutput, "content")) {
                return JSON.stringify({ ...rawOutput, content: joined });
            }
        }
    }
    if (rawOutput !== undefined) {
        return typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
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
    /**
     * @param {readonly Record<string, unknown>[]} updates
     * @param {readonly Message[]} [existing]
     * @param {Set<string>} [ambientCallIds]
     * @returns {Message[]}
     */
    static projectMessages(updates, existing = [], ambientCallIds = new Set()) {
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
                        found.content = (wasUnobserved && nowPublished)
                            ? chunk
                            : mergeChunkParts(found.content, chunk);
                    } else if (wasUnobserved && nowPublished) {
                        found.content = chunk;
                    } else if (typeof found.content === "string") {
                        if (
                            (plurnk?.id !== undefined && found._meta?.plurnk?.id === plurnk.id)
                            || found.content === chunk
                            || (found._meta?.plurnk === undefined && plurnk !== undefined)
                        ) {
                            found.content = chunk;
                        } else {
                            found.content += chunk;
                        }
                    } else if (Array.isArray(found.content) && found.content.some((part) => part.type === "image")) {
                        found.content = chunk ? [...found.content, { type: "text", text: chunk }] : found.content;
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
                        found.content = mergeChunkParts(found.content, chunk);
                    } else if (typeof found.content === "string") {
                        if (plurnk?.id !== undefined && found._meta?.plurnk?.id === plurnk.id) {
                            found.content = chunk;
                        } else {
                            found.content += chunk;
                        }
                    } else if (Array.isArray(found.content) && found.content.some((part) => part.type === "image")) {
                        found.content = chunk ? [...found.content, { type: "text", text: chunk }] : found.content;
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
                    if (plurnk.origin === "model") ambientCallIds.delete(toolCallId);
                    else if (typeof plurnk.origin === "string") ambientCallIds.add(toolCallId);
                }

                // Later observation discharging an earlier tool call (coordinate !== toolCallId).
                if (typeof plurnk?.coordinate === "string" && plurnk.coordinate !== toolCallId) {
                    if (ambientCallIds.has(toolCallId)) {
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
        }
        return messages;
    }
}
