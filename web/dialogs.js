import { $, on } from "on_the_money";

/**
 * {§web-page-shell} Wires native <dialog> modals for header actions.
 * @param {HTMLElement} [root]
 */
export default function initDialogs(root = document.body) {
    for (const dialog of root.querySelectorAll("dialog[open]")) {
        dialog.removeAttribute("open");
    }
    on(root, "click", "button[data-dialog-target]", (_event, openButton) => {
        if (!(openButton instanceof HTMLButtonElement)) return;
        const id = openButton.dataset.dialogTarget;
        const dialog = id ? $(`#${id}`) : null;
        if (dialog instanceof HTMLDialogElement) {
            dialog.showModal();
            const input = $(dialog, 'input[type="text"]');
            if (input instanceof HTMLInputElement) {
                input.focus();
                input.select();
            }
        }
    });
    on(root, "click", "[data-dialog-close]", (_event, closeButton) => {
        const dialog = closeButton.closest("dialog");
        if (dialog instanceof HTMLDialogElement) dialog.close();
    });

    on(root, "click", "dialog", (event, dialog) => {
        if (event.target === dialog && dialog instanceof HTMLDialogElement) {
            dialog.close();
        }
    });
}