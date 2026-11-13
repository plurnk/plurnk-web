import { $, on, the } from "on_the_money";
import sessionCommands from "../web/session-commands.js";
import managementAction from "../web/management-action.js";
import { createWorkspaceSettingsController, isSettingsSection } from "../web/workspace-settings.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const lifetime = new AbortController();
let sessionName = /** @type {string | null} */ (null);
const tabsNav = $("#workspace-tabs");
if (tabsNav instanceof HTMLElement) tabsNav.dataset.live = "true";

const settings = createWorkspaceSettingsController(() => ({
    workspaceId: 7,
    workspaceName: "conversation",
    sessionName,
    auth: "session",
    signal: lifetime.signal,
}));

on($("#workspace-tabs"), "click", "[data-workspace-settings]", () => {
    settings.open();
});

on(document.body, "click", "[data-open-workspace-settings]", (_event, btn) => {
    const raw = btn.getAttribute("data-open-workspace-settings");
    settings.open(isSettingsSection(raw) ? raw : undefined);
});

const call = (kind, params = {}, signal = lifetime.signal) =>
    managementAction(kind, params, sessionName ? `7#${sessionName}` : "", "session", signal, { workspaceId: 7 });

const command = sessionCommands($("#main"), {
    call,
    toggleYolo: async () => false,
    stop: async () => "Stop requested.",
});

window.setSessionContext = (/** @type {string | null} */ next) => {
    sessionName = next;
};
window.runCommand = (/** @type {string} */ text) => command(text, lifetime.signal);
window.openSettings = (/** @type {string | undefined} */ section) => {
    settings.open(isSettingsSection(section) ? section : undefined);
};
