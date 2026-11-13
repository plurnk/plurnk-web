import { $, $$, on, the } from "on_the_money";

// {§web-diagram-content} One compilation at a time from this page: bodies full of diagrams wait their turn rather than
// exceed the service's admission.
let turn = Promise.resolve();

/** A refusal for capacity or time, or a lost request, may succeed later; any other failure stays. */
class Busy extends Error {}

/** @param {string} source @returns {Promise<string>} */
function compile(source) {
    const result = turn.then(async () => {
        let response;
        try {
            response = await fetch("/render/mermaid", { method: "POST", credentials: "same-origin", mode: "same-origin",
                headers: { "content-type": "application/json", accept: "image/svg+xml" }, body: JSON.stringify({ source }) });
        } catch (cause) {
            throw new Busy("The diagram request did not complete.", { cause });
        }
        if (!response.ok) {
            const problem = await response.json();
            const message = problem.detail ?? problem.title ?? `Diagram request failed (${response.status}).`;
            throw [408, 429, 503].includes(response.status) ? new Busy(message) : new Error(message);
        }
        if (response.headers.get("content-type") !== "image/svg+xml") throw new Error("Diagram service did not return an SVG image.");
        return response.text();
    });
    turn = result.then(() => undefined, () => undefined);
    return result;
}

/** @param {Element} outlet @param {unknown} error */
function failed(outlet, error) {
    the(outlet, "diagramError", "Diagram failed to render");
    outlet.setAttribute("title", String(error));
    if (error instanceof Busy && outlet.nextElementSibling?.hasAttribute("data-diagram-retry") !== true) $.clone(outlet, "#diagram-retry", { position: "afterend" });
}

/** @param {Element} outlet */
async function render(outlet) {
    const code = $(outlet, "code");
    if (!code) throw new Error("Diagram outlet lost its source.");
    let svg;
    try { svg = await compile(code.textContent ?? ""); }
    catch (error) {
        if (outlet.isConnected) failed(outlet, error);
        return;
    }
    if (!outlet.isConnected) return;
    const figure = $.clone(outlet, "#conversation-diagram", { position: "beforebegin" });
    const image = $(figure, "img");
    const source = $(figure, "[data-diagram-source]");
    if (!(image instanceof HTMLImageElement) || !(figure instanceof HTMLElement) || !source) throw new Error("Diagram template is incomplete.");
    source.textContent = code.textContent;
    // One copy of the SVG: the image's own source, not a state attribute it is projected from.
    image.setAttribute("src", `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    try { await image.decode(); }
    catch (error) {
        figure.remove();
        failed(outlet, error);
        return;
    }
    if (!outlet.isConnected) { figure.remove(); return; }
    outlet.replaceWith(figure);
    figure.hidden = false;
}

// {§web-diagram-content} A diagram refused for capacity or time is offered again, never retried automatically.
on(document, "click", "[data-diagram-retry]", (event) => {
    const retry = event.target instanceof Element ? event.target.closest("[data-diagram-retry]") : null;
    const outlet = retry?.previousElementSibling;
    if (!retry || !outlet?.hasAttribute("data-mermaid")) return;
    retry.remove();
    the(outlet, "diagramError", null);
    outlet.removeAttribute("title");
    void render(outlet).catch(reportError);
});

/** {§web-diagram-content} Generated SVG is an image, never application markup.
 * @param {DocumentFragment | Element} fragment
 */
export default async function mermaid(fragment) {
    const outlets = $$(fragment, "[data-mermaid]:not([data-diagram-error])");
    if (!outlets.length) return;
    // Markdown inserts the fragment synchronously after starting enhancements.
    await Promise.resolve();
    for (const outlet of outlets) if (outlet.isConnected) await render(outlet);
}
