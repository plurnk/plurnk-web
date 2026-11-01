import { $, the } from "on_the_money";
import markdown from "./markdown.js";
import bodyReferences from "./body-references.js";
import reasoningCoordinate from "./reasoning-coordinate.js";
import card, { nameCard } from "./card.js";
import operationSummary, { argumentsOf, bodyOf, receiptOf, record } from "./operation-summary.js";

/** @typedef {import("./session-agent.js").Message} Message */
/** @typedef {import("./session-agent.js").ToolCall} ToolCall */
/** @typedef {{message: Readonly<Message>, call?: ToolCall}} Entry */

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
        const revision = JSON.stringify([content, rich]);
        if (painted.get(outlet) === revision) return;
        const summary = $(outlet, ":scope > summary");
        if (summary) {
            for (const node of Array.from(outlet.childNodes)) if (node !== summary) node.remove();
        } else outlet.replaceChildren();
        if (Array.isArray(content)) {
            for (const [index, part] of content.entries()) {
                if (part?.type === "text" && typeof part.text === "string") text(outlet, part.text, rich, `${scope}-part-${index}`);
                else if (part?.type === "document" && part.source?.type === "url" && typeof part.source.value === "string") reference.append(outlet, part.source);
            }
        } else if (typeof content === "string") {
            text(outlet, content, rich, scope);
        }
        painted.set(outlet, revision);
    }

    /** @param {readonly Readonly<Message>[]} messages */
    return (messages) => {
        const identities = new Set(messages.map(({ id }) => id));
        if (identities.size !== messages.length) throw new Error("Conversation has duplicate message identities.");
        const suppliedCalls = messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : []);
        const calls = new Map(suppliedCalls.map((call) => [call.id, call]));
        if (calls.size !== suppliedCalls.length) throw new Error("Conversation has duplicate call identities.");
        // {§web-operation-summary} Later observations have their own row metadata, unlike an immediate receipt.
        const immediate = messages.flatMap((message) => message.role === "tool"
            && !message.metadata?.plurnk && typeof calls.get(message.toolCallId)?.metadata?.plurnk?.op === "string" ? [message] : []);
        const results = new Map(immediate.map((message) => [message.toolCallId, message]));
        if (results.size !== immediate.length) throw new Error("Operation has duplicate immediate receipts.");
        const folded = new Set(immediate.map(({ id }) => id));
        const entries = messages.flatMap((message) => {
            if (folded.has(message.id)) return [];
            // {§web-session-reasoning} An empty live reasoning message is not a transcript body.
            if (message.role === "reasoning" && !message.content && message.metadata?.plurnk?.body === undefined) return [];
            const operations = message.role === "assistant" ? (message.toolCalls ?? []).filter((call) => !call.metadata?.plurnk?.synthetic) : [];
            const hasContent = Array.isArray(message.content) ? message.content.length > 0 : Boolean(message.content);
            if (!hasContent && !operations.length && message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) return [];
            /** @type {Entry[]} */
            const content = hasContent || !operations.length ? [{ message }] : [];
            return [...content, ...operations.map((call) => ({ message, call }))];
        });
        const keys = entries.map(({ message, call }) => JSON.stringify([message.id, call?.id ?? null]));
        const visibleIds = new Set(keys);
        const rows = new Map(Array.from(list.querySelectorAll(":scope > [data-message-id]"), (child) => {
            const row = /** @type {HTMLElement} */ (child);
            return [JSON.stringify([row.dataset.messageId, row.dataset.callId ?? null]), row];
        }));
        for (const [id, row] of rows) {
            if (!visibleIds.has(id)) row.remove();
        }
        /** @type {Element | null} */
        let previous = null;
        for (const [index, { message, call }] of entries.entries()) {
            let row = rows.get(keys[index]);
            if (row && row.dataset.messageRole !== message.role) {
                row.remove();
                row = undefined;
            }
            if (!row) {
                const element = $.clone(list, "#conversation-message");
                if (!(element instanceof HTMLElement)) throw new Error("Conversation template must contain an HTML element.");
                row = element;
            }
            const answered = message.role === "tool" ? calls.get(message.toolCallId) : undefined;
            const operation = call?.metadata?.plurnk?.op === call?.function.name ? call : undefined;
            const args = operation ? argumentsOf(operation.function.arguments) : null;
            // {§web-working-notes} NOTE calls project semantic bodies and categories without duplicating arguments.
            const category = operation?.function.name === "NOTE" && typeof args?.body === "string"
                ? typeof args.aside === "string" && args.aside ? args.aside : "note" : null;
            const facts = record((call ? call.metadata : message.metadata)?.plurnk);
            const op = facts?.op;
            const ownResult = call ? results.get(call.id) : undefined;
            const receipt = ownResult ? receiptOf(ownResult.content)
                : message.role === "tool" && facts && op !== "SEND" ? receiptOf(message.content) : record(facts?.receipt);
            const operationName = call?.function.name ?? (typeof op === "string" ? op : null);
            const summarized = typeof op === "string" && Boolean(operationName);
            const error = ownResult?.error ?? (message.role === "tool" ? message.error : undefined) ?? "";
            const labels = { user: "User", assistant: "Assistant", reasoning: "Reasoning", tool: "Result", activity: "Activity", system: "System", developer: "Developer" };
            const label = call ? [call.function.name, category].filter(Boolean).join(" · ")
                : summarized ? operationName
                : message.role === "tool" ? `Result · ${answered?.function.name ?? message.toolCallId}`
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
                callId: call?.id ?? null,
                plurnkType: typeof op === "string" ? op : null,
                plurnkNote: category,
                plurnkSession: typeof facts?.sessionId === "number" ? facts.sessionId : (typeof facts?.session === "number" ? facts.session : null),
                plurnkStatus: typeof receipt?.status === "number" ? receipt.status : typeof facts?.status === "number" ? facts.status : null,
                plurnkSignal: typeof receipt?.completion === "number" ? receipt.completion : typeof facts?.signal === "number" ? facts.signal : null,
                plurnkState: typeof facts?.state === "string" ? facts.state : null,
            });
            const linked = message.role === "reasoning" ? message.metadata?.plurnk?.body : undefined;
            if (linked !== undefined && (typeof linked?.url !== "string" || typeof linked?.mimeType !== "string")) {
                throw new TypeError("Reasoning body reference must supply its URL and MIME type.");
            }
            /** @type {string | readonly import("./session-agent.js").MessagePart[] | undefined} */
            const content = call ? bodyOf(args, op) : summarized && message.role === "tool" && op !== "SEND" ? ""
                : linked ? [{ type: /** @type {const} */ ("document"), source: { type: /** @type {const} */ ("url"), value: linked.url, mimeType: linked.mimeType } }] : message.content;
            const rich = call ? operation?.function.name === "SEND"
                : message.role === "tool" ? facts?.op === "SEND"
                : message.role !== "reasoning" && message.role !== "activity";
            const hasBody = typeof content === "string" ? Boolean(content) : Array.isArray(content) && content.some((part) =>
                part?.type === "text" && typeof part.text === "string" && Boolean(part.text)
                || part?.type === "document" && part.source?.type === "url" && typeof part.source.value === "string");
            const initiallyOpen = message.role === "user" || op === "SEND" || message.role === "assistant" && !call;
            const frame = card(row, hasBody, initiallyOpen);
            body(frame.body, content, rich, call ? `call-${call.id}` : `message-${message.id}`);
            if (summarized) operationSummary(frame.header, operationName, args, receipt, facts, error);
            else {
                frame.header.replaceChildren();
                if (message.role === "reasoning") $.clone(frame.header, "#operation-header").textContent = reasoningCoordinate(message.metadata?.plurnk?.coordinate);
                if (error) $.clone(frame.header, "#operation-outcome").textContent = error;
                if (!frame.body && !frame.header.hasChildNodes()) frame.header.remove();
            }
            nameCard(frame.header);
            /** @type {Element | null} */
            let position = previous === null ? list.firstElementChild : previous.nextElementSibling;
            while (position && !position.hasAttribute("data-message-id")) position = position.nextElementSibling;
            if (position !== row) list.insertBefore(row, position ?? null);
            previous = row;
        }
        reference.prune();
        the(root, "conversation-empty", messages.length === 0);
    };
}
