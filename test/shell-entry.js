import { $, the } from "on_the_money";
import conversation from "../web/conversation.js";
import sessionState from "../web/session-state.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const status = $("#session-status");
const controls = $.clone(status, "#session-controls");
the(controls, { liveWork: "", sendUnavailable: null, stopUnavailable: null, messageStatus: "" });
the(status, { connection: "connected", connectionLabel: "Connected" });
window.present = conversation($("#session-conversation"));
window.presentState = sessionState(status);
