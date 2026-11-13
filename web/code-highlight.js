import { $$, the } from "on_the_money";

// {§web-code-content} Info strings that name no language never load the highlighter.
const PLAIN = new Set(["text", "txt", "plain", "plaintext", "mermaid"]);

/** {§web-code-content} The fence's first info-string word, when it can name a language.
 * @param {string | undefined} info
 */
export function codeLanguage(info) {
    const word = /^\S*/u.exec(info?.trim() ?? "")?.[0].toLowerCase() ?? "";
    return /^[a-z0-9][a-z0-9_+#.-]*$/u.test(word) && !PLAIN.has(word) ? word : null;
}

/** @type {Promise<typeof import("./code-highlight-renderer.js")> | undefined} */
let renderer;

/** {§web-code-content} Highlight generated code outlets once they are in the document; detached outlets stay untouched.
 * @param {DocumentFragment | Element} fragment
 */
export default async function highlightCode(fragment) {
    const outlets = $$(fragment, "pre > code[data-code-lang]:not([data-code-highlighted]):not([data-code-error])");
    if (!outlets.length) return;
    let highlight;
    try { ({ default: highlight } = await (renderer ??= import("./code-highlight-renderer.js"))); }
    catch (error) {
        for (const outlet of outlets) the(outlet, "codeError", "Syntax highlighting unavailable");
        throw error;
    }
    // Markdown inserts the fragment synchronously after starting enhancements.
    await Promise.resolve();
    highlight(outlets.filter((outlet) => outlet.isConnected));
}
