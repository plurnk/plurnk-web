import { the } from "on_the_money";
import conversation from "../web/conversation.js";
import readBody from "../web/read-body.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
window.present = conversation(document.querySelector("#worker-conversation"), (address) => readBody(address, "session", new AbortController().signal));
