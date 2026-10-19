import { $, on, the } from "on_the_money";
import reviewRequests from "../web/worker-review.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const controls = $.clone("#main", "#worker-controls");
const review = reviewRequests(controls, new URL(location.href).searchParams.get("yolo") === "1");
let interrupts = [];
window.responses = [];
window.review = async (values, messages) => {
    interrupts = values;
    const mode = review.present(values, messages);
    the(review.form, "review-unavailable", mode === "manual" ? null : "");
    if (mode === "automatic") window.responses.push(await review.decisions(interrupts));
    return mode !== "unsupported";
};
on(review.form, "submit", "form", async (event) => {
    event.preventDefault();
    const response = await review.decisions(interrupts);
    if (response) window.responses.push(response);
});
