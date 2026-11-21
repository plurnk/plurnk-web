import { $, on } from "on_the_money";

/**
 * {§web-page-shell} Wires native <dialog> modals for header actions.
 * @param {HTMLElement} [root]
 */
export default function initDialogs(root = document.body) {
    on(root, "click", "[data-dialog-target]", (_event, openButton) => {
        if (!(openButton instanceof HTMLButtonElement)) return;
        const id = openButton.dataset.dialogTarget;
        const dialog = id ? $(`#${id}`) : null;
        if (dialog instanceof HTMLDialogElement) {
            const enclosing = openButton.closest("dialog");
            if (enclosing instanceof HTMLDialogElement && enclosing !== dialog && enclosing.open) {
                enclosing.close();
            }
            dialog.showModal();
            if (dialog.id !== "dialog-session-manage") {
                const input = $(dialog, 'input[type="text"]');
                if (input instanceof HTMLInputElement) {
                    input.focus();
                    input.select();
                }
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