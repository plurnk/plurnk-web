import { $, the } from "on_the_money";
import workerState from "../web/worker-state.js";

await the.boot({ persistKeys: [] });
$.clone("#worker-status", "#worker-controls");
window.presentState = workerState(document.querySelector("#worker-status"));
