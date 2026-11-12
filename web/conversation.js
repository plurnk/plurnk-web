import { $, the } from "on_the_money";
import markdown from "./markdown.js";
import bodyReferences from "./body-references.js";
import reasoningCoordinate from "./reasoning-coordinate.js";
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
 *   nestedReplies: PreparedEntry[],
 * }} PreparedEntry
 */

/** @param {unknown} value */
const isReplyOp = (value) => value === "send" || value === "done" || value === "fail";

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
        return { key: "reasoning", tally: "reasoning", heading: "", label: "Reasoning" };
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

/** @param {Element} parent @param {Element} child @param {Element | null} previous @param {(node: Element) => boolean} [skip] */
function placeChild(parent, child, previous, skip) {
    /** @type {Element | null} */
    let position = previous === null ? parent.firstElementChild : previous.nextElementSibling;
    while (position && skip?.(position)) position = position.nextElementSibling;
    if (position !== child) parent.insertBefore(child, position ?? null);
    return child;
}

/** {§web-session-conversation} DOM identities are presentation state, never a second conversation.
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
            }
        } else if (typeof content === "string") {
            text(outlet, content, rich, scope);
        }
        if (replies) outlet.append(replies);
        painted.set(outlet, revision);
    }

    /** @param {PreparedEntry} item @param {Map<string, HTMLElement>} rows */
    function renderEntry(item, rows) {
        const {
            key, message, call, answered, operation, args,
            facts, op, receipt, operationName, summarized, error, conversational,
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
        const labels = { user: "User", assistant: "Assistant", reasoning: "Reasoning", tool: "Result", activity: "Activity", system: "System", developer: "Developer" };
        const label = call ? call.name
            : summarized ? operationName
            : message.role === "tool" ? `Result · ${answered?.name ?? message.toolCallId}`
            : message.role === "activity" ? message.activityType : labels[message.role];
        const author = "name" in message ? message.name : undefined;
        the(row, {
            messageId: message.id,
            messageRole: message.role,
            messageLabel: [label, author, message.subagentRunId ? `Subagent ${message.subagentRunId}` : null].filter(Boolean).join(" · "),
            messageAuthor: author ?? null,
            subagentRunId: message.subagentRunId ?? null,
            messageError: error ? true : null,
            toolCallId: message.role === "tool" ? message.toolCallId : null,
            callId: call?.toolCallId ?? null,
            plurnkType: typeof op === "string" ? op : null,
            plurnkSession: typeof facts?.sessionId === "number" ? facts.sessionId : null,
            plurnkStatus: typeof receipt?.status === "number" ? receipt.status : typeof facts?.status === "number" ? facts.status : null,
            plurnkSignal: typeof receipt?.completion === "number" ? receipt.completion : typeof facts?.signal === "number" ? facts.signal : null,
            plurnkState: typeof facts?.state === "string" ? facts.state : null,
        });
        const linked = message.role === "reasoning" ? message._meta?.plurnk?.body : undefined;
        if (linked !== undefined && (typeof linked?.url !== "string" || typeof linked?.mimeType !== "string")) {
            throw new TypeError("Reasoning body reference must supply its URL and MIME type.");
        }
        /** @type {string | readonly import("./session-agent.js").MessagePart[] | undefined} */
        const content = call ? bodyOf(args, op) : summarized && message.role === "tool" && !isReplyOp(op) ? ""
            : linked ? [{ type: /** @type {const} */ ("resource_link"), uri: linked.url, mimeType: linked.mimeType }] : message.content;
        const rich = call ? isReplyOp(operation?.name)
            : message.role === "tool" ? isReplyOp(facts?.op)
            : message.role !== "reasoning" && message.role !== "activity";
        const hasBody = typeof content === "string" ? Boolean(content) : Array.isArray(content) && content.some((part) =>
            part?.type === "text" && typeof part.text === "string" && Boolean(part.text)
            || part?.type === "resource_link" && typeof part.uri === "string" && Boolean(part.uri));
        const frame = card(row, hasBody, !conversational);
        if (frame.removedDisclosure && frame.body) painted.delete(frame.body);
        body(frame.body, content, rich, call ? `call-${call.toolCallId}` : `message-${message.id}`);
        if (summarized) {
            painted.delete(frame.header);
            operationSummary(frame.header, operationName, args, receipt, facts, error);
        } else {
            const headerCoordinate = message.role === "reasoning" ? reasoningCoordinate(message._meta?.plurnk) : "";
            const headerRevision = `${headerCoordinate}\n${error}`;
            if (painted.get(frame.header) !== headerRevision) {
                frame.header.replaceChildren();
                if (message.role === "reasoning") $.clone(frame.header, "#operation-header").textContent = headerCoordinate;
                if (error) $.clone(frame.header, "#operation-outcome").textContent = error;
                painted.set(frame.header, headerRevision);
            }
            if (frame.header.tagName === "HEADER" && !frame.header.hasChildNodes()) frame.header.remove();
        }
        if (frame.header.isConnected) nameCard(frame.header);
        const article = $(row, ":scope > article");
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

    /** @param {HTMLElement} opsRow @param {PreparedEntry[]} items */
    function renderOperationsSummary(opsRow, items) {
        /** @type {Map<string, ReturnType<typeof tallyBucket> & { count: number }>} */
        const buckets = new Map();
        for (const item of items) {
            const bucket = tallyBucket(item);
            const existing = buckets.get(bucket.key);
            if (existing) existing.count += 1;
            else buckets.set(bucket.key, { ...bucket, count: 1 });
        }
        const list = [...buckets.values()];
        the(opsRow, {
            operations: items[0].key,
            operationsLabel: list.map((b) => `${b.label} ${b.count}`).join(" · "),
        });
        const line = $(opsRow, ":scope > details > summary > span");
        if (!line) return;
        const revision = JSON.stringify(list);
        if (painted.get(line) === revision) return;
        line.replaceChildren();
        for (const [index, b] of list.entries()) {
            if (index > 0) line.append(" · ");
            const tally = $.clone(line, "#operation-tally");
            the(tally, { operationTally: b.tally });
            const heading = $(tally, '[data-plurnk-field="heading"]');
            if (heading) heading.textContent = b.heading;
            const count = $(tally, '[data-plurnk-field="count"]');
            if (count) count.textContent = String(b.count);
        }
        painted.set(line, revision);
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
            // {§web-session-reasoning} An empty live reasoning message is not a transcript body.
            if (message.role === "reasoning" && !message.content && message._meta?.plurnk?.body === undefined) return [];
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

        const existingLoops = new Map(Array.from(list.querySelectorAll(":scope > [data-loop-seq]"), (child) => {
            const row = /** @type {HTMLElement} */ (child);
            return [Number(row.dataset.loopSeq), row];
        }));
        for (const [seq, loopRow] of existingLoops) {
            if (!loops.has(seq)) loopRow.remove();
        }

        /** @type {Element | null} */
        let previousLoop = null;
        for (const [seq, loopItems] of loops) {
            let loopRow = existingLoops.get(seq);
            if (!loopRow) {
                const cloned = $.clone(list, "#conversation-loop");
                if (!(cloned instanceof HTMLElement)) throw new Error("Loop template must contain an HTML element.");
                loopRow = cloned;
            }
            the(loopRow, { loopSeq: seq });
            const loopList = $(loopRow, ":scope > details > ul");
            if (!(loopList instanceof HTMLUListElement)) throw new Error("Loop disclosure has no list.");

            /** @type {Set<string> | null} */
            let openingAddresses = null;
            /** @type {{ prompt: PreparedEntry, addresses: Set<string> }[]} */
            const midLoopPrompts = [];
            const nestedSet = new Set();
            for (const item of loopItems) {
                if (item.message.role === "user" && !item.call) {
                    const addresses = promptAddresses(item);
                    if (openingAddresses === null) openingAddresses = addresses;
                    else midLoopPrompts.push({ prompt: item, addresses });
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

            /** @type {({ kind: "entry", item: PreparedEntry } | { kind: "operations", items: PreparedEntry[] })[]} */
            const blocks = [];
            for (const item of loopItems) {
                if (nestedSet.has(item)) continue;
                if (item.conversational) {
                    blocks.push({ kind: "entry", item });
                } else {
                    const last = blocks.at(-1);
                    if (last?.kind === "operations") last.items.push(item);
                    else blocks.push({ kind: "operations", items: [item] });
                }
            }

            const existingOps = Array.from(loopList.querySelectorAll(":scope > [data-operations]"), (el) => /** @type {HTMLElement} */ (el));
            const usedOps = new Set();
            /** @type {Element | null} */
            let prevBlock = null;
            for (const block of blocks) {
                if (block.kind === "entry") {
                    const row = renderEntry(block.item, rows);
                    prevBlock = placeChild(loopList, row, prevBlock);
                    continue;
                }
                const firstKey = block.items[0].key;
                const memberRows = new Set(block.items.map(({ key }) => rows.get(key)).filter(Boolean));
                let opsRow = existingOps.find((el) => !usedOps.has(el) && el.dataset.operations === firstKey)
                    ?? existingOps.find((el) => !usedOps.has(el) && Array.from(memberRows).some((r) => r && el.contains(r)));
                if (!opsRow) {
                    const cloned = $.clone(loopList, "#conversation-operations");
                    if (!(cloned instanceof HTMLElement)) throw new Error("Operations template must contain an HTML element.");
                    opsRow = cloned;
                }
                usedOps.add(opsRow);
                renderOperationsSummary(opsRow, block.items);
                const opsList = $(opsRow, ":scope > details > ul");
                if (!(opsList instanceof HTMLUListElement)) throw new Error("Operations disclosure has no list.");
                /** @type {Element | null} */
                let prevOp = null;
                for (const opItem of block.items) {
                    const row = renderEntry(opItem, rows);
                    prevOp = placeChild(opsList, row, prevOp);
                }
                prevBlock = placeChild(loopList, opsRow, prevBlock);
            }
            for (const opsRow of existingOps) {
                if (!usedOps.has(opsRow)) opsRow.remove();
            }

            previousLoop = placeChild(list, loopRow, previousLoop, (node) => !node.hasAttribute("data-loop-seq"));
        }

        reference.prune();
        the(root, "conversation-empty", messages.length === 0);
    };
}
