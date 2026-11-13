import { $, on, the } from "on_the_money";
import { SAFE_RASTER_IMAGE_MIMES, mountRasterImage } from "./inline-images.js";

/** @typedef {{ uri: string, mimeType?: string, label?: string }} PendingReference */

/** {§web-result-bodies} {§web-inline-images} Visibility loads content, not a protocol inspector.
 * @param {HTMLElement} root @param {(address: string) => Promise<string>} read
 */
export default function bodyReferences(root, read) {
    /** @type {Map<Element, PendingReference>} */
    const pending = new Map();
    const observer = new IntersectionObserver((entries) => {
        for (const { target, isIntersecting } of entries) {
            if (!isIntersecting || !target.isConnected) continue;
            const entry = pending.get(target);
            observer.unobserve(target);
            pending.delete(target);
            if (entry !== undefined) void load(target, entry);
        }
    });

    /** @param {Element} outlet @param {PendingReference} entry */
    async function load(outlet, entry) {
        the(outlet, { bodyState: "loading", bodyPending: "true" });
        outlet.removeAttribute("role");
        outlet.replaceChildren();
        try {
            const raw = await read(entry.uri);
            if (!outlet.isConnected) return;
            if (entry.mimeType && SAFE_RASTER_IMAGE_MIMES.has(entry.mimeType)) {
                await mountRasterImage(outlet, raw, entry.label);
                if (!outlet.isConnected) return;
            } else {
                outlet.textContent = raw;
            }
            the(outlet, "bodyState", "loaded");
        } catch (error) {
            if (!outlet.isConnected) return;
            // A read the page abandoned, as when it is left, is not a failure: it rests, and reads again when asked.
            if (error instanceof DOMException && error.name === "AbortError") {
                the(outlet, "bodyState", "idle");
                const again = $.clone(outlet, "#conversation-body-read", { position: "afterend" });
                on(again, "submit", "form", (event) => { event.preventDefault(); again.remove(); void load(outlet, entry); });
                return;
            }
            outlet.textContent = error instanceof Error ? error.message : String(error);
            outlet.setAttribute("role", "alert");
            the(outlet, "bodyState", "error");
            const retry = $.clone(outlet, "#conversation-body-retry", { position: "afterend" });
            on(retry, "submit", "form", (event) => { event.preventDefault(); retry.remove(); void load(outlet, entry); });
        } finally {
            if (outlet.isConnected) the(outlet, "bodyPending", null);
        }
    }

    return {
        /** @param {Element} outlet @param {{uri: string, mimeType?: string, name?: string}} source @param {string} [label] */
        append(outlet, source, label) {
            const normalizedMime = source.mimeType?.toLowerCase();
            const isRasterImage = normalizedMime !== undefined && SAFE_RASTER_IMAGE_MIMES.has(normalizedMime);
            const body = isRasterImage
                ? $.clone(outlet, "#conversation-image-reference")
                : $.clone(outlet, "#conversation-body-reference");
            const effectiveLabel = label ?? source.name;
            if (effectiveLabel) body.setAttribute("aria-label", effectiveLabel);
            pending.set(body, { uri: source.uri, mimeType: normalizedMime, label: effectiveLabel });
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
