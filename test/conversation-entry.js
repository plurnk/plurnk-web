import { the } from "on_the_money";
import conversation from "../web/conversation.js";
import readBody from "../web/read-body.js";
import { SessionTranslator } from "../web/session-agent.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
window.present = conversation(document.querySelector("#session-conversation"), (address) => readBody(address, "none", new AbortController().signal));
window.projectUpdates = (updates, initial = []) => SessionTranslator.projectMessages(updates, initial);
