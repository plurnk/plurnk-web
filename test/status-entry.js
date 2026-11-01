import { $, the } from "on_the_money";
import sessionState from "../web/session-state.js";

await the.boot({ persistKeys: [] });
$.clone("#session-status", "#session-controls");
window.presentState = sessionState(document.querySelector("#session-status"));
