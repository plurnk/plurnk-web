import hljs from "highlight.js/lib/common";
import { the } from "on_the_money";
import "./styles/code-highlight.css";

// {§web-code-content} Highlight.js scopes collapse onto a small palette registered with the CSS Custom Highlight API.
/** @type {Readonly<Record<string, string>>} */
const CATEGORY = {
    keyword: "keyword", "selector-tag": "keyword", doctag: "keyword", section: "keyword", name: "keyword",
    built_in: "type", type: "type", "title.class_": "type", "title.class_.inherited__": "type", "selector-class": "type",
    literal: "number", number: "number", symbol: "number", "selector-id": "number",
    string: "string", regexp: "string", "template-tag": "string", "char.escape_": "string", link: "string", code: "string",
    comment: "comment", quote: "comment", meta: "meta", "meta.prompt_": "meta", bullet: "meta",
    title: "title", "title.function_": "title", "title.function_.invoke__": "title",
    attr: "attribute", attribute: "attribute", property: "attribute", "selector-attr": "attribute", "selector-pseudo": "attribute",
    variable: "variable", "variable.language_": "keyword", "variable.constant_": "number", "template-variable": "variable", params: "variable",
    addition: "inserted", deletion: "deleted",
};

/** @type {Readonly<Record<string, string>>} */
const ENTITY = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#x27;": "'" };

/** Read Highlight.js's escaped HTML as a token stream; it never becomes DOM.
 * @param {string} html
 * @returns {{ text: string, spans: [number, number, string][] }}
 */
function tokens(html) {
    /** @type {(string | null)[]} */
    const scopes = [];
    /** @type {[number, number, string][]} */
    const spans = [];
    let text = "";
    for (const [, open, close, entity, literal] of html.matchAll(/<span class="([^"]+)">|(<\/span>)|(&(?:amp|lt|gt|quot|#x27);)|([^<&]+)/gu)) {
        if (open !== undefined) {
            // `hljs-title function_` is scope `title.function_`; an embedded `language-*` span adds no category.
            const scope = open.startsWith("hljs-") ? open.slice("hljs-".length).replaceAll(" ", ".") : "";
            scopes.push(CATEGORY[scope] ?? CATEGORY[scope.split(".")[0]] ?? null);
        } else if (close !== undefined) {
            if (scopes.pop() === undefined) throw new Error("Syntax highlighter closed an unopened scope.");
        } else {
            const piece = entity === undefined ? literal : ENTITY[entity];
            const category = scopes.findLast((scope) => scope !== null);
            if (category !== undefined && category !== null) {
                const previous = spans.at(-1);
                if (previous?.[1] === text.length && previous[2] === category) previous[1] += piece.length;
                else spans.push([text.length, text.length + piece.length, category]);
            }
            text += piece;
        }
    }
    if (scopes.length) throw new Error("Syntax highlighter left a scope open.");
    return { text, spans };
}

/** @param {string} category */
function registry(category) {
    const name = `plurnk-code-${category}`;
    let highlight = CSS.highlights.get(name);
    if (!highlight) CSS.highlights.set(name, highlight = new Highlight());
    return highlight;
}

/** {§web-code-content} Ranges over each outlet's own text node; detached generations release theirs.
 * @param {readonly Element[]} outlets
 */
export default function highlight(outlets) {
    for (const entry of CSS.highlights.values()) {
        for (const range of entry) if (!(range instanceof Range) || !range.startContainer.isConnected) entry.delete(range);
    }
    for (const outlet of outlets) {
        const language = outlet.getAttribute("data-code-lang") ?? "";
        const node = outlet.firstChild;
        if (!hljs.getLanguage(language) || !(node instanceof Text) || outlet.childNodes.length !== 1) {
            the(outlet, "codeHighlighted", "");
            continue;
        }
        const { text, spans } = tokens(hljs.highlight(node.data, { language, ignoreIllegals: true }).value);
        if (text !== node.data) throw new Error("Syntax highlighter changed the code it was given.");
        for (const [start, end, category] of spans) {
            const range = new Range();
            range.setStart(node, start);
            range.setEnd(node, end);
            registry(category).add(range);
        }
        the(outlet, "codeHighlighted", "");
    }
}
