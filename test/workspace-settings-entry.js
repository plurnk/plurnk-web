import { $, the } from "on_the_money";
import sessionCommands from "../web/session-commands.js";
import managementAction from "../web/management-action.js";
import observeWorkspaceSettings from "../web/workspace-settings.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const lifetime = new AbortController();
const main = $("#main");

if (main instanceof HTMLElement && main.dataset.page === "settings") {
    observeWorkspaceSettings(main);
} else if (main instanceof HTMLElement) {
    let sessionName = /** @type {string | null} */ (main.dataset.sessionName || "session1");
    const tabsNav = $("#workspace-tabs");
    if (tabsNav instanceof HTMLElement) tabsNav.dataset.live = "true";

    const call = (kind, params = {}, signal = lifetime.signal) =>
        managementAction(kind, params, sessionName ? `7#${sessionName}` : "", "session", signal, { workspaceId: 7 });

    const command = sessionCommands(main, {
        call,
        toggleYolo: async () => false,
        stop: async () => "Stop requested.",
    });

    window.setSessionContext = (/** @type {string | null} */ next) => {
        sessionName = next;
        main.dataset.sessionName = next ?? "";
    };
    window.runCommand = (/** @type {string} */ text) => command(text, lifetime.signal);
}
