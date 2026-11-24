import { $, $$, on, the } from "on_the_money";
import describeFailure from "./failure.js";

/** @typedef {import("./session-agent.js").SessionGate} SessionGate */

/** @param {EventTarget | null} target */
function isTextEntry(target) {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    if (target instanceof HTMLInputElement) {
        return !["radio", "checkbox", "button", "submit", "reset", "file"].includes(target.type);
    }
    return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * {§web-session-input} {§web-session-approval} {§web-session-commands}
 * Document-level keyboard shortcuts for an active session pane (`Shift+Tab` mode toggle, `Esc` escalation, `/`, `?`, and `y/a/n/r/e` proposal choices).
 * @param {{
 *   readonly element: HTMLElement,
 *   readonly main: HTMLElement,
 *   readonly controls: Element,
 *   readonly stop: HTMLFormElement,
 *   readonly draft: HTMLTextAreaElement,
 *   readonly feedback: Element,
 *   readonly reviewForm: HTMLFormElement,
 *   readonly getPendingGates: () => readonly SessionGate[],
 *   readonly isCancelling: () => boolean,
 *   readonly getResourcesSignal: () => AbortSignal,
 *   readonly toggleYolo: () => Promise<boolean>,
 *   readonly runCommand: { readonly dismissAll: () => boolean, readonly showHelp: () => boolean },
 * }} options
 */
export function wireSessionShortcuts({
    element,
    main,
    controls,
    stop,
    draft,
    feedback,
    reviewForm,
    getPendingGates,
    isCancelling,
    getResourcesSignal,
    toggleYolo,
    runCommand,
}) {
    const offKeydown = on(document, "keydown", "body", (event) => {
        if (!main.isConnected || element.hidden) return;
        if (!(event instanceof KeyboardEvent) || event.defaultPrevented || event.isComposing || event.repeat) return;
        if ($("dialog[open]")) return;
        if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            const inDraft = event.target === draft;
            const pendingProposal = the(element, "connection") === "interrupted"
                && getPendingGates().some(({ method }) => method === "session/request_permission");
            if (isCancelling() || (!inDraft && !pendingProposal)) return;
            event.preventDefault();
            const visitSignal = getResourcesSignal();
            void toggleYolo().then(
                (enabled) => {
                    if (!visitSignal.aborted) {
                        the(feedback, { "message-status": `Approval policy: ${enabled ? "accept" : "review"}.`, "command-error": "" });
                    }
                },
                async (error) => {
                    if (!visitSignal.aborted) {
                        const { message, recovery } = await describeFailure(error);
                        the(feedback, { "message-status": "", "command-error": [message, recovery].filter(Boolean).join(" ") });
                    }
                },
            );
            return;
        }
        if (isTextEntry(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key === "Escape" && !event.shiftKey) {
            if (runCommand.dismissAll()) {
                event.preventDefault();
                return;
            }
            if (the(controls, "stop-unavailable") === null) {
                event.preventDefault();
                stop.requestSubmit();
            }
            return;
        }
        if (event.key === "/" && !event.shiftKey) {
            event.preventDefault();
            draft.focus();
            return;
        }
        if (event.key === "?") {
            event.preventDefault();
            runCommand.showHelp();
            return;
        }
        const lower = event.key.toLowerCase();
        if ((lower === "y" || lower === "a" || lower === "n" || lower === "r" || lower === "e")
            && the(element, "connection") === "interrupted"
            && the(reviewForm, "review-unavailable") === null) {
            const proposals = $$(reviewForm, 'fieldset:has(input[type="radio"][value="accept"])');
            if (proposals.length === 0) return;
            const focusedProposal = event.target instanceof Element
                ? event.target.closest('fieldset:has(input[type="radio"][value="accept"])')
                : null;
            const targetProposal = focusedProposal
                ?? proposals.find((fieldset) => !$(fieldset, 'input[type="radio"]:checked'))
                ?? proposals[0];
            const choice = lower === "y" || lower === "a" ? "accept" : lower === "e" ? "edit" : "reject";
            if (choice === "edit" && targetProposal?.getAttribute("data-proposal-editable") === "false") return;
            const radio = targetProposal ? $(targetProposal, `input[type="radio"][value="${choice}"]`) : null;
            if (radio instanceof HTMLInputElement && !radio.disabled) {
                event.preventDefault();
                radio.checked = true;
                radio.dispatchEvent(new Event("change", { bubbles: true }));
                if (choice === "edit") {
                    const editBody = targetProposal ? $(targetProposal, "[data-proposal-edit-body]") : null;
                    if (editBody instanceof HTMLTextAreaElement) editBody.focus();
                    else radio.focus();
                } else {
                    radio.focus();
                }
            }
        }
    });

    on(reviewForm, "keydown", "[data-proposal-edit-body]", (event) => {
        if (!(event instanceof KeyboardEvent) || event.isComposing || event.repeat) return;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            reviewForm.requestSubmit();
        }
    });

    return {
        dispose: offKeydown,
    };
}
