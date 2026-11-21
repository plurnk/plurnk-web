import { $, $$, on } from "on_the_money";

/** @param {Element} form */
function syncProjectFolderField(form) {
    const toggle = $(form, "input[data-toggle-project-folder]");
    const input = $(form, "input[data-project-folder-input]");
    if (toggle instanceof HTMLInputElement && input instanceof HTMLInputElement) {
        input.disabled = !toggle.checked;
        input.required = toggle.checked;
    }
}

/**
 * {§web-page-shell} {§web-workspace-creation} Wires native <dialog> modals and project-folder creation toggle.
 * @param {HTMLElement} [root]
 */
export default function initDialogs(root = document.body) {
    for (const form of $$(root, "form#workspace-create")) {
        syncProjectFolderField(form);
    }

    on(root, "change", "input[data-toggle-project-folder]", (_event, toggle) => {
        if (!(toggle instanceof HTMLInputElement)) return;
        const form = toggle.closest("form");
        if (!form) return;
        syncProjectFolderField(form);
        if (toggle.checked) {
            const input = $(form, "input[data-project-folder-input]");
            if (input instanceof HTMLInputElement) {
                input.focus();
                input.select();
            }
        }
    });

    on(root, "click", "[data-dialog-target]", (_event, openButton) => {
        if (!(openButton instanceof HTMLButtonElement)) return;
        const id = openButton.dataset.dialogTarget;
        const dialog = id ? $(`#${id}`) : null;
        if (dialog instanceof HTMLDialogElement) {
            const enclosing = openButton.closest("dialog");
            if (enclosing instanceof HTMLDialogElement && enclosing !== dialog && enclosing.open) {
                enclosing.close();
            }
            for (const form of $$(dialog, "form#workspace-create")) {
                syncProjectFolderField(form);
            }
            dialog.showModal();
            if (dialog.id !== "dialog-session-manage") {
                const input = $(dialog, 'input[type="text"]:not(:disabled)');
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
