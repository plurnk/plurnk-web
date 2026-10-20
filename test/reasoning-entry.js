import { the } from "on_the_money";
import conversation from "../web/conversation.js";
import reasoningPreview from "../web/reasoning-preview.js";
import readBody from "../web/read-body.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const history = document.querySelector("#worker-conversation");
window.present = conversation(history, (address) => readBody(address, "session", new AbortController().signal));
window.preview = reasoningPreview(history, Number(document.querySelector("#worker-status").dataset.reasoningPreviewChars));
