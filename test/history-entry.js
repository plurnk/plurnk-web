import { the } from "on_the_money";
import SessionAgent from "../web/session-agent.js";
import sessionHistory from "../web/session-history.js";
import readHistory from "../web/read-history.js";
import readBody from "../web/read-body.js";

await the.boot({ persistKeys: [] });
const resources = new AbortController();
const history = sessionHistory(document.querySelector("#session-conversation"), document.querySelector("main"),
    (address) => readBody(address, "session", resources.signal),
    (address, signal) => readHistory(address, "session", AbortSignal.any([signal, resources.signal])));
window.agent = new SessionAgent({ url: "/acp", sessionId: "7#user" });
window.run = () => window.agent.resume({}, {
    onMessagesSnapshot: ({ snapshot }) => history.snapshot(snapshot),
    onMessagesChanged: ({ messages }) => history.present(messages),
});
window.stopHistory = () => { history.pause(); resources.abort(); };
