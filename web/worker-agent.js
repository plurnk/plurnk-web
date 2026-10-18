import "./schema-validation.js";
import { HttpAgent } from "@ag-ui/client";

// {§web-browser-security} Browser SDK imports share the same pre-schema initialization.
export { randomUUID } from "@ag-ui/client";

/** {§web-worker-observer} HttpAgent's public hook also accepts the passive connection endpoint. */
export default class WorkerAgent extends HttpAgent {
    /** @param {Parameters<HttpAgent["run"]>[0]} input */
    connect(input) {
        return super.run(input);
    }
}
