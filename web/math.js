import { $$, the } from "on_the_money";
import DOMPurify from "dompurify";

/** {§web-math-content} Delimiting belongs to Markdown; TeX interpretation belongs to Temml.
 * @param {string} source
 */
function formula(source) {
    const open = /^(\$\$|\\\[|\\\(|\$)/u.exec(source)?.[0];
    if (!open) return;
    const close = open === "\\[" ? "\\]" : open === "\\(" ? "\\)" : open;
    if (open === "$" && /\s/u.test(source[1] ?? "")) return;
    let braces = 0;
    for (let end = open.length; end < source.length; end++) {
        if (open === "$" && source[end] === "\n") return;
        if (braces === 0 && source.startsWith(close, end)) {
            if (open === "$" && (/\s/u.test(source[end - 1]) || /\d/u.test(source[end + 1] ?? ""))) return;
            const text = source.slice(open.length, end).trim();
            if (!text) return;
            return { raw: source.slice(0, end + close.length), text, display: open === "$$" || open === "\\[" };
        }
        if (source[end] === "\\") end++;
        else if (source[end] === "{") braces++;
        else if (source[end] === "}") braces = Math.max(0, braces - 1);
    }
}

/** @param {string} value */
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** @type {import("marked").MarkedExtension} */
export const mathExtension = {
    extensions: ["block", "inline"].map((level) => ({
        name: `math-${level}`,
        level: /** @type {"block" | "inline"} */ (level),
        start: (source) => level === "block" ? source.match(/(?:^|\n) {0,3}(?:\$\$|\\\[)/u)?.index : source.search(/\$|\\[[(]/u),
        tokenizer(source) {
            const leading = level === "block" ? /^( {0,3})(?=\$\$|\\\[)/u.exec(source)?.[0] : "";
            if (leading === undefined) return;
            const match = formula(source.slice(leading.length));
            if (!match || (level === "block" && !/^\s*(?:\n|$)/u.test(source.slice(leading.length + match.raw.length)))) return;
            return { type: `math-${level}`, ...match, raw: leading + match.raw };
        },
        renderer: (token) => `<span data-math="${token.display ? "block" : "inline"}"><code>${escape(token.raw)}</code></span>`,
    })),
};

/** @type {Promise<typeof import("./math-renderer.js")> | undefined} */
let renderer;

/** {§web-math-content} Enhance only generated outlets; a detached generation cannot update its successor.
 * @param {DocumentFragment} fragment
 */
export default async function math(fragment) {
    const outlets = $$(fragment, "[data-math]");
    if (!outlets.length) return;
    let temml;
    try { ({ default: temml } = await (renderer ??= import("./math-renderer.js"))); }
    catch (error) {
        for (const outlet of outlets) the(outlet, "mathError", "Math unavailable");
        throw error;
    }
    for (const outlet of outlets) {
        if (!outlet.isConnected) continue;
        const match = formula(outlet.textContent.trimStart());
        if (!match) throw new Error("Math outlet lost its delimited source.");
        const rendered = /** @type {HTMLElement} */ (outlet.cloneNode(false));
        try {
            temml.render(match.text, rendered, { displayMode: match.display, annotate: true, trust: false, throwOnError: true, macros: {} });
        } catch (error) {
            if (!(error instanceof temml.ParseError)) throw error;
            the(outlet, "mathError", "Invalid or unsupported math");
            outlet.setAttribute("title", String(error));
            continue;
        }
        DOMPurify.sanitize(rendered, {
            IN_PLACE: true,
            USE_PROFILES: { mathMl: true },
            ADD_TAGS: ["span", "semantics", "annotation", "none"],
            ADD_ATTR: ["class", "style"],
            FORBID_ATTR: ["id", "href", "xlink:href"],
            ALLOW_DATA_ATTR: false,
            ALLOW_ARIA_ATTR: false,
        });
        outlet.replaceChildren(...rendered.childNodes);
    }
}
