import anchor from "./anchor.js";

/** {§web-footnote-content} Presentation of the extension's public tokens, not a second parser.
 * @param {string} scope
 * @returns {import("marked").MarkedExtension}
 */
export default function footnotes(scope) {
    const prefix = anchor("footnote", scope);
    return {
        extensions: [
            {
                name: "footnoteRef",
                renderer(token) {
                    const { id, index } = /** @type {import("marked-footnote").FootnoteRef} */ (token);
                    const reference = `${prefix}-ref-${id}-${index}`;
                    const definition = `${prefix}-note-${id}`;
                    return `<sup><a id="${reference}" href="#${definition}" aria-label="Footnote ${id}">${id}</a></sup>`;
                },
            },
            {
                name: "footnotes",
                renderer(token) {
                    const { items } = /** @type {import("marked-footnote").Footnotes} */ (token);
                    if (!items.length) return "";
                    const definitions = items.map(({ refs, content }) => {
                        const backlinks = refs.map(({ id, index }) => {
                            const reference = `${prefix}-ref-${id}-${index}`;
                            return `<a href="#${reference}" aria-label="Back to reference ${id}.${index + 1}">↩${index ? `<sup>${index + 1}</sup>` : ""}</a>`;
                        }).join(" ");
                        return `<li id="${prefix}-note-${refs[0].id}" tabindex="-1">${this.parser.parse(content)}<p>${backlinks}</p></li>`;
                    }).join("\n");
                    return `<section aria-label="Footnotes"><ol>${definitions}</ol></section>`;
                },
            },
        ],
    };
}
