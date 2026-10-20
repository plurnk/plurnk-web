import { $, $$, the } from "on_the_money";

/** {§web-diagram-content} Generated SVG is an image, never application markup.
 * @param {DocumentFragment} fragment
 */
export default async function mermaid(fragment) {
    const outlets = $$(fragment, "[data-mermaid]");
    if (!outlets.length) return;
    // Markdown inserts the fragment synchronously after starting enhancements.
    await Promise.resolve();
    for (const outlet of outlets) {
        if (!outlet.isConnected) continue;
        const code = $(outlet, "code");
        if (!code) throw new Error("Diagram outlet lost its source.");
        let svg;
        try {
            const response = await fetch("/render/mermaid", { method: "POST", credentials: "same-origin", mode: "same-origin",
                headers: { "content-type": "application/json", accept: "image/svg+xml" }, body: JSON.stringify({ source: code.textContent }) });
            if (!response.ok) {
                const problem = await response.json();
                throw new Error(problem.detail ?? problem.title ?? `Diagram request failed (${response.status}).`);
            }
            if (response.headers.get("content-type") !== "image/svg+xml") throw new Error("Diagram service did not return an SVG image.");
            svg = await response.text();
        }
        catch (error) {
            the(outlet, "diagramError", "Diagram failed to render");
            outlet.setAttribute("title", String(error));
            continue;
        }
        if (!outlet.isConnected) continue;
        const figure = $.clone(outlet, "#conversation-diagram", { position: "beforebegin" });
        const image = $(figure, "img");
        if (!(image instanceof HTMLImageElement) || !(figure instanceof HTMLElement)) throw new Error("Diagram template has no image.");
        the(figure, { diagramSource: code.textContent, diagramUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
        try { await image.decode(); }
        catch (error) {
            figure.remove();
            the(outlet, "diagramError", "Diagram failed to render");
            outlet.setAttribute("title", String(error));
            continue;
        }
        if (!outlet.isConnected) { figure.remove(); continue; }
        outlet.replaceWith(figure);
        figure.hidden = false;
    }
}
