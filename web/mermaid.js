import { $, $$, the } from "on_the_money";

/** @type {Promise<typeof import("./mermaid-renderer.js")> | undefined} */
let renderer;

/** {§web-diagram-content} Generated SVG is an image, never application markup.
 * @param {DocumentFragment} fragment
 */
export default async function mermaid(fragment) {
    const outlets = $$(fragment, "[data-mermaid]");
    if (!outlets.length) return;
    let render;
    try { ({ default: render } = await (renderer ??= import("./mermaid-renderer.js"))); }
    catch (error) {
        for (const outlet of outlets) the(outlet, "diagramError", "Diagram unavailable");
        throw error;
    }
    for (const outlet of outlets) {
        if (!outlet.isConnected) continue;
        const code = $(outlet, "code");
        if (!code) throw new Error("Diagram outlet lost its source.");
        let svg;
        try { svg = render(code.textContent, { font: "monospace" }); }
        catch (error) {
            the(outlet, "diagramError", "Diagram failed to render");
            outlet.setAttribute("title", String(error));
            continue;
        }
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
