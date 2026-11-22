import { $, the } from "on_the_money";
import initDialogs from "../web/dialogs.js";
import sessionCommands, {
    acceptCommandSuggestion,
    computeCommandSuggestions,
    expandPromptCommand,
    extractOpenPaths,
    isCommand,
    isLocalExec,
    prepareComposerPrompt,
} from "../web/session-commands.js";
import managementAction from "../web/management-action.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
initDialogs();
$.clone("#session-status", "#session-controls");
const lifetime = new AbortController();
let automatic = false;
window.lastNavigated = null;
const call = (kind, params = {}, signal = lifetime.signal) => managementAction(kind, params, "7#session1", "session", signal);
const command = sessionCommands($("#main"), {
    call,
    toggleYolo: async () => { automatic = !automatic; return automatic; },
    stop: async () => "Stop requested.",
    navigate: (path) => { window.lastNavigated = path; },
});
the($("#session-status"), "lifecycle", "idle");
window.command = (text) => command(text, lifetime.signal);
window.isCommand = isCommand;
window.isLocalExec = isLocalExec;
window.extractOpenPaths = extractOpenPaths;
window.prepareComposerPrompt = prepareComposerPrompt;
window.expandPromptCommand = expandPromptCommand;
window.computeCommandSuggestions = computeCommandSuggestions;
window.acceptCommandSuggestion = acceptCommandSuggestion;
window.depart = () => lifetime.abort();
