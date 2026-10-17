import "./schema-validation.js";
import { HttpAgent } from "@ag-ui/client";

/** {§web-worker-observer} HttpAgent's transport hook targets passive connect, never Run. */
export default class WorkerAgent extends HttpAgent {
    /** @param {Parameters<HttpAgent["run"]>[0]} input */
    connect(input) {
        return super.run(input);
    }
}
