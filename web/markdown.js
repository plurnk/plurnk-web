import { Marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import math, { mathExtension } from "./math.js";

// {§web-conversation-content} Raw HTML stays text; images never fetch while a conversation renders.
const parser = new Marked(mathExtension, {
    renderer: {
        html: ({ text }) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
        image(token) { return this.link({ ...token, type: "link" }); },
        table(token) { return `<figure>${Renderer.prototype.table.call(this, token)}</figure>`; },
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
        ALLOWED_ATTR: ["href", "title", "start", "align", "type", "checked", "disabled", "data-math"],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
    });
    void math(fragment).catch(reportError);
    return fragment;
}
