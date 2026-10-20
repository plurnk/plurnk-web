import { $, on, the } from "on_the_money";

/** {§web-result-bodies} Browser inspection never changes the SDK's conversation.
 * @param {HTMLElement} root @param {(address: string) => Promise<string>} read
 */
export default function bodyReferences(root, read) {
    on(root, "click", '[data-action="read-body"]', async (_event, button) => {
        const reference = button.closest("[data-body-reference]");
        const address = reference && the(reference, "body-address");
        if (!reference || address === null) throw new Error("Body control has no reference.");
        if (the(reference, "body-state") === "loading") return;
        the(reference, { bodyState: "loading", bodyError: "", bodyPending: "" });
        try {
            const text = await read(address);
            if (reference.isConnected) the(reference, { bodyContent: text, bodyState: "loaded" });
        } catch (error) {
            if (!reference.isConnected) return;
            if (error instanceof DOMException && error.name === "AbortError") the(reference, "body-state", "idle");
            else the(reference, { bodyState: "error", bodyError: error instanceof Error ? error.message : String(error) });
        } finally {
            if (reference.isConnected) the(reference, "body-pending", null);
        }
    });

    /** @param {Element} outlet @param {{value: string, mimeType?: string}} source */
    return (outlet, source) => {
        const row = $.clone(outlet, "#conversation-body-reference");
        the(row, { bodyAddress: source.value, bodyMime: source.mimeType ?? "", bodyState: "idle", bodyError: "", bodyContent: "" });
    };
}
