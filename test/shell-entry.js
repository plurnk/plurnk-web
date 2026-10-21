import { $, the } from "on_the_money";
import conversation from "../web/conversation.js";
import workerState from "../web/worker-state.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const status = $("#worker-status");
const controls = $.clone(status, "#worker-controls");
the(controls, { liveWork: "", sendUnavailable: null, stopUnavailable: null, messageStatus: "" });
the(status, { connection: "connected", connectionLabel: "Connected" });
window.present = conversation($("#worker-conversation"));
window.presentState = workerState(status);
