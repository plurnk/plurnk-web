import { $, the } from "on_the_money";
import bodyReferences from "./body-references.js";
import card, { nameCard } from "./card.js";
import {
    extractActorInfo,
    extractToolImageParts,
    expandUserAttachments,
    formatReasoningHeading,
    isReplyOp,
    isWorkRunning,
    prepareConversationBlocks,
    tallyBucket,
} from "./conversation-prepare.js";
import { SAFE_RASTER_IMAGE_MIMES, mountRasterImage } from "./inline-images.js";
import markdown from "./markdown.js";
import operationSummary, { bodyOf, record } from "./operation-summary.js";

/** @typedef {import("./session-translator.js").Message} Message */
/** @typedef {import("./session-translator.js").MessagePart} MessagePart */
/** @typedef {import("./conversation-prepare.js").PreparedEntry} PreparedEntry */

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
        /** @type {string | readonly MessagePart[] | undefined} */
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
        const { visibleIds, topBlocks } = prepareConversationBlocks(messages, gapStarts);

        const rows = new Map(Array.from(list.querySelectorAll("[data-message-id]"), (child) => {
            const row = /** @type {HTMLElement} */ (child);
            return [JSON.stringify([row.dataset.messageId, row.dataset.callId ?? null]), row];
        }));
        for (const [id, row] of rows) {
            if (!visibleIds.has(id)) row.remove();
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
