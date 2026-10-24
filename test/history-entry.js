import { the } from "on_the_money";
import WorkerAgent from "../web/worker-agent.js";
import workerHistory from "../web/worker-history.js";
import readHistory from "../web/read-history.js";
import readBody from "../web/read-body.js";

await the.boot({ persistKeys: [] });
const resources = new AbortController();
const history = workerHistory(document.querySelector("#worker-conversation"), document.querySelector("main"),
    (address) => readBody(address, "session", resources.signal),
    (address, signal) => readHistory(address, "session", AbortSignal.any([signal, resources.signal])));
window.agent = new WorkerAgent({ url: "/acp", threadId: "7#user" });
window.run = () => window.agent.runAgent({}, {
    onMessagesSnapshotEvent: ({ event }) => history.snapshot(event),
    onMessagesChanged: ({ messages }) => history.present(messages),
});
window.stopHistory = () => { history.pause(); resources.abort(); };
