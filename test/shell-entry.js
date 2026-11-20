import { $, the } from "on_the_money";
import conversation from "../web/conversation.js";
import sessionState from "../web/session-state.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const status = /** @type {HTMLElement} */ ($("#session-status"));
const controls = $.clone(status, "#session-controls");
the(controls, { "live-work": "", "send-unavailable": null, "stop-unavailable": null, "message-status": "" });
the(status, { connection: "connected", "connection-label": "Connected" });
window.present = conversation(/** @type {HTMLElement} */ ($("#session-conversation")), async () => "");
window.presentState = sessionState(status);
