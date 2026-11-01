import { $, on, the } from "on_the_money";
import describeFailure from "./failure.js";

/** {§web-session-streams} Output snapshots belong to their DOM outlet, not the SDK's messages.
 * @param {HTMLElement} root
 * @param {(target: string) => Promise<import("@plurnk/plurnk-contracts").ClientEntry>} read
 */
export default function entryOutput(root, read) {
    on(root, "click", '[data-action="read-output"]', async (_event, button) => {
        const output = button.closest("[data-entry-output]");
        const row = output?.closest("[data-stream-target]");
        const target = row && the(row, "stream-target");
        if (!output || !target) throw new Error("Output control has no stream.");
        if (the(output, "output-state") === "loading") return;
        the(output, { outputState: "loading", outputError: "", outputPending: "" });
        try {
            const entry = await read(target);
            if (!output.isConnected) return;
            const list = $(output, "ul");
            if (!list) throw new Error("Output snapshot has no channel outlet.");
            $.cloneEach(list, "#stream-output-channel", Object.entries(entry.channels), (channel, [name, value]) => {
                the(channel, {
                    outputChannel: name, outputMime: value.mimetype,
                    outputChannelState: value.state, outputLength: value.contentLength, outputOffset: value.contentOffset,
                });
                const content = $(channel, "[data-output-content]");
                if (!content) throw new Error("Output channel has no content outlet.");
                content.textContent = value.content;
            });
            the(output, { outputState: "loaded", outputLoaded: "true" });
        } catch (error) {
            if (!output.isConnected) return;
            if (error instanceof DOMException && error.name === "AbortError") the(output, "output-state", "idle");
            else {
                const { message, recovery } = await describeFailure(error);
                if (output.isConnected) the(output, { outputState: "error", outputError: [message, recovery].filter(Boolean).join(" ") });
            }
        } finally {
            if (output.isConnected) the(output, "output-pending", null);
        }
    });

    /** @param {Element} row */
    return (row) => {
        const output = $.clone(row, "#stream-output");
        the(output, { outputState: "idle", outputError: "", outputLoaded: "false" });
    };
}
