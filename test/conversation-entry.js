import { the } from "on_the_money";
import conversation from "../web/conversation.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
window.present = conversation(document.querySelector("#worker-conversation"));
