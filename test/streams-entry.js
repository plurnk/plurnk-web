import { the } from "on_the_money";
import sessionStreams from "../web/session-streams.js";
import readEntry from "../web/read-entry.js";

await the.boot({ persistKeys: [] });
const lifetime = new AbortController();
const streams = sessionStreams(document.querySelector("#session-streams"),
    (target) => readEntry(target, "7#user", "session", lifetime.signal));
window.streamEvent = (value) => streams.consume({ sessionUpdate: "terminal_update", terminalId: `term:${value.entryId ?? 0}`, _meta: { plurnk: value } });
window.leaveStreams = () => lifetime.abort();
