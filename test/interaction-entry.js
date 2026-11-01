import { $, on, the } from "on_the_money";
import reviewRequests from "../web/session-review.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const controls = $.clone("#main", "#session-controls");
const review = reviewRequests(controls, false);
let gates = [];
window.responses = [];
window.review = (values) => {
    gates = values;
    const supported = review.present(values) === "manual";
    the(review.form, "review-unavailable", supported ? null : "");
    return supported;
};
on(review.form, "submit", "form", async (event) => {
    event.preventDefault();
    const response = await review.decisions(gates);
    if (response) window.responses.push(response);
});
