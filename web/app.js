import { $, $$, on, the } from "on_the_money";
import initDialogs from "./dialogs.js";

let unloading = false;
on.target(window, "beforeunload", () => { unloading = true; });
on.target(window, "pagehide", () => { unloading = true; });

await the.boot({
    locale: document.documentElement.lang,
    defaultLocale: document.documentElement.lang,
    persistKeys: [],
});

initDialogs();

on.target(window, "keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented || event.isComposing || event.repeat) return;
    const modOnly = (event.metaKey !== event.ctrlKey) && !event.altKey && !event.shiftKey;
    if (!modOnly || (event.code !== "KeyK" && event.key.toLowerCase() !== "k")) return;
    if ($("#workspace-tabs") || $("dialog[open]")) return;
    event.preventDefault();
    const searchInput = $("input[data-overview-search]");
    if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
        searchInput.select();
    } else {
        location.assign("/search/");
    }
});

try {
    const accountArticle = $("#account-settings");
    const settingsMain = $('#main[data-page="settings"]');
    const tabs = $("#workspace-tabs");
    if (accountArticle instanceof HTMLElement) {
        const syncAccountTab = () => {
            const target = location.hash === "#about" ? "about" : "sign-ins";
            for (const link of $$(accountArticle, "[data-account-section]")) {
                if (link.getAttribute("data-account-section") === target) link.setAttribute("aria-current", "true");
                else link.removeAttribute("aria-current");
            }
        };
        syncAccountTab();
        on.target(window, "hashchange", syncAccountTab);
    } else if (settingsMain instanceof HTMLElement) {
        (await import("./workspace-settings.js")).default(settingsMain);
    } else if (tabs instanceof HTMLElement) {
        await (await import("./workspace-workbench.js")).default(tabs);
    } else {
        const session = $("#session-status");
        if (session instanceof HTMLElement) (await import("./session.js")).default(session);
        else {
            const overview = $("#main[data-auth]");
            if (overview instanceof HTMLElement) (await import("./overview.js")).default(overview);
        }
    }
} catch (error) {
    if (!unloading) throw error;
}
