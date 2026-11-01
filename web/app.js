import { $, the } from "on_the_money";
import initDialogs from "./dialogs.js";

await the.boot({
    locale: document.documentElement.lang,
    defaultLocale: document.documentElement.lang,
    persistKeys: [],
});

initDialogs();

const session = $("#session-status");
if (session instanceof HTMLElement) (await import("./session.js")).default(session);
