import { $, the } from "on_the_money";

/** @type {Readonly<Record<number, string>>} */
const STATUS_TITLES = {
    400: "400 Bad Request",
    401: "401 Unauthorized",
    403: "403 Forbidden",
    404: "404 Not Found",
    500: "500 Internal Server Error",
    502: "502 Bad Gateway",
    503: "503 Service Unavailable",
};

/**
 * {§web-page-shell} {§web-directory-documents} Render an in-page semantic error state inside `#main` (e.g. `404 Not Found` when a workspace or session does not exist on `/acp`).
 * @param {HTMLElement} main
 * @param {number} status
 * @param {string} message
 * @param {string} [recovery]
 */
export default function renderInPageError(main, status, message, recovery = "") {
    const title = STATUS_TITLES[status] ?? `${status} Error`;
    the("page-title", `${title} — Plurnk`);
    main.dataset.page = "error";
    delete main.dataset.connection;
    const place = $("#header-place");
    if (place instanceof HTMLElement) place.remove();
    const footer = $("#session-status");
    if (footer instanceof HTMLElement) footer.remove();
    const tabs = $("#workspace-tabs");
    if (tabs instanceof HTMLElement) tabs.remove();
    main.replaceChildren();
    const card = $.clone(main, "#error-view");
    the(card, {
        "error-title": title,
        "error-message": message,
        "error-recovery": recovery,
    });
    const recEl = $(card, '[data-text="error-recovery"]');
    if (recEl instanceof HTMLElement) {
        recEl.hidden = recovery === "";
    }
}
