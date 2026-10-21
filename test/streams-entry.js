import { the } from "on_the_money";
import workerStreams from "../web/worker-streams.js";
import readEntry from "../web/read-entry.js";

await the.boot({ persistKeys: [] });
const lifetime = new AbortController();
const streams = workerStreams(document.querySelector("#worker-streams"),
    (target) => readEntry(target, "7#user", "session", lifetime.signal));
window.streamEvent = (value) => streams.consume({ type: "CUSTOM", name: "plurnk.stream", value });
window.leaveStreams = () => lifetime.abort();
