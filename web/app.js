import { $, on, the } from "on_the_money";
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

try {
    const tabs = $("#workspace-tabs");
    if (tabs instanceof HTMLElement) {
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
