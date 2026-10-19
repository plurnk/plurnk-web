import "./schema-validation.js";
import { HttpAgent } from "@ag-ui/client";

// {§web-browser-security} Browser SDK imports share the same pre-schema initialization.
export { buildResumeArray, randomUUID } from "@ag-ui/client";

// {§web-worker-questions} Controlling Runs declare only implemented interaction handlers.
export const interactionTools = [
    { name: "question", description: "Ask the user for clarification.", parameters: { type: "object" } },
    { name: "mcp_input_required", description: "Request input for an MCP operation.", parameters: { type: "object" } },
];

/** {§web-worker-observer} HttpAgent's public hook also accepts the passive connection endpoint. */
export default class WorkerAgent extends HttpAgent {
    /** @param {Parameters<HttpAgent["run"]>[0]} input */
    connect(input) {
        return super.run(input);
    }
}
