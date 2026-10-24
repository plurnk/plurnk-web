import { $, the } from "on_the_money";
import reasoningCoordinate from "./reasoning-coordinate.js";

/** {§web-worker-reasoning} One bounded presentation outlet, never SDK message content.
 * @param {HTMLElement} root @param {number} limit
 */
export default function reasoningPreview(root, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Worker document has no valid reasoning preview limit.");
    const outlet = $.clone(root, "#worker-reasoning-preview");
    const scroll = $(outlet, "pre");
    if (!(scroll instanceof HTMLElement)) throw new Error("Reasoning preview has no text outlet.");
    const clear = () => {
        the(outlet, { reasoningId: "", reasoningCoordinate: "" });
        scroll.replaceChildren();
    };
    clear();

    return {
        clear,
        /** @param {import("@plurnk/plurnk-acp/client").BaseEvent} event */
        consume(event) {
            if (["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR"].includes(event.type)) {
                clear();
            } else if (event.type === "REASONING_MESSAGE_START") {
                const { messageId, metadata } = /** @type {import("@plurnk/plurnk-acp/client").ReasoningMessageStartEvent} */ (event);
                if (!metadata?.plurnk?.body) {
                    clear();
                    the(outlet, { reasoningId: messageId, reasoningCoordinate: reasoningCoordinate(metadata?.plurnk?.coordinate) });
                }
            } else if (event.type === "REASONING_MESSAGE_END") {
                if (/** @type {import("@plurnk/plurnk-acp/client").ReasoningMessageEndEvent} */ (event).messageId === the(outlet, "reasoning-id")) clear();
            } else if (event.type === "CUSTOM") {
                const { name, value } = /** @type {import("@plurnk/plurnk-acp/client").CustomEvent & { value?: { messageId?: unknown, delta?: unknown } }} */ (event);
                if (name !== "plurnk.reasoning") return;
                if (typeof value?.messageId !== "string" || typeof value?.delta !== "string"
                    || value.messageId !== the(outlet, "reasoning-id")) {
                    throw new TypeError("Reasoning preview must name its active message and carry a text delta.");
                }
                const tail = Array.from(scroll.textContent + value.delta).slice(-limit).join("");
                if (scroll.textContent !== tail) scroll.textContent = tail;
                scroll.scrollTop = scroll.scrollHeight;
            }
        },
    };
}
