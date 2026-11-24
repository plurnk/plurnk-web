import {
    SAFE_RASTER_IMAGE_MIMES,
    entryUrlForTarget,
    labelFromUri,
    rasterMimeForFilename,
} from "./inline-images.js";
import { GLYPH_OPS, argumentsOf, receiptOf, record } from "./operation-summary.js";

/** @typedef {import("./session-translator.js").Message} Message */
/** @typedef {import("./session-translator.js").MessagePart} MessagePart */
/** @typedef {import("./session-translator.js").ToolCall} ToolCall */
/** @typedef {{ message: Readonly<Message>, call?: ToolCall }} Entry */
/**
 * @typedef {{
 *   key: string,
 *   message: Readonly<Message>,
 *   call?: ToolCall,
 *   answered?: ToolCall,
 *   operation?: ToolCall,
 *   args: Record<string, unknown> | null,
 *   facts: Record<string, unknown> | null,
 *   answeredFacts: Record<string, unknown> | null,
 *   op: unknown,
 *   ownResult?: Readonly<Message>,
 *   receipt: Record<string, unknown> | null,
 *   operationName: string | null,
 *   summarized: boolean,
 *   error: string,
 *   conversational: boolean,
 *   loopSeq: number | null,
 *   loopId: number | null,
 *   workItems: PreparedEntry[],
 *   nestedReplies: PreparedEntry[],
 * }} PreparedEntry
 */

/** @param {unknown} value */
export const isReplyOp = (value) => value === "send" || value === "done" || value === "fail";

/**
 * {§web-session-conversation} Extract non-operator actor name and intra-workspace session target from ACP metadata.
 * @param {boolean} inbound
 * @param {Record<string, unknown> | null} facts
 * @param {Record<string, unknown> | null} receipt
 * @param {Record<string, unknown> | null} args
 * @returns {{ readonly actor: string, readonly sessionTarget: string | null } | null}
 */
