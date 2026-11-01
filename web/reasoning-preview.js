import { $, the } from "on_the_money";
import reasoningCoordinate from "./reasoning-coordinate.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** {§web-session-reasoning} One bounded presentation outlet, never SDK message content.
 * @param {HTMLElement} root @param {number} limit
 */
export default function reasoningPreview(root, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Session document has no valid reasoning preview limit.");
    const outlet = $.clone(root, "#session-reasoning-preview");
    const scroll = $(outlet, "pre");
    if (!(scroll instanceof HTMLElement)) throw new Error("Reasoning preview has no text outlet.");
    const text = scroll;
    const clear = () => {
        the(outlet, { reasoningId: "", reasoningCoordinate: "" });
        text.replaceChildren();
    };
    clear();

    return {
        clear,
        /** @param {import("./session-agent.js").AcpSessionUpdate} update */
        consume(update) {
            if (
                update.sessionUpdate === "state_update"
                || update.sessionUpdate === "tool_call"
                || update.sessionUpdate === "tool_call_update"
                || update.sessionUpdate === "agent_message_chunk"
                || (update.sessionUpdate === "notice"
                    && isRecord(update._meta)
                    && isRecord(update._meta.plurnk)
                    && isRecord(update._meta.plurnk.notice)
                    && update._meta.plurnk.notice.kind === "turn_generated")
            ) {
                clear();
                return;
            }
            if (update.sessionUpdate !== "agent_thought_chunk") return;
            const block = isRecord(update.content) ? update.content : undefined;
            const metaPlurnk = isRecord(update._meta) && isRecord(update._meta.plurnk)
                ? update._meta.plurnk
                : undefined;
            const coordinate = metaPlurnk?.coordinate;
            const body = metaPlurnk?.body;
            if (block?.type === "resource_link" || body !== undefined) {
                if (update.messageId === the(outlet, "reasoning-id")) clear();
                return;
            }
            if (typeof update.messageId !== "string" || !update.messageId
                || block?.type !== "text" || typeof block.text !== "string") {
                throw new TypeError("Reasoning preview must name its active message and carry a text delta.");
            }
            if (update.messageId !== the(outlet, "reasoning-id")) {
                clear();
                the(outlet, { reasoningId: update.messageId, reasoningCoordinate: reasoningCoordinate(coordinate) });
            }
            if (block.text) {
                const tail = Array.from(text.textContent + block.text).slice(-limit).join("");
                if (text.textContent !== tail) text.textContent = tail;
                text.scrollTop = text.scrollHeight;
            }
        },
    };
}
