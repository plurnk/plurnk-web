import { $, on, the } from "on_the_money";
import reviewRequests from "../web/session-review.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const controls = $.clone("#main", "#session-controls");
const review = reviewRequests(controls, new URL(location.href).searchParams.get("yolo") === "1");
let gates = [];
window.responses = [];
window.review = async (values) => {
    gates = values;
    const mode = review.present(values);
    the(review.form, "review-unavailable", mode === "manual" ? null : "");
    if (mode === "automatic") window.responses.push(await review.decisions(gates));
    return mode !== "unsupported";
};
window.automatic = (value) => {
    const mode = review.automatic(value);
    the(review.form, "review-unavailable", mode === "manual" ? null : "");
    return mode;
};
on(review.form, "submit", "form", async (event) => {
    event.preventDefault();
    const response = await review.decisions(gates);
    if (response) window.responses.push(response);
});
