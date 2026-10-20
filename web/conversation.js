import { $, the } from "on_the_money";
import markdown from "./markdown.js";
import anchor from "./anchor.js";
import bodyReferences from "./body-references.js";

/** @typedef {import("@ag-ui/client").Message} Message */
/** @typedef {NonNullable<import("@ag-ui/client").AssistantMessage["toolCalls"]>[number]} ToolCall */
/** @typedef {{message: Readonly<Message>, call?: ToolCall}} Entry */

/** @param {string} id */
const callId = (id) => anchor("call", id);

/** {§web-working-notes} Interpret only a confirmed operation's complete display fields.
 * @param {ToolCall} call
 * @returns {{body: string, aside: string} | null}
 */
function workingNote(call) {
    if (call.function.name !== "NOTE" || call.metadata?.plurnk?.op !== "NOTE") return null;
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
    if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.body !== "string"
        || (args.aside != null && typeof args.aside !== "string")) return null;
    return { body: args.body, aside: args.aside ?? "" };
}

/** {§web-worker-conversation} DOM identities are presentation state, never a second conversation.
 * @param {HTMLElement} root @param {(address: string) => Promise<string>} readBody
 */
export default function conversation(root, readBody) {
    const list = $(root, "[data-messages]");
    if (!(list instanceof HTMLOListElement)) throw new Error("Conversation document has no message list.");
    const reference = bodyReferences(root, readBody);
    // Replacing unchanged Markdown would discard native selection inside the body.
    /** @type {WeakMap<Element, {source: string, rich: boolean}>} */
    const painted = new WeakMap();

    /** @param {Element} outlet @param {string} source @param {boolean} rich @param {string} scope */
    function text(outlet, source, rich, scope) {
        if (rich) outlet.append(markdown(source, scope));
        else if (source) the($.clone(outlet, "#conversation-literal"), "literalContent", source);
    }

    /** @param {Element} row @param {unknown} content @param {boolean} rich @param {string} scope */
    function body(row, content, rich, scope) {
        const outlet = $(row, "[data-message-body]");
        if (!outlet) throw new Error("Message template has no content outlet.");
        const source = typeof content === "string" ? content : JSON.stringify(content, null, 2) ?? "";
        const previous = painted.get(outlet);
        if (previous?.source === source && previous.rich === rich) return;
        outlet.replaceChildren();
        if (Array.isArray(content)) {
            for (const [index, part] of content.entries()) {
                if (part?.type === "text" && typeof part.text === "string") text(outlet, part.text, rich, `${scope}-part-${index}`);
                else if (part?.type === "document" && part.source?.type === "url" && typeof part.source.value === "string") reference(outlet, part.source);
                else text(outlet, JSON.stringify(part, null, 2) ?? "", false, `${scope}-part-${index}`);
            }
        } else {
            text(outlet, source, rich && typeof content === "string", scope);
        }
        painted.set(outlet, { source, rich });
    }

    /** @param {readonly Readonly<Message>[]} messages */
    return (messages) => {
        const identities = new Set(messages.map(({ id }) => id));
        if (identities.size !== messages.length) throw new Error("Conversation has duplicate message identities.");
        const suppliedCalls = messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : []);
        const calls = new Map(suppliedCalls.map((call) => [call.id, call]));
        if (calls.size !== suppliedCalls.length) throw new Error("Conversation has duplicate call identities.");
        const entries = messages.flatMap((message) => {
            // {§web-worker-reasoning} An empty live reasoning message is not a transcript body.
            if (message.role === "reasoning" && !message.content && message.metadata?.plurnk?.body === undefined) return [];
            const operations = message.role === "assistant" ? message.toolCalls ?? [] : [];
            const hasContent = Array.isArray(message.content) ? message.content.length > 0 : Boolean(message.content);
            /** @type {Entry[]} */
            const content = hasContent || !operations.length ? [{ message }] : [];
            return [...content, ...operations.map((call) => ({ message, call }))];
        });
        const keys = entries.map(({ message, call }) => JSON.stringify([message.id, call?.id ?? null]));
        const visibleIds = new Set(keys);
        const rows = new Map(Array.from(list.children, (child) => {
            const row = /** @type {HTMLElement} */ (child);
            return [JSON.stringify([row.dataset.messageId, row.dataset.callId ?? null]), row];
        }));
        for (const [id, row] of rows) {
            if (!visibleIds.has(id)) row.remove();
        }
        for (const [index, { message, call }] of entries.entries()) {
            let row = rows.get(keys[index]);
            if (row && row.dataset.messageRole !== message.role) {
                row.remove();
                row = undefined;
            }
            if (!row) {
                const element = message.role === "reasoning" ? $.clone(list, "#conversation-detail")
                    : message.role === "tool" ? $.clone(list, "#conversation-result") : $.clone(list, "#conversation-message");
                if (!(element instanceof HTMLElement)) throw new Error("Conversation template must contain an HTML element.");
                row = element;
            }
            const answered = message.role === "tool" ? calls.get(message.toolCallId) : undefined;
            const note = call ? workingNote(call) : null;
            const category = note ? note.aside || "note" : null;
            const facts = (call ? call.metadata : message.metadata)?.plurnk;
            const labels = { user: "User", assistant: "Assistant", reasoning: "Reasoning", tool: "Result", activity: "Activity", system: "System", developer: "Developer" };
            const label = call ? [call.function.name, category].filter(Boolean).join(" · ")
                : message.role === "tool" ? `Result · ${answered?.function.name ?? message.toolCallId}`
                : message.role === "activity" ? message.activityType : labels[message.role];
            const author = "name" in message ? message.name : undefined;
            the(row, {
                messageId: message.id,
                messageRole: message.role,
                messageLabel: [label, author, message.subagentRunId ? `Subagent ${message.subagentRunId}` : null].filter(Boolean).join(" · "),
                messageAuthor: author ?? null,
                subagentRunId: message.subagentRunId ?? null,
                messageError: message.role === "tool" ? message.error || null : null,
                toolCallId: message.role === "tool" ? message.toolCallId : null,
                callId: call?.id ?? null,
                callName: call?.function.name ?? null,
                callAnchor: call ? callId(call.id) : null,
                callHref: answered ? `#${callId(answered.id)}` : null,
                plurnkType: facts?.op ?? null,
                plurnkNote: category,
                plurnkCoordinate: facts?.coordinate ?? null,
                plurnkWorker: facts?.worker ?? null,
                plurnkAddress: facts?.address ?? null,
                plurnkStatus: facts?.status ?? null,
                plurnkState: facts?.state ?? null,
            });
            const linked = message.role === "reasoning" ? message.metadata?.plurnk?.body : undefined;
            if (linked !== undefined && (typeof linked?.url !== "string" || typeof linked?.mimeType !== "string")) {
                throw new TypeError("Reasoning body reference must supply its URL and MIME type.");
            }
            const content = call ? note?.body ?? call.function.arguments
                : linked ? [{ type: "document", source: { type: "url", value: linked.url, mimeType: linked.mimeType } }] : message.content;
            const rich = call ? note !== null : message.role !== "tool" && message.role !== "activity";
            body(row, content, rich, call ? `call-${call.id}` : `message-${message.id}`);
            if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
        }
        the(root, "conversation-empty", messages.length === 0);
    };
}
