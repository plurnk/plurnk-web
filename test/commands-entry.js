import { $, the } from "on_the_money";
import workerCommands from "../web/worker-commands.js";
import managementAction from "../web/management-action.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const controls = $.clone("#main", "#worker-controls");
const lifetime = new AbortController();
let automatic = false;
const command = workerCommands(controls, {
    call: (kind, params = {}) => managementAction(kind, params, "7#user", "session", lifetime.signal),
    toggleYolo: async () => { automatic = !automatic; return automatic; },
    stop: async () => "Stop requested.",
});
window.command = (text) => command(text, lifetime.signal);
window.depart = () => lifetime.abort();
