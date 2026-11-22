import { $, the } from "on_the_money";
import markdown from "./markdown.js";
import bodyReferences from "./body-references.js";
import {
    SAFE_RASTER_IMAGE_MIMES,
    entryUrlForTarget,
    labelFromUri,
    mountRasterImage,
    rasterMimeForFilename,
} from "./inline-images.js";
import card, { nameCard } from "./card.js";
import operationSummary, { GLYPH_OPS, argumentsOf, bodyOf, receiptOf, record } from "./operation-summary.js";

/** @typedef {import("./session-agent.js").Message} Message */
/** @typedef {import("./session-agent.js").ToolCall} ToolCall */
/** @typedef {{message: Readonly<Message>, call?: ToolCall}} Entry */
/** @typedef {{
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
const isReplyOp = (value) => value === "send" || value === "done" || value === "fail";

/**
 * {§web-session-conversation} Extract non-operator actor name and intra-workspace session target from ACP metadata.
 * @param {boolean} inbound
 * @param {Record<string, unknown> | null} facts
 * @param {Record<string, unknown> | null} receipt
 * @param {Record<string, unknown> | null} args
 * @returns {{ readonly actor: string, readonly sessionTarget: string | null } | null}
 */
function extractActorInfo(inbound, facts, receipt, args) {
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
            const principal = (messageMatch[1] ?? "").trim();
            if (
                principal.length > 0 &&
                principal !== "operator" &&
                principal !== "anonymous" &&
                principal !== "client" &&
                principal !== "owner"
            ) {
                return { actor: principal, sessionTarget: null };
            }
            continue;
        }
        const scheduleMatch = /^schedule:\/\/\/([^/?#]+)/u.exec(candidate);
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
function tallyBucket(item) {
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
function isWorkRunning(items) {
    return items.some((item) =>
        (item.message.role === "reasoning" && item.facts?.streaming === true)
        || Boolean(item.call && (item.call.status === "in_progress" || item.call.status === "pending")));
}

/** @param {Record<string, unknown> | null} facts */
function formatReasoningHeading(facts) {
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
 * @param {string | readonly import("./session-agent.js").MessagePart[] | undefined} content
 * @param {unknown} baseEntryUrl
 * @returns {string | readonly import("./session-agent.js").MessagePart[] | undefined}
 */
function expandUserAttachments(content, baseEntryUrl) {
    if (typeof content !== "string" || typeof baseEntryUrl !== "string") return content;
    const lines = content.split("\n");
    /** @type {import("./session-agent.js").MessagePart[]} */
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
 * Extract verified raster image parts from tool receipts, MCP image channel lines, or successful raster `read` receipts.
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
 * @returns {import("./session-agent.js").MessagePart[]}
 */
function extractToolImageParts({ rawContent, callContent, op, receipt, facts, answeredFacts, call, args, error }) {
    const baseEntryUrl = record(facts?.body)?.url ?? record(answeredFacts?.body)?.url;
    /** @type {import("./session-agent.js").MessagePart[]} */
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

/** @param {Element} parent @param {Element} child @param {Element | null} previous @param {(node: Element) => boolean} [skip] */
function placeChild(parent, child, previous, skip) {
    /** @type {Element | null} */
    let position = previous === null ? parent.firstElementChild : previous.nextElementSibling;
    while (position && skip?.(position)) position = position.nextElementSibling;
    if (position !== child) parent.insertBefore(child, position ?? null);
    return child;
}

/** {§web-session-conversation} {§web-inline-images} DOM identities are presentation state, never a second conversation.
 * @param {HTMLElement} root @param {(address: string) => Promise<string>} readBody
 */
export default function conversation(root, readBody) {
    const list = $(root, "[data-messages]");
    if (!(list instanceof HTMLUListElement)) throw new Error("Conversation document has no message list.");
    const reference = bodyReferences(root, readBody);
    // Replacing unchanged Markdown would discard native selection inside the body.
    /** @type {WeakMap<Element, string>} */
    const painted = new WeakMap();

    /** @param {Element} outlet @param {string} source @param {boolean} rich @param {string} scope */
    function text(outlet, source, rich, scope) {
        if (rich) outlet.append(markdown(source, scope));
        else if (source) {
            $.clone(outlet, "#conversation-literal").textContent = source;
        }
    }

    /** @param {Element} outlet @param {string} encoded @param {string | undefined} label */
    function directImage(outlet, encoded, label) {
        const holder = $.clone(outlet, "#conversation-image-reference");
        if (label) holder.setAttribute("aria-label", label);
        the(holder, { "body-state": "loading", "body-pending": "true" });
        void mountRasterImage(holder, encoded, label).then(
            () => {
                if (holder.isConnected) the(holder, { "body-state": "loaded", "body-pending": null });
            },
            (error) => {
                if (!holder.isConnected) return;
                holder.textContent = error instanceof Error ? error.message : String(error);
                holder.setAttribute("role", "alert");
                the(holder, { "body-state": "error", "body-pending": null });
            },
        );
    }

    /** @param {Element | null} outlet @param {unknown} content @param {boolean} rich @param {string} scope */
    function body(outlet, content, rich, scope) {
        if (!outlet) return;
        const revision = typeof content === "string"
            ? `${rich ? "1" : "0"}:${content}`
            : JSON.stringify([content, rich]);
        if (painted.get(outlet) === revision) return;
        const summary = $(outlet, ":scope > summary");
        const header = $(outlet, ":scope > header");
        const replies = $(outlet, ":scope > [data-prompt-replies]");
        for (const node of Array.from(outlet.childNodes)) {
            if (node !== summary && node !== header && node !== replies) node.remove();
        }
        if (Array.isArray(content)) {
            for (const [index, part] of content.entries()) {
                if (part?.type === "text" && typeof part.text === "string") text(outlet, part.text, rich, `${scope}-part-${index}`);
                else if (part?.type === "resource_link" && typeof part.uri === "string") reference.append(outlet, part);
                else if (
                    part?.type === "image"
                    && typeof part.mimeType === "string"
                    && SAFE_RASTER_IMAGE_MIMES.has(part.mimeType.toLowerCase())
                    && typeof part.data === "string"
                    && part.data.length > 0
                ) {
                    directImage(outlet, part.data, typeof part.name === "string" ? part.name : undefined);
                }
            }
        } else if (typeof content === "string") {
            text(outlet, content, rich, scope);
        }
        if (replies) outlet.append(replies);
        painted.set(outlet, revision);
    }

    /** @param {Element} workDetails @param {PreparedEntry[]} items @param {Map<string, HTMLElement>} rows */
    function renderWorkDisclosure(workDetails, items, rows) {
        /** @type {Map<string, ReturnType<typeof tallyBucket> & { count: number }>} */
        const buckets = new Map();
        for (const item of items) {
            const bucket = tallyBucket(item);
            const existing = buckets.get(bucket.key);
            if (existing) existing.count += 1;
            else buckets.set(bucket.key, { ...bucket, count: 1 });
        }
        const bucketList = [...buckets.values()];
        the(workDetails, {
            "work-running": isWorkRunning(items) ? "true" : null,
            "operations-label": bucketList.map((b) => `${b.label} ${b.count}`).join(" · "),
        });
        const pills = $(workDetails, ":scope > summary > [data-prompt-pills]");
        if (pills) {
            const revision = JSON.stringify(bucketList);
            if (painted.get(pills) !== revision) {
                pills.replaceChildren();
                for (const b of bucketList) {
                    const tally = $.clone(pills, "#operation-tally");
                    the(tally, { "operation-tally": b.tally });
                    const heading = $(tally, '[data-plurnk-field="heading"]');
                    if (heading) heading.textContent = b.heading;
                    const count = $(tally, '[data-plurnk-field="count"]');
                    if (count) count.textContent = String(b.count);
                }
                painted.set(pills, revision);
            }
        }
        const workList = $(workDetails, ":scope > [data-work-items]");
        if (!(workList instanceof HTMLUListElement)) throw new Error("Prompt work disclosure has no item list.");
        /** @type {Element | null} */
        let prevOp = null;
        for (const opItem of items) {
            const opRow = renderEntry(opItem, rows);
            prevOp = placeChild(workList, opRow, prevOp);
        }
    }

    /** @param {PreparedEntry} item @param {Map<string, HTMLElement>} rows */
    function renderEntry(item, rows) {
        const {
            key, message, call, answered, operation, args,
            facts, answeredFacts, op, ownResult, receipt, operationName, summarized, error, conversational, loopSeq,
        } = item;
        let row = rows.get(key);
        if (row && row.dataset.messageRole !== message.role) {
            row.remove();
            row = undefined;
        }
        if (!row) {
            const element = $.clone(root, "#conversation-message");
            if (!(element instanceof HTMLElement)) throw new Error("Conversation template must contain an HTML element.");
            row = element;
        }
        const reasoning = message.role === "reasoning" ? formatReasoningHeading(facts) : null;
        const labels = { user: "User", assistant: "Assistant", reasoning: reasoning?.text ?? "Thinking", tool: "Result", activity: "Activity", system: "System", developer: "Developer" };
        const label = call ? call.name
            : message.role === "user" ? labels.user
            : summarized ? operationName
            : message.role === "tool" ? `Result · ${answered?.name ?? message.toolCallId}`
            : message.role === "activity" ? message.activityType : labels[message.role];
        const author = "name" in message ? message.name : undefined;
        const actor = conversational ? extractActorInfo(message.role === "user", facts, receipt, args) : null;
        const actorDirection = actor ? (message.role === "user" ? "inbound" : "outbound") : null;
        const actorDescription = actor
            ? (actorDirection === "inbound" ? `From ${actor.actor}` : `To ${actor.actor}`)
            : null;
        the(row, {
            "message-id": message.id,
            "message-role": message.role,
            "message-label": [label, author, actorDescription, message.subagentRunId ? `Subagent ${message.subagentRunId}` : null].filter(Boolean).join(" · "),
            "message-author": author ?? null,
            "actor": actor?.actor ?? null,
            "actor-direction": actorDirection,
            "subagent-run-id": message.subagentRunId ?? null,
            "message-error": error ? true : null,
            "tool-call-id": message.role === "tool" ? message.toolCallId : null,
            "call-id": call?.toolCallId ?? null,
            "loop-seq": loopSeq ?? 1,
            "plurnk-type": typeof op === "string" ? op : null,
            "plurnk-session": typeof facts?.sessionId === "number" ? facts.sessionId : null,
            "plurnk-status": typeof receipt?.status === "number" ? receipt.status : typeof facts?.status === "number" ? facts.status : null,
            "plurnk-signal": typeof receipt?.completion === "number" ? receipt.completion : typeof facts?.signal === "number" ? facts.signal : null,
            "plurnk-state": typeof facts?.state === "string" ? facts.state : null,
        });
        const linked = message.role === "reasoning" ? message._meta?.plurnk?.body : undefined;
        if (linked !== undefined && (typeof linked?.url !== "string" || typeof linked?.mimeType !== "string")) {
            throw new TypeError("Reasoning body reference must supply its URL and MIME type.");
        }
        /** @type {string | readonly import("./session-agent.js").MessagePart[] | undefined} */
        let content;
        if (call) {
            const authored = bodyOf(args, op);
            const toolImages = !isReplyOp(op)
                ? extractToolImageParts({ rawContent: ownResult?.content, callContent: call.content, op, receipt, facts, answeredFacts, call, args, error })
                : [];
            content = toolImages.length > 0
                ? [...(authored ? [{ type: /** @type {const} */ ("text"), text: authored }] : []), ...toolImages]
                : authored;
        } else if (summarized && message.role === "tool" && !isReplyOp(op)) {
            const toolImages = extractToolImageParts({ rawContent: message.content, callContent: undefined, op, receipt, facts, answeredFacts, call: undefined, args, error });
            content = toolImages.length > 0 ? toolImages : "";
        } else if (linked) {
            content = [{ type: /** @type {const} */ ("resource_link"), uri: linked.url, mimeType: linked.mimeType }];
        } else if (message.role === "user") {
            content = expandUserAttachments(message.content, record(facts?.body)?.url);
        } else {
            content = message.content;
        }
        const rich = call ? isReplyOp(operation?.name)
            : message.role === "tool" ? isReplyOp(facts?.op)
            : message.role !== "reasoning" && message.role !== "activity";
        const hasBody = typeof content === "string" ? Boolean(content) : Array.isArray(content) && content.some((part) =>
            part?.type === "text" && typeof part.text === "string" && Boolean(part.text)
            || part?.type === "resource_link" && typeof part.uri === "string" && Boolean(part.uri)
            || part?.type === "image" && typeof part.mimeType === "string" && SAFE_RASTER_IMAGE_MIMES.has(part.mimeType.toLowerCase()) && typeof part.data === "string" && Boolean(part.data));
        const frame = card(row, hasBody, !conversational);
        if (frame.removedDisclosure && frame.body) painted.delete(frame.body);
        body(frame.body, content, rich, call ? `call-${call.toolCallId}` : `message-${message.id}`);
        const showOperationSummary = summarized && (!conversational || (!hasBody && message.role !== "user"));
        if (showOperationSummary) {
            painted.delete(frame.header);
            operationSummary(frame.header, operationName, args, receipt, facts, error);
        } else {
            const headerRevision = `${reasoning?.text ?? ""}\n${reasoning?.title ?? ""}\n${error}`;
            if (painted.get(frame.header) !== headerRevision) {
                frame.header.replaceChildren();
                if (reasoning) {
                    $.clone(frame.header, "#operation-header").textContent = reasoning.text;
                    if (reasoning.title) frame.header.setAttribute("title", reasoning.title);
                    else frame.header.removeAttribute("title");
                }
                if (error) $.clone(frame.header, "#operation-outcome").textContent = error;
                painted.set(frame.header, headerRevision);
            }
            if (frame.header.tagName === "HEADER" && !frame.header.hasChildNodes()) frame.header.remove();
        }
        if (frame.header.isConnected) nameCard(frame.header);

        const article = $(row, ":scope > article");
        if (article) {
            let actorBadge = $(article, ":scope > [data-message-actor]");
            if (actor) {
                const wantLink = actor.sessionTarget !== null;
                const templateId = wantLink ? "#message-actor-link" : "#message-actor-text";
                const hasLink = actorBadge ? $(actorBadge, "a[data-workspace-route]") !== null : false;
                if (actorBadge && hasLink !== wantLink) {
                    actorBadge.remove();
                    actorBadge = null;
                }
                if (!actorBadge && $(templateId)) {
                    const cloned = wantLink
                        ? $.clone(article, "#message-actor-link", { position: "afterbegin" })
                        : $.clone(article, "#message-actor-text", { position: "afterbegin" });
                    if (cloned instanceof HTMLElement) actorBadge = cloned;
                } else if (actorBadge && article.firstElementChild !== actorBadge) {
                    article.prepend(actorBadge);
                }
                if (actorBadge) {
                    if (wantLink && actor.sessionTarget !== null) {
                        const link = $(actorBadge, "a[data-workspace-route]");
                        if (link instanceof HTMLAnchorElement) {
                            link.dataset.tabSession = actor.sessionTarget;
                        }
                        the(actorBadge, {
                            "actor-href": `#${encodeURIComponent(actor.sessionTarget)}`,
                            "actor-name": actor.actor,
                        });
                    } else {
                        the(actorBadge, { "actor-name": actor.actor });
                    }
                }
            } else if (actorBadge) {
                actorBadge.remove();
            }
        }
        let workDetails = $(row, ":scope > [data-prompt-work]");
        if (item.workItems.length > 0) {
            if (!workDetails) {
                const cloned = $.clone(row, "#prompt-work", { position: "afterbegin" });
                if (!(cloned instanceof HTMLElement)) throw new Error("Prompt work template must contain an HTML element.");
                workDetails = cloned;
            } else if (row.firstElementChild !== workDetails) {
                row.prepend(workDetails);
            }
            renderWorkDisclosure(workDetails, item.workItems, rows);
        } else if (workDetails) {
            workDetails.remove();
        }

        let repliesList = article ? $(article, ":scope > [data-prompt-replies]") : null;
        if (item.nestedReplies.length > 0 && article) {
            repliesList ??= $.clone(article, "#prompt-replies");
            /** @type {Element | null} */
            let prevReply = null;
            for (const replyItem of item.nestedReplies) {
                const replyRow = renderEntry(replyItem, rows);
                prevReply = placeChild(repliesList, replyRow, prevReply);
            }
        } else if (repliesList) {
            repliesList.remove();
        }
        return row;
    }

    /** @param {readonly Readonly<Message>[]} messages @param {ReadonlySet<string>} [gapStarts] */
    return (messages, gapStarts) => {
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

        const visibleIds = new Set(prepared.map(({ key }) => key));
        const rows = new Map(Array.from(list.querySelectorAll("[data-message-id]"), (child) => {
            const row = /** @type {HTMLElement} */ (child);
            return [JSON.stringify([row.dataset.messageId, row.dataset.callId ?? null]), row];
        }));
        for (const [id, row] of rows) {
            if (!visibleIds.has(id)) row.remove();
        }

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

        const existingOps = Array.from(list.querySelectorAll(":scope > [data-operations]"), (el) => /** @type {HTMLElement} */ (el));
        const usedOps = new Set();
        const skipBoundary = (/** @type {Element} */ node) => node.hasAttribute("data-history-boundary");
        /** @type {Element | null} */
        let prevTop = null;
        for (const block of topBlocks) {
            if (block.kind === "entry") {
                const row = renderEntry(block.item, rows);
                prevTop = placeChild(list, row, prevTop, skipBoundary);
                continue;
            }
            const firstKey = block.items[0].key;
            const memberRows = new Set(block.items.map(({ key }) => rows.get(key)).filter(Boolean));
            let opsRow = existingOps.find((el) => !usedOps.has(el) && el.dataset.operations === firstKey)
                ?? existingOps.find((el) => !usedOps.has(el) && Array.from(memberRows).some((r) => r && el.contains(r)));
            if (!opsRow) {
                const cloned = $.clone(list, "#conversation-operations");
                if (!(cloned instanceof HTMLElement)) throw new Error("Operations template must contain an HTML element.");
                opsRow = cloned;
            }
            usedOps.add(opsRow);
            the(opsRow, { operations: firstKey, "loop-seq": block.loopSeq });
            const workDetails = $(opsRow, ":scope > [data-prompt-work]");
            if (!(workDetails instanceof HTMLElement)) throw new Error("Operations disclosure is missing.");
            renderWorkDisclosure(workDetails, block.items, rows);
            prevTop = placeChild(list, opsRow, prevTop, skipBoundary);
        }
        for (const opsRow of existingOps) {
            if (!usedOps.has(opsRow)) opsRow.remove();
        }

        reference.prune();
        the(root, "conversation-empty", messages.length === 0);
    };
}
