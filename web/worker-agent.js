import "./schema-validation.js";
import { HttpAgent } from "@plurnk/plurnk-acp/client";
import refusal from "./problem-response.js";

// {§web-browser-security} Browser SDK imports share the same pre-schema initialization.
export { MessageSchema, buildResumeArray, randomUUID } from "@plurnk/plurnk-acp/client";

// {§web-worker-questions} Controlling Runs declare only implemented interaction handlers.
export const interactionTools = [
    { name: "question", description: "Ask the user for clarification.", parameters: { type: "object" } },
    { name: "mcp_input_required", description: "Request input for an MCP operation.", parameters: { type: "object" } },
];

/** {§web-worker-observer} HttpAgent's public hook also accepts the passive connection endpoint. */
export default class WorkerAgent extends HttpAgent {
    /** {§web-worker-observer} A refusal before the stream opens is the daemon's Problem, not the SDK's text rendering of it.
     * @param {ConstructorParameters<typeof HttpAgent>[0]} config
     */
    constructor(config) {
        const send = config.fetch ?? ((/** @type {RequestInfo | URL} */ url, /** @type {RequestInit} */ init) => fetch(url, init));
        super({ ...config, fetch: async (url, init) => {
            const response = await send(url, init);
            const refused = await refusal(response);
            if (refused) throw refused;
            return response;
        } });
    }

    /** {§web-worker-reasoning} One negotiation boundary for every browser request.
     * @param {Parameters<HttpAgent["run"]>[0]} input
     */
    run(input) {
        const props = /** @type {{ plurnk?: Record<string, unknown> } | undefined} */ (input.forwardedProps);
        return super.run({ ...input, forwardedProps: { ...props,
            plurnk: { ...props?.plurnk, reasoning: "link" },
        } });
    }

    /** @param {Parameters<HttpAgent["run"]>[0]} input */
    connect(input) {
        return this.run(input);
    }
}
