import "../web/schema-validation.js";
import { HttpAgent } from "@ag-ui/client";

export { HttpAgent };

// The public SDK connection hook chooses the daemon's non-controlling endpoint.
export class Observer extends HttpAgent {
    connect(input) {
        this.abortController = new AbortController();
        return super.run({ ...input, messages: [] });
    }
}
