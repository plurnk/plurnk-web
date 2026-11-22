import { $, on, the } from "on_the_money";
import reviewRequests from "../web/session-review.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const controls = $.clone("#main", "#session-controls");
const review = reviewRequests(controls);
let gates = [];
window.responses = [];
window.review = async (values) => {
    gates = values;
    const mode = review.present(values);
    the(review.form, "review-unavailable", mode === "manual" ? null : "");
    return mode !== "unsupported";
};
on(review.form, "submit", "form", async (event) => {
    event.preventDefault();
    const response = await review.decisions(gates);
    if (response) window.responses.push(response);
});
