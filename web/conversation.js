import { $, the } from "on_the_money";
import markdown from "./markdown.js";
import anchor from "./anchor.js";

/** @typedef {import("@ag-ui/client").Message} Message */
/** @typedef {NonNullable<import("@ag-ui/client").AssistantMessage["toolCalls"]>[number]} ToolCall */

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
 * @param {HTMLElement} root
 */
export default function conversation(root) {
    const list = $(root, "[data-messages]");
    if (!(list instanceof HTMLOListElement)) throw new Error("Conversation document has no message list.");
    // Replacing unchanged Markdown would discard native selection inside the body.
    /** @type {WeakMap<Element, {source: string, rich: boolean}>} */
    const painted = new WeakMap();

    /** @param {Element} row @param {unknown} content @param {boolean} rich @param {string} scope */
    function body(row, content, rich, scope) {
        const outlet = $(row, "[data-message-body]");
        if (!outlet) throw new Error("Message template has no content outlet.");
        const source = typeof content === "string" ? content : JSON.stringify(content, null, 2) ?? "";
        rich &&= typeof content === "string";
        const previous = painted.get(outlet);
        if (previous?.source === source && previous.rich === rich) return;
        if (rich) outlet.replaceChildren(markdown(source, scope));
        else {
            outlet.replaceChildren();
            if (source) the($.clone(outlet, "#conversation-literal"), "literalContent", source);
        }
        painted.set(outlet, { source, rich });
    }

    /** @param {HTMLElement} row @param {readonly ToolCall[]} calls */
    function tools(row, calls) {
        const container = $(row, "[data-calls]");
        if (!container) return;
        const present = new Map(Array.from(container.children, (child) => [/** @type {HTMLElement} */ (child).dataset.callId, child]));
        const identities = new Set(calls.map(({ id }) => id));
        for (const [id, child] of present) if (!id || !identities.has(id)) child.remove();
        for (const [index, call] of calls.entries()) {
            const item = present.get(call.id) ?? $.clone(container, "#conversation-call");
            const note = workingNote(call);
            const kind = note ? "note" : "literal";
            if (the(item, "callKind") !== kind) {
                const content = $(item, "[data-call-content]");
                if (!content) throw new Error("Call template has no content outlet.");
                content.replaceChildren();
                if (note) $.clone(content, "#conversation-note");
                else $.clone(content, "#conversation-arguments");
            }
            the(item, { callId: call.id, callAnchor: callId(call.id), callName: call.function.name,
                callArguments: call.function.arguments, callKind: kind, callAside: note?.aside ?? "" });
            if (note) body(item, note.body, true, `call-${call.id}`);
            if (container.children[index] !== item) container.insertBefore(item, container.children[index] ?? null);
        }
    }

    /** @param {readonly Readonly<Message>[]} messages */
    return (messages) => {
        const identities = new Set(messages.map(({ id }) => id));
        if (identities.size !== messages.length) throw new Error("Conversation has duplicate message identities.");
        const calls = new Map(messages.flatMap((message) => message.role === "assistant" ? message.toolCalls ?? [] : []).map((call) => [call.id, call]));
        const rows = new Map(Array.from(list.children, (child) => [/** @type {HTMLElement} */ (child).dataset.messageId, /** @type {HTMLElement} */ (child)]));
        for (const [id, row] of rows) {
            if (!id || !identities.has(id)) row.remove();
        }
        for (const [index, message] of messages.entries()) {
            const disclosure = message.role !== "user" && message.role !== "assistant";
            let row = rows.get(message.id);
            if (row && Boolean($(row, ":scope > details")) !== disclosure) {
                row.remove();
                row = undefined;
            }
            if (!row) {
                const element = disclosure ? $.clone(list, "#conversation-detail") : $.clone(list, "#conversation-message");
                if (!(element instanceof HTMLElement)) throw new Error("Conversation template must contain an HTML element.");
                row = element;
            }
            const call = message.role === "tool" ? calls.get(message.toolCallId) : undefined;
            const labels = { user: "User", assistant: "Assistant", reasoning: "Reasoning", tool: "Result", activity: "Activity", system: "System", developer: "Developer" };
            const label = message.role === "tool" ? `Result · ${call?.function.name ?? message.toolCallId}`
                : message.role === "activity" ? message.activityType : labels[message.role];
            the(row, {
                messageId: message.id,
                messageRole: message.role,
                messageLabel: label,
                messageAuthor: "name" in message ? message.name ?? "" : "",
                messageAttribution: message.subagentRunId ? `Subagent ${message.subagentRunId}` : "",
                messageError: message.role === "tool" ? message.error ?? "" : "",
                callHref: call ? `#${callId(call.id)}` : "",
            });
            body(row, message.content, message.role !== "tool" && message.role !== "activity", `message-${message.id}`);
            tools(row, message.role === "assistant" ? message.toolCalls ?? [] : []);
            if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
        }
    };
}
