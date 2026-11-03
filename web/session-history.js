import { $, on, the } from "on_the_money";
import conversation from "./conversation.js";
import HistoryPages from "./history-pages.js";

/** {§web-session-history} One renderer for live and archival projections, no SDK writes.
 * @param {HTMLElement} root
 * @param {(address: string) => Promise<string>} readBody
 * @param {(address: string, signal: AbortSignal) => Promise<import("./history-pages.js").Page>} readPage
 */
export default function sessionHistory(root, readBody, readPage) {
    const outlet = $(root, "[data-messages]");
    if (!(outlet instanceof HTMLUListElement)) throw new Error("History has no message list.");
    const list = outlet;
    const renderMessages = conversation(root, readBody);
    const pages = new HistoryPages();
    /** @type {Map<string, Element>} */
    const controls = new Map();
    /** @type {Map<string, AbortController>} */
    const pending = new Map();
    /** @type {Map<string, string>} */
    const errors = new Map();
    let paused = false;

    function render() {
        if (paused) return;
        const { messages, gaps } = pages.view();
        for (const [url] of errors) {
            if (!gaps.some((gap) => gap.url === url) && pages.mutable().includes(url)) gaps.push({ url, before: pages.first(url) });
        }
        const visible = new Set(gaps.map(({ url }) => url));
        const gapStarts = new Set(gaps.flatMap(({ before }) => before ? [before] : []));
        renderMessages(messages, gapStarts);
        for (const [url, control] of controls) if (!visible.has(url)) { control.remove(); controls.delete(url); }
        for (const { url, before } of gaps) {
            let control = controls.get(url);
            if (!control) {
                control = $.clone(list, "#conversation-history");
                controls.set(url, control);
                on(control, "submit", "form", (event) => { event.preventDefault(); void load(url); });
            }
            the(control, { historyPending: pending.has(url) ? "true" : null, historyError: errors.get(url) ?? "" });
            const target = before === null ? null : Array.from(list.children).find((row) =>
                row.getAttribute("data-message-id") === before
                || $(row, `[data-message-id="${CSS.escape(before)}"]`) !== null) ?? null;
            if (control.nextElementSibling !== target) list.insertBefore(control, target);
        }
        the(root, "conversation-empty", messages.length === 0 && gaps.length === 0);
    }

    /** @param {string} url */
    async function load(url) {
        if (pending.has(url) || paused) return;
        const controller = new AbortController();
        pending.set(url, controller);
        errors.delete(url);
        render();
        try {
            const page = await readPage(url, controller.signal);
            controller.signal.throwIfAborted();
            if (pages.accept(url, page)) render();
        } catch (error) {
            if (!controller.signal.aborted) errors.set(url, error instanceof Error ? error.message : String(error));
        } finally {
            if (pending.get(url) === controller) pending.delete(url);
            render();
        }
    }

    return {
        /** @param {{ messages: readonly import("./session-agent.js").Message[], older: unknown }} event */
        snapshot(event) {
            pages.snapshot(event);
            const retained = new Set([...pages.mutable(), ...pages.view().gaps.map(({ url }) => url)]);
            for (const [url, controller] of pending) if (!retained.has(url)) { controller.abort(); pending.delete(url); }
            for (const [url] of errors) if (!retained.has(url)) errors.delete(url);
            for (const url of pages.mutable()) if (!errors.has(url)) void load(url);
        },
        /** @param {readonly import("./session-agent.js").Message[]} messages */
        present(messages) { pages.live(messages); render(); },
        pause() {
            paused = true;
            for (const controller of pending.values()) controller.abort();
            pending.clear();
        },
        resume() { paused = false; },
    };
}
