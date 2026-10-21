import { $, on, the } from "on_the_money";

/** {§web-result-bodies} Visibility loads content, not a protocol inspector.
 * @param {HTMLElement} root @param {(address: string) => Promise<string>} read
 */
export default function bodyReferences(root, read) {
    /** @type {Map<Element, string>} */
    const pending = new Map();
    const observer = new IntersectionObserver((entries) => {
        for (const { target, isIntersecting } of entries) {
            if (!isIntersecting || !target.isConnected) continue;
            const address = pending.get(target);
            observer.unobserve(target);
            pending.delete(target);
            if (address !== undefined) void load(target, address);
        }
    });

    /** @param {Element} outlet @param {string} address */
    async function load(outlet, address) {
        the(outlet, { bodyState: "loading", bodyPending: "true" });
        outlet.removeAttribute("role");
        outlet.replaceChildren();
        try {
            const text = await read(address);
            if (!outlet.isConnected) return;
            outlet.textContent = text;
            the(outlet, "bodyState", "loaded");
        } catch (error) {
            if (!outlet.isConnected) return;
            outlet.textContent = error instanceof Error ? error.message : String(error);
            outlet.setAttribute("role", "alert");
            the(outlet, "bodyState", "error");
            const retry = $.clone(outlet, "#conversation-body-retry", { position: "afterend" });
            on(retry, "submit", "form", (event) => { event.preventDefault(); retry.remove(); void load(outlet, address); });
        } finally {
            if (outlet.isConnected) the(outlet, "bodyPending", null);
        }
    }

    return {
        /** @param {Element} outlet @param {{value: string, mimeType?: string}} source @param {string} [label] */
        append(outlet, source, label) {
            const body = $.clone(outlet, "#conversation-body-reference");
            if (label) body.setAttribute("aria-label", label);
            pending.set(body, source.value);
            observer.observe(body);
        },
        prune() {
            for (const [outlet] of pending) {
                if (root.contains(outlet)) continue;
                observer.unobserve(outlet);
                pending.delete(outlet);
            }
        },
    };
}
