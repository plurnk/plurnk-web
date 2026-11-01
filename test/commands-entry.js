import { $, the } from "on_the_money";
import sessionCommands, { isCommand } from "../web/session-commands.js";
import managementAction from "../web/management-action.js";
import sessionSettings from "../web/session-settings.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
$.clone("#session-status", "#session-controls");
const lifetime = new AbortController();
let automatic = false;
const call = (kind, params = {}, signal = lifetime.signal) => managementAction(kind, params, "7#user", "session", signal);
const command = sessionCommands($("#main"), {
    call,
    toggleYolo: async () => { automatic = !automatic; return automatic; },
    stop: async () => "Stop requested.",
});
sessionSettings($("#main"), $("#session-status"), call, () => lifetime.signal);
the($("#session-status"), "lifecycle", "idle");
window.command = (text) => command(text, lifetime.signal);
window.isCommand = isCommand;
window.depart = () => lifetime.abort();