export function extractActorInfo(inbound, facts, receipt, args) {
    /** @type {unknown[]} */
    const candidates = [];
    if (inbound) {
        candidates.push(facts?.source);
    } else {
        if (Array.isArray(receipt?.repliedToSources)) candidates.push(...receipt.repliedToSources);
        if (Array.isArray(receipt?.repliedTo)) candidates.push(...receipt.repliedTo);
        candidates.push(facts?.target, facts?.address, record(args?.target)?.raw);
    }
    for (const candidate of candidates) {
        if (typeof candidate !== "string" || candidate.length === 0) continue;
        const sessionMatch = /^session:\/\/([^/?#]+)/u.exec(candidate);
        if (sessionMatch !== null) {
            try {
                const peer = decodeURIComponent(sessionMatch[1] ?? "").trim();
                if (peer.length > 0 && peer !== "_plurnk") {
                    return { actor: `#${peer}`, sessionTarget: peer };
                }
            } catch { /* fall through */ }
            continue;
        }
        const exteriorMatch = /^(?:acp|mcp):\/\/([^/?#]+)/u.exec(candidate);
        if (exteriorMatch !== null) {
            try {
                const principal = decodeURIComponent(exteriorMatch[1] ?? "").trim();
                if (
                    principal.length > 0 &&
                    principal !== "operator" &&
                    principal !== "anonymous" &&
                    principal !== "client" &&
                    principal !== "owner"
                ) {
                    return { actor: principal, sessionTarget: null };
                }
            } catch { /* fall through */ }
            continue;
        }
        const messageMatch = /^message:\/\/[^/?#]+\/([^/?#]+)_([0-9a-zA-Z]{2,5})$/u.exec(candidate);
        if (messageMatch !== null) {
            try {
                const principal = decodeURIComponent(messageMatch[1] ?? "").trim();
                if (
                    principal.length > 0 &&
                    principal !== "_plurnk" &&
                    principal !== "operator" &&
                    principal !== "anonymous" &&
                    principal !== "client" &&
                    principal !== "owner"
                ) {
                    return { actor: principal, sessionTarget: null };
                }
            } catch { /* fall through */ }
            continue;
        }
        const scheduleMatch = /^schedule:\/\/\/?([^/?#]+)/u.exec(candidate);
        if (scheduleMatch !== null) {
            try {
                const alias = decodeURIComponent(scheduleMatch[1] ?? "").trim();
                if (alias.length > 0) {
                    return { actor: `schedule:${alias}`, sessionTarget: null };
                }
            } catch { /* fall through */ }
        }
    }
    if (typeof facts?.actor === "string") {
        const direct = facts.actor.trim();
        if (
            direct.length > 0 &&
            direct !== "_plurnk" &&
            direct !== "operator" &&
            direct !== "anonymous" &&
            direct !== "client" &&
            direct !== "owner"
        ) {
            return { actor: direct, sessionTarget: null };
        }
    }
    return null;
}

/** @param {Record<string, unknown> | null} facts */
function explicitLoopSeq(facts) {
    if (typeof facts?.loopSeq === "number" && Number.isSafeInteger(facts.loopSeq) && facts.loopSeq >= 1) {
        return facts.loopSeq;
    }
    if (typeof facts?.coordinate === "string") {
        const match = /^(\d+)\/\d+(?:\/\d+)?$/u.exec(facts.coordinate);
        if (match) return Number(match[1]);
    }
    return null;
}

/** @param {PreparedEntry[]} items @param {ReadonlySet<string>} [gapStarts] */
function assignLoops(items, gapStarts) {
    /** @type {Map<number, number>} */
    const seqByLoopId = new Map();
    for (const item of items) {
        if (item.loopId !== null && item.loopSeq !== null) seqByLoopId.set(item.loopId, item.loopSeq);
    }
    for (const item of items) {
        if (item.loopSeq === null && item.loopId !== null) {
            item.loopSeq = seqByLoopId.get(item.loopId) ?? null;
        }
    }
    const firstKnown = items.find((item) => item.loopSeq !== null)?.loopSeq ?? 1;
    let currentSeq = firstKnown;
    /** @type {number | null} */
    let currentLoopId = null;
    for (const [index, item] of items.entries()) {
        if (item.loopSeq !== null) {
            currentSeq = item.loopSeq;
            if (item.loopId !== null) {
                currentLoopId = item.loopId;
                seqByLoopId.set(item.loopId, currentSeq);
            }
            continue;
        }
        if (item.loopId !== null && seqByLoopId.has(item.loopId)) {
            currentSeq = seqByLoopId.get(item.loopId) ?? currentSeq;
            currentLoopId = item.loopId;
        } else if (
            (index > 0 && gapStarts?.has(item.message.id) && !item.call)
            || (item.loopId !== null && currentLoopId !== null && item.loopId !== currentLoopId)
        ) {
            currentSeq += 1;
            if (item.loopId !== null) {
                currentLoopId = item.loopId;
                seqByLoopId.set(item.loopId, currentSeq);
            }
        } else if (item.loopId !== null && currentLoopId === null) {
            currentLoopId = item.loopId;
            seqByLoopId.set(item.loopId, currentSeq);
        }
        item.loopSeq = currentSeq;
    }
}

/** @param {PreparedEntry} item */
function promptAddresses(item) {
    const addresses = new Set([item.message.id]);
    const resource = item.receipt?.resource ?? item.facts?.address ?? item.facts?.target;
    if (typeof resource === "string" && resource) {
        addresses.add(resource);
        const slash = resource.lastIndexOf("/");
        if (slash >= 0 && slash < resource.length - 1) addresses.add(resource.slice(slash + 1));
    }
    if (typeof item.facts?.source === "string" && item.facts.source) addresses.add(item.facts.source);
    return addresses;
}

/** @param {PreparedEntry} item */
function repliedAddresses(item) {
    if (item.op !== "done" && item.op !== "fail") return [];
    const raw = Array.isArray(item.receipt?.repliedTo) ? item.receipt.repliedTo
        : Array.isArray(item.facts?.repliedTo) ? item.facts.repliedTo : [];
    const list = raw.filter((/** @type {unknown} */ value) => typeof value === "string" && value.length > 0);
    const target = record(item.args?.target)?.raw;
    if (typeof target === "string" && target && !list.includes(target)) list.push(target);
    return list;
}

/** @param {PreparedEntry} item */
export function tallyBucket(item) {
    if (item.message.role === "reasoning") {
        return { key: "reasoning", tally: "reasoning", heading: "", label: "Thinking" };
    }
    const type = typeof item.op === "string" ? item.op : (item.call?.name ?? item.message.role);
    const showHeading = !GLYPH_OPS.has(type);
    return {
        key: `op:${type}`,
        tally: type,
        heading: showHeading ? `${type} ` : "",
        label: type,
    };
}

/** @param {readonly PreparedEntry[]} items */
export function isWorkRunning(items) {
    return items.some((item) =>
        (item.message.role === "reasoning" && item.facts?.streaming === true)
        || Boolean(item.call && (item.call.status === "in_progress" || item.call.status === "pending")));
}

/** @param {Record<string, unknown> | null} facts */
export function formatReasoningHeading(facts) {
    const streaming = facts?.streaming === true;
    const session = typeof facts?.sessionName === "string" && facts.sessionName ? `#${facts.sessionName}` : "";
    const coordMatch = typeof facts?.coordinate === "string" ? /^(\d+)\/(\d+)$/u.exec(facts.coordinate) : null;
    return {
        text: streaming ? "Thinking…" : "Thinking",
        title: [session, coordMatch ? `Loop ${coordMatch[1]} · Turn ${coordMatch[2]}` : ""].filter(Boolean).join(" · "),
    };
}

const USER_ATTACHMENT_LINE = /^<(session:\/\/[^>\s]+\/attachments\/[0-9a-f]+\/([^>/\s]+))>$/iu;
const TOOL_CHANNEL_IMAGE_LINE = /^<((?:session|mcp|file):\/\/[^>\s]+)>\s+—\s+(image\/(?:png|jpeg|gif|webp))$/iu;

/**
 * Expand daemon-published raster attachment `<session://.../attachments/...>` lines on user messages into inline image references.
 * @param {string | readonly MessagePart[] | undefined} content
 * @param {unknown} baseEntryUrl
 * @returns {string | readonly MessagePart[] | undefined}
 */
export function expandUserAttachments(content, baseEntryUrl) {
    if (typeof content !== "string" || typeof baseEntryUrl !== "string") return content;
    const lines = content.split("\n");
    /** @type {MessagePart[]} */
    const parts = [];
    /** @type {string[]} */
    let textBuffer = [];
    let matchedAny = false;
    const flushText = () => {
        const joined = textBuffer.join("\n").trim();
        if (joined) parts.push({ type: "text", text: joined });
        textBuffer = [];
    };
    for (const line of lines) {
        const match = USER_ATTACHMENT_LINE.exec(line.trim());
        if (match) {
            const sessionUri = match[1];
            const label = labelFromUri(sessionUri);
            const mimeType = rasterMimeForFilename(label);
            const entryUrl = mimeType ? entryUrlForTarget(baseEntryUrl, sessionUri) : null;
            if (mimeType && entryUrl) {
                matchedAny = true;
                flushText();
                parts.push({
                    type: "resource_link",
                    uri: entryUrl,
                    mimeType,
                    name: label,
                });
                continue;
            }
        }
        textBuffer.push(line);
    }
    if (!matchedAny) return content;
    flushText();
    return parts;
}

/**
 * {§web-inline-images} Extract verified raster image parts from tool receipts, MCP image channel lines, or successful raster `read` receipts.
 * @param {{
 *   rawContent: unknown,
 *   callContent: readonly Record<string, unknown>[] | undefined,
 *   op: unknown,
 *   receipt: Record<string, unknown> | null,
 *   facts: Record<string, unknown> | null,
 *   answeredFacts: Record<string, unknown> | null,
 *   call: ToolCall | undefined,
 *   args: Record<string, unknown> | null,
 *   error: string,
 * }} input
 * @returns {MessagePart[]}
 */
export function extractToolImageParts({ rawContent, callContent, op, receipt, facts, answeredFacts, call, args, error }) {
    const baseEntryUrl = record(facts?.body)?.url ?? record(answeredFacts?.body)?.url;
    /** @type {MessagePart[]} */
    const parts = [];
    const seen = new Set();
    const pushImage = (/** @type {string} */ mimeType, /** @type {string} */ data, /** @type {string | undefined} */ name) => {
        const key = `img:${mimeType}:${data.slice(0, 64)}:${data.length}`;
        if (seen.has(key)) return;
        seen.add(key);
        parts.push({ type: "image", mimeType, data, ...(name ? { name } : {}) });
    };
    const pushLink = (/** @type {string} */ uri, /** @type {string} */ mimeType, /** @type {string | undefined} */ name) => {
        const key = `link:${uri}:${mimeType}`;
        if (seen.has(key)) return;
        seen.add(key);
        parts.push({ type: "resource_link", uri, mimeType, ...(name ? { name } : {}) });
    };

    const scanChannelLines = (/** @type {string} */ sourceText) => {
        if (typeof baseEntryUrl !== "string") return;
        for (const line of sourceText.split("\n")) {
            const match = TOOL_CHANNEL_IMAGE_LINE.exec(line.trim());
            if (!match) continue;
            const targetUri = match[1];
            const mimeType = match[2].toLowerCase();
            const entryUrl = entryUrlForTarget(baseEntryUrl, targetUri);
            if (entryUrl) pushLink(entryUrl, mimeType, labelFromUri(targetUri));
        }
    };

    if (Array.isArray(callContent)) {
        for (const block of callContent) {
            const inner = record(block)?.type === "content" ? record(block.content) : null;
            if (
                inner?.type === "image"
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
                pushImage(inner.mimeType.toLowerCase(), inner.data, name);
            } else if (inner?.type === "text" && typeof inner.text === "string") {
                scanChannelLines(inner.text);
            }
        }
    }

    if (typeof receipt?.content === "string") {
        scanChannelLines(receipt.content);
    }

    if (Array.isArray(rawContent)) {
        for (const part of rawContent) {
            const rec = record(part);
            if (
                rec?.type === "image"
                && typeof rec.mimeType === "string"
                && SAFE_RASTER_IMAGE_MIMES.has(rec.mimeType.toLowerCase())
                && typeof rec.data === "string"
                && rec.data.length > 0
            ) {
                pushImage(rec.mimeType.toLowerCase(), rec.data, typeof rec.name === "string" ? rec.name : undefined);
            }
        }
    } else if (typeof rawContent === "string") {
        scanChannelLines(rawContent);
    }

    if (op === "read" && !error && typeof baseEntryUrl === "string") {
        const statusCode = typeof receipt?.status === "number"
            ? receipt.status
            : typeof facts?.status === "number"
                ? facts.status
                : 200;
        const imageMeta = record(receipt?.image);
        const imageMime = typeof imageMeta?.mimetype === "string" ? imageMeta.mimetype.toLowerCase() : "";
        if (statusCode < 400 && SAFE_RASTER_IMAGE_MIMES.has(imageMime)) {
            const candidates = [
                receipt?.target,
                call?.locations?.[0]?.path,
                facts?.target,
                facts?.address,
                args?.path,
                record(args?.target)?.raw,
            ];
            const targetUri = candidates.find(
                (/** @type {unknown} */ value) => typeof value === "string" && value.trim().length > 0 && !/^log:\/\//iu.test(value.trim()),
            );
            if (typeof targetUri === "string") {
                const entryUrl = entryUrlForTarget(baseEntryUrl, targetUri.trim());
                if (entryUrl) pushLink(entryUrl, imageMime, labelFromUri(targetUri.trim()));
            }
        }
    }

    return parts;
}

/**
 * {§web-session-conversation} {§web-operation-summary} {§web-session-reasoning} {§web-working-notes}
 * Normalize messages and tool calls into loop-grouped conversational entries, nested mid-loop replies, and work disclosures.
 * @param {readonly Readonly<Message>[]} messages
 * @param {ReadonlySet<string>} [gapStarts]
 */
export function prepareConversationBlocks(messages, gapStarts) {
    const identities = new Set(messages.map(({ id }) => id));
    if (identities.size !== messages.length) throw new Error("Conversation has duplicate message identities.");
    const suppliedCalls = messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : []);
    const calls = new Map(suppliedCalls.map((call) => [call.toolCallId, call]));
    if (calls.size !== suppliedCalls.length) throw new Error("Conversation has duplicate call identities.");
    // {§web-operation-summary} Later observations have their own row metadata, unlike an immediate receipt.
    const immediate = messages.flatMap((message) => message.role === "tool"
        && !message._meta?.plurnk && typeof calls.get(message.toolCallId)?._meta?.plurnk?.op === "string" ? [message] : []);
    const results = new Map(immediate.map((message) => [message.toolCallId, message]));
    if (results.size !== immediate.length) throw new Error("Operation has duplicate immediate receipts.");
    const folded = new Set(immediate.map(({ id }) => id));
    /** @type {Entry[]} */
    const entries = messages.flatMap((message) => {
        if (folded.has(message.id)) return [];
        // {§web-session-reasoning} Empty reasoning with neither a body reference nor active streaming is omitted.
        if (
            message.role === "reasoning"
            && !message.content
            && message._meta?.plurnk?.body === undefined
            && message._meta?.plurnk?.streaming !== true
        ) {
            return [];
        }
        const operations = message.role === "assistant" ? message.toolCalls ?? [] : [];
        const hasContent = Array.isArray(message.content) ? message.content.length > 0 : Boolean(message.content);
        /** @type {Entry[]} */
        const content = hasContent || !operations.length ? [{ message }] : [];
        return [...content, ...operations.map((call) => ({ message, call }))];
    });

    /** @type {PreparedEntry[]} */
    const prepared = entries.map(({ message, call }) => {
        const key = JSON.stringify([message.id, call?.toolCallId ?? null]);
        const answered = message.role === "tool" ? calls.get(message.toolCallId) : undefined;
        const operation = call?._meta?.plurnk?.op === call?.name ? call : undefined;
        // {§web-working-notes} note calls project semantic bodies without duplicating arguments.
        const args = operation ? argumentsOf(operation.rawInput) : null;
        const facts = record((call ? call._meta : message._meta)?.plurnk);
        const answeredFacts = answered ? record(answered._meta?.plurnk) : null;
        const op = facts?.op;
        const ownResult = call ? results.get(call.toolCallId) : undefined;
        const receipt = ownResult ? (receiptOf(ownResult.rawOutput) ?? receiptOf(ownResult.content))
            : message.role === "tool" && facts && !isReplyOp(op) ? (receiptOf(message.rawOutput) ?? receiptOf(message.content) ?? record(facts?.receipt))
            : (call ? receiptOf(call.rawOutput) : null) ?? record(facts?.receipt);
        const operationName = call?.name ?? (typeof op === "string" ? op : null);
        const summarized = typeof op === "string" && Boolean(operationName);
        const error = ownResult?.error ?? (message.role === "tool" ? message.error : undefined) ?? "";
        const conversational = message.role === "user"
            || isReplyOp(op)
            || (message.role === "assistant" && !call)
            || message.role === "system"
            || message.role === "developer";
        const loopSeq = explicitLoopSeq(facts) ?? explicitLoopSeq(answeredFacts);
        const loopId = typeof facts?.loopId === "number" ? facts.loopId
            : typeof answeredFacts?.loopId === "number" ? answeredFacts.loopId : null;
        return {
            key, message, call, answered, operation, args,
            facts, answeredFacts, op, ownResult, receipt, operationName,
            summarized, error, conversational, loopSeq, loopId,
            workItems: [],
            nestedReplies: [],
        };
    });

    // Validate reasoning body references before mutating the DOM so a rejected snapshot leaves the last valid projection intact.
    for (const { message } of prepared) {
        const linked = message.role === "reasoning" ? message._meta?.plurnk?.body : undefined;
        if (linked !== undefined && (typeof linked?.url !== "string" || typeof linked?.mimeType !== "string")) {
            throw new TypeError("Reasoning body reference must supply its URL and MIME type.");
        }
    }

    assignLoops(prepared, gapStarts);

    /** @type {Map<number, PreparedEntry[]>} */
    const loops = new Map();
    for (const item of prepared) {
        const seq = item.loopSeq ?? 1;
        const group = loops.get(seq) ?? [];
        group.push(item);
        loops.set(seq, group);
    }

    /** @type {({ kind: "entry", item: PreparedEntry } | { kind: "operations", items: PreparedEntry[], loopSeq: number })[]} */
    const topBlocks = [];
    for (const [seq, loopItems] of loops) {
        /** @type {Set<string> | null} */
        let openingAddresses = null;
        /** @type {{ prompt: PreparedEntry, addresses: Set<string> }[]} */
        const midLoopPrompts = [];
        const nestedSet = new Set();
        for (const item of loopItems) {
            if (item.message.role === "user" && !item.call) {
                const addresses = promptAddresses(item);
                if (openingAddresses === null) openingAddresses = addresses;
                else if (extractActorInfo(true, item.facts, item.receipt, item.args) === null) {
                    midLoopPrompts.push({ prompt: item, addresses });
                }
                continue;
            }
            const targets = repliedAddresses(item);
            if (!targets.length || !midLoopPrompts.length) continue;
            const opening = openingAddresses;
            if (opening !== null && targets.some((target) => opening.has(target))) continue;
            const matched = midLoopPrompts.findLast(({ addresses }) => targets.some((target) => addresses.has(target)));
            if (matched) {
                matched.prompt.nestedReplies.push(item);
                nestedSet.add(item);
            }
        }

        /** @type {PreparedEntry | null} */
        let activePrompt = null;
        for (const item of loopItems) {
            if (nestedSet.has(item)) continue;
            if (item.conversational) {
                if (item.message.role === "user" && !item.call) {
                    activePrompt = item;
                }
                topBlocks.push({ kind: "entry", item });
            } else if (activePrompt !== null) {
                activePrompt.workItems.push(item);
            } else {
                const last = topBlocks.at(-1);
                if (last?.kind === "operations" && last.loopSeq === seq) {
                    last.items.push(item);
                } else {
                    topBlocks.push({ kind: "operations", items: [item], loopSeq: seq });
                }
            }
        }
    }

    return {
        visibleIds: new Set(prepared.map(({ key }) => key)),
        topBlocks,
    };
}
