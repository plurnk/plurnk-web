import { render, RenderError } from "ondine/compiler";

/** {§web-diagram-service} This synchronous compiler runs only in a Piscina thread.
 * @param {{ source: string, limit: number, outputLimit: number, maxEdges: number }} input
 */
export default function compile({ source, ...limits }) {
    try {
        const { svg } = render(source, { ...limits, autoDirection: false, responsive: false });
        if (Buffer.byteLength(svg) > limits.outputLimit) return { error: "Diagram output exceeds the configured limit." };
        return { svg };
    } catch (error) {
        if (!(error instanceof RenderError)) throw error;
        return { error: error.message };
    }
}
