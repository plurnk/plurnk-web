import { Marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import math, { mathExtension } from "./math.js";
import mermaid from "./mermaid.js";

// {§web-conversation-content} Raw HTML stays text; authored images never fetch during rendering.
const parser = new Marked(mathExtension, {
    renderer: {
        html: ({ text }) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
        image(token) { return this.link({ ...token, type: "link" }); },
        table(token) { return `<figure>${Renderer.prototype.table.call(this, token)}</figure>`; },
        code(token) {
            const content = Renderer.prototype.code.call(this, token);
            return /^mermaid(?:\s|$)/iu.test(token.lang?.trim() ?? "") ? `<figure data-mermaid>${content}</figure>` : content;
        },
    },
});

/** {§web-conversation-content} This allowlist also supplies Markdown element names to CSS pruning.
 * @param {string} source
 */
export default function markdown(source) {
    const fragment = DOMPurify.sanitize(parser.parse(source, { async: false }), {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li",
            "pre", "code", "em", "strong", "del", "a", "table", "thead", "tbody", "tr", "th", "td", "input", "figure", "span"],
        ALLOWED_ATTR: ["href", "title", "start", "align", "type", "checked", "disabled", "data-math", "data-mermaid"],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
    });
    void math(fragment).catch(reportError);
    void mermaid(fragment).catch(reportError);
    return fragment;
}
