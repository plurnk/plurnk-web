import { the } from "on_the_money";
import activity from "../web/session-activity.js";
import readBody from "../web/read-body.js";

await the.boot({ persistKeys: [] });
const lifetime = new AbortController();
window.presentActivity = activity(document.querySelector("#session-activity"),
    (address) => readBody(address, "session", lifetime.signal));
window.leaveActivity = () => lifetime.abort();
