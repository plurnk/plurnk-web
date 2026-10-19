import { the } from "on_the_money";
import diagnostics from "../web/worker-diagnostics.js";

await the.boot({ persistKeys: [] });
window.presentDiagnostic = diagnostics(document.querySelector("#worker-diagnostics"));
