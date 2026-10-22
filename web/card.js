import { $ } from "on_the_money";

/** {§web-card-disclosure} Native details owns interaction; only a new disclosure receives its default.
 * @param {Element} row @param {boolean} hasBody @param {boolean} [initiallyOpen]
 */
export default function card(row, hasBody, initiallyOpen = false) {
    const article = $(row, ":scope > article");
    if (!article) throw new Error("Card has no article.");
    let disclosure = $(article, ":scope > details");
    let header = $(article, ":scope > header") ?? (disclosure ? $(disclosure, ":scope > summary") : null);
    if (hasBody && !disclosure) {
        disclosure = $.clone(article, "#card-disclosure", { position: "afterbegin" });
        if (!(disclosure instanceof HTMLDetailsElement)) throw new Error("Card disclosure must be details.");
        disclosure.open = initiallyOpen;
        const summary = $(disclosure, "summary");
        if (!summary) throw new Error("Card disclosure has no summary.");
        if (header) { summary.append(...header.childNodes); header.remove(); }
        header = summary;
    } else if (!hasBody && disclosure) {
        const plain = $.clone(article, "#card-header", { position: "afterbegin" });
        if (header) plain.append(...header.childNodes);
        disclosure.remove();
        disclosure = null;
        header = plain;
    }
    header ??= $.clone(article, "#card-header", { position: "afterbegin" });
    return { header, body: disclosure };
}

/** Summary naming must not replace its visible diagnostic with just the operation name.
 * @param {Element} header
 */
export function nameCard(header) {
    if (header.tagName !== "SUMMARY") return;
    const label = header.closest("article")?.ariaLabel;
    header.ariaLabel = [label, ...Array.from(header.children, (field) => field.textContent)].filter(Boolean).join(" · ");
}
