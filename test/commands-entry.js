import { $, the } from "on_the_money";
import workerCommands from "../web/worker-commands.js";
import managementAction from "../web/management-action.js";
import workerSettings from "../web/worker-settings.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
$.clone("#worker-status", "#worker-controls");
const lifetime = new AbortController();
let automatic = false;
const call = (kind, params = {}, signal = lifetime.signal) => managementAction(kind, params, "7#user", "session", signal);
const command = workerCommands($("#main"), {
    call,
    toggleYolo: async () => { automatic = !automatic; return automatic; },
    stop: async () => "Stop requested.",
});
workerSettings($("#main"), $("#worker-status"), call, () => lifetime.signal);
the($("#worker-status"), "lifecycle", "idle");
window.command = (text) => command(text, lifetime.signal);
window.depart = () => lifetime.abort();
