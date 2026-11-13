import { $, the } from "on_the_money";
import initDialogs from "./dialogs.js";

await the.boot({
    locale: document.documentElement.lang,
    defaultLocale: document.documentElement.lang,
    persistKeys: [],
});

initDialogs();

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
