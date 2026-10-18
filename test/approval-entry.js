import { $, on, the } from "on_the_money";
import approvals from "../web/worker-approval.js";

await the.boot({ locale: "en", defaultLocale: "en", persistKeys: [] });
const controls = $.clone("#main", "#worker-controls");
const review = approvals(controls);
let interrupts = [];
window.responses = [];
window.review = (values) => {
    interrupts = values;
    const supported = review.present(values);
    the(review.form, "review-unavailable", supported ? null : "");
    return supported;
};
on(review.form, "submit", "form", (event) => {
    event.preventDefault();
    window.responses.push(review.decisions(interrupts));
});
