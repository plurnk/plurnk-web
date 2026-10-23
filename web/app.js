import { $, the } from "on_the_money";
import initDialogs from "./dialogs.js";

await the.boot({
    locale: document.documentElement.lang,
    defaultLocale: document.documentElement.lang,
    persistKeys: [],
});

initDialogs();

const worker = $("#worker-status");
if (worker instanceof HTMLElement) (await import("./worker.js")).default(worker);
