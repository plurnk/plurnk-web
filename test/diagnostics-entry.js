import { the } from "on_the_money";
import diagnostics from "../web/session-diagnostics.js";

await the.boot({ persistKeys: [] });
window.presentDiagnostic = diagnostics(document.querySelector("#session-diagnostics"));
