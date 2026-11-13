import { Marked, Renderer } from "marked";
import markedFootnote from "marked-footnote";
import DOMPurify from "dompurify";
import footnotes from "./footnotes.js";
import highlightCode, { codeLanguage } from "./code-highlight.js";
import math, { mathExtension } from "./math.js";
import mermaid from "./mermaid.js";

// {§web-conversation-content} Raw HTML stays text; authored images never fetch during rendering.
/** @type {import("marked").MarkedExtension} */
const presentation = {
    renderer: {
        html: ({ text }) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
        image(token) { return this.link({ ...token, type: "link" }); },
        table(token) { return `<figure>${Renderer.prototype.table.call(this, token)}</figure>`; },
        code(token) {
            if (/^mermaid(?:\s|$)/iu.test(token.lang?.trim() ?? "")) return `<figure data-mermaid>${Renderer.prototype.code.call(this, token)}</figure>`;
            // {§web-code-content} The language marks an outlet for lazy highlighting; Marked's class never reaches the DOM.
            const language = codeLanguage(token.lang);
            const content = Renderer.prototype.code.call(this, { ...token, lang: undefined });
            if (language === null) return content;
            if (!content.startsWith("<pre><code>")) throw new Error("Marked changed its code block markup.");
            return `<pre><code data-code-lang="${language}">${content.slice("<pre><code>".length)}`;
        },
    },
};

/** {§web-conversation-content} This allowlist also supplies Markdown element names to CSS pruning.
 * @param {string} source
 * @param {string} scope
 */
export default function markdown(source, scope) {
    // The footnote extension owns mutable reference counters; each body needs a fresh instance.
    const parser = new Marked(mathExtension, markedFootnote(), footnotes(scope), presentation);
    const fragment = DOMPurify.sanitize(parser.parse(source, { async: false }), {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li",
            "pre", "code", "em", "strong", "del", "a", "table", "thead", "tbody", "tr", "th", "td", "input", "figure", "span", "section", "sup"],
        ALLOWED_ATTR: ["href", "title", "start", "align", "type", "checked", "disabled", "data-math", "data-mermaid", "data-code-lang", "id", "aria-label", "tabindex"],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
    });
    void math(fragment).catch(reportError);
    void mermaid(fragment).catch(reportError);
    void highlightCode(fragment).catch(reportError);
    return fragment;
}
