import { render, RenderError } from "ondine/compiler";

const DARK_DIAGRAM_STYLE = "<style>@media(prefers-color-scheme:dark){:root{--ondine-bg:#181c25;--ondine-fg:#e6edf3;--ondine-muted:#9fb0c7;--ondine-line:#c2cfe0;--ondine-surface:#1f2633;--ondine-border:#8b98ad;--ondine-accent:#72cc46}}</style>";

/** @param {string} svg */
function withDarkTheme(svg) {
    const openEnd = svg.indexOf(">");
    return openEnd === -1 ? svg : `${svg.slice(0, openEnd + 1)}${DARK_DIAGRAM_STYLE}${svg.slice(openEnd + 1)}`;
}

/** {§web-diagram-service} This synchronous compiler runs only in a Piscina thread.
 * @param {{ source: string, limit: number, outputLimit: number, maxEdges: number }} input
 */
export default function compile({ source, ...limits }) {
    try {
        const { svg } = render(source, { ...limits, autoDirection: false, responsive: false });
        const themed = withDarkTheme(svg);
        if (Buffer.byteLength(themed) > limits.outputLimit) return { error: "Diagram output exceeds the configured limit." };
        return { svg: themed };
    } catch (error) {
        if (!(error instanceof RenderError)) throw error;
        return { error: error.message };
    }
}
