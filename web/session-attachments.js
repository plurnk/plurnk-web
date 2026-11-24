import { $, on, the } from "on_the_money";
import { readRasterFileAttachment } from "./inline-images.js";
import { randomUUID } from "./session-translator.js";

/** @typedef {import("./session-translator.js").Message} Message */
/** @typedef {import("./session-agent-updates.js").PromptImageAttachment} PromptImageAttachment */

/**
 * {§web-session-input} Operator prompt history ring buffer with ArrowUp/ArrowDown draft preservation.
 */
export function createPromptHistory() {
    /** @type {Set<string>} */
    const seenHistoryMessageIds = new Set();
    /** @type {string[]} */
    const promptHistory = [];
    let historyIndex = -1;
    /** @type {string | null} */
    let historyDraft = null;

    /** @param {string} raw */
    function pushPromptHistory(raw) {
        const trimmed = raw.trim();
        if (!trimmed || promptHistory.at(-1) === trimmed) return;
        promptHistory.push(trimmed);
    }

    function resetCursor() {
        historyIndex = -1;
        historyDraft = null;
    }

    /**
     * @param {string} id
     * @param {string} raw
     */
    function recordSubmitted(id, raw) {
        seenHistoryMessageIds.add(id);
        pushPromptHistory(raw);
        resetCursor();
    }

    /** @param {readonly Message[]} messages */
    function recordMessages(messages) {
        for (const msg of messages) {
            if (msg.role !== "user" || seenHistoryMessageIds.has(msg.id)) continue;
            seenHistoryMessageIds.add(msg.id);
            const plurnk = /** @type {Record<string, unknown> | undefined} */ (msg._meta?.plurnk);
            if (typeof plurnk?.answering === "string") continue;
            if (
                typeof plurnk?.actor === "string" &&
                plurnk.actor !== "" &&
                plurnk.actor !== "operator" &&
                plurnk.actor !== "anonymous" &&
                plurnk.actor !== "client" &&
                plurnk.actor !== "owner"
            ) {
                continue;
            }
            if (typeof plurnk?.source === "string"
                && (plurnk.source.startsWith("session://") || plurnk.source.startsWith("schedule://"))) {
                continue;
            }
            const rawText = typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                    ? msg.content.map((part) => {
                        if (part.type === "text" && typeof part.text === "string") return part.text;
                        if (part.type === "skill" && typeof part.name === "string") return `$${part.name}`;
                        return "";
                    }).join("")
                    : "";
            const cleaned = rawText
                .split("\n")
                .filter((line) => !/^<session:\/\/[^\s>]+\/attachments\/[0-9a-f]+\/[^\s>]+>$/u.test(line.trim()))
                .join("\n")
                .trim();
            if (cleaned) pushPromptHistory(cleaned);
        }
    }

    /**
     * @param {"ArrowUp" | "ArrowDown"} key
     * @param {HTMLTextAreaElement} draft
     * @returns {boolean}
     */
    function navigate(key, draft) {
        if (key === "ArrowUp") {
            const isFirstLine = !draft.value.slice(0, draft.selectionStart).includes("\n");
            if (isFirstLine && (draft.value === "" || historyIndex > -1 || draft.selectionStart === 0)) {
                const newestFirst = promptHistory.toReversed();
                if (historyIndex + 1 < newestFirst.length) {
                    if (historyIndex === -1) historyDraft = draft.value;
                    historyIndex += 1;
                    draft.value = newestFirst[historyIndex] ?? "";
                    draft.setSelectionRange(0, 0);
                    draft.setCustomValidity("");
                    return true;
                }
                return false;
            }
            return false;
        }
        if (historyIndex > -1) {
            const isLastLine = !draft.value.slice(draft.selectionEnd).includes("\n");
            if (isLastLine) {
                historyIndex -= 1;
                if (historyIndex === -1) {
                    draft.value = historyDraft ?? "";
                    historyDraft = null;
                } else {
                    const newestFirst = promptHistory.toReversed();
                    draft.value = newestFirst[historyIndex] ?? "";
                }
                draft.setSelectionRange(draft.value.length, draft.value.length);
                draft.setCustomValidity("");
                return true;
            }
        }
        return false;
    }

    return {
        isBrowsing: () => historyIndex > -1,
        push: pushPromptHistory,
        resetCursor,
        recordSubmitted,
        recordMessages,
        navigate,
    };
}

/**
 * {§web-inline-images} Ordered raster image attachment staging, paste/drop intake, and preview list for the session composer.
 * @param {{
 *   readonly compose: HTMLFormElement,
 *   readonly controls: Element,
 *   readonly draft: HTMLTextAreaElement,
 *   readonly fileInput: HTMLInputElement,
 *   readonly attachmentOutlet: HTMLUListElement,
 *   readonly feedback: Element,
 *   readonly slate: { sync: () => void },
 *   readonly getPromptImageSupported: () => boolean,
 *   readonly hasPendingDelivery: () => boolean,
 *   readonly isDisposed: () => boolean,
 *   readonly onAvailabilityChange: () => void,
 * }} options
 */
export function createComposerAttachments({
    compose,
    controls,
    draft,
    fileInput,
    attachmentOutlet,
    feedback,
    slate,
    getPromptImageSupported,
    hasPendingDelivery,
    isDisposed,
    onAvailabilityChange,
}) {
    /** @type {{ id: string, name: string, mimeType: string, data: string, sizeLabel: string }[]} */
    let attachments = [];

    function syncAttachments() {
        draft.required = attachments.length === 0;
        attachmentOutlet.replaceChildren();
        for (const item of attachments) {
            const row = $.clone(attachmentOutlet, "#compose-attachment");
            if (row instanceof HTMLElement) row.dataset.removeId = item.id;
            the(row, {
                "attachment-name": item.name,
                "attachment-size": item.sizeLabel,
                "attachment-remove": `Remove ${item.name}`,
            });
        }
    }

    /** {§web-inline-images} Attachments queue in the order the person added them, however long each takes to verify. */
    let intake = Promise.resolve();

    /** @param {readonly File[]} files */
    function queueAttachmentFiles(files) {
        const queued = intake.then(() => verifyAttachmentFiles(files));
        intake = queued.then(() => undefined, () => undefined);
        return queued;
    }

    /** @param {readonly File[]} files */
    async function verifyAttachmentFiles(files) {
        if (!getPromptImageSupported()) {
            the(feedback, { "message-status": "", "command-error": "Image attachments are not supported on this session." });
            slate.sync();
            return;
        }
        /** @type {string[]} */
        const errors = [];
        for (const file of files) {
            try {
                const item = await readRasterFileAttachment(file, randomUUID);
                if (isDisposed()) return;
                attachments.push(item);
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
        if (attachments.length > 0) draft.setCustomValidity("");
        syncAttachments();
        the(feedback, {
            "message-status": hasPendingDelivery() ? (the(feedback, "message-status") ?? "") : "",
            "command-error": errors.join(" "),
        });
        onAvailabilityChange();
        slate.sync();
    }

    on(compose, "click", "[data-attach-image]", () => {
        if (the(controls, "send-unavailable") === null && getPromptImageSupported()) {
            fileInput.click();
        }
    });
    on(compose, "change", "[data-attach-input]", () => {
        const files = Array.from(fileInput.files ?? []);
        fileInput.value = "";
        if (files.length > 0) void queueAttachmentFiles(files);
    });
    on(compose, "click", "[data-remove-attachment]", (_event, button) => {
        const item = button.closest("[data-attachment-item]");
        const id = item instanceof HTMLElement ? item.dataset.removeId : null;
        if (!id) return;
        attachments = attachments.filter((entry) => entry.id !== id);
        syncAttachments();
        onAvailabilityChange();
    });
    on(compose, "paste", "textarea", (event) => {
        const clipboardData = "clipboardData" in event ? /** @type {DataTransfer | null} */ (event.clipboardData) : null;
        if (!clipboardData) return;
        /** @type {File[]} */
        const files = [];
        for (const item of clipboardData.items ?? []) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length === 0) {
            for (const file of clipboardData.files ?? []) {
                if (file.type.startsWith("image/")) files.push(file);
            }
        }
        if (files.length === 0) return;
        event.preventDefault();
        void queueAttachmentFiles(files);
    });
    on(compose, "dragover", "form", (event) => {
        const dataTransfer = "dataTransfer" in event ? /** @type {DataTransfer | null} */ (event.dataTransfer) : null;
        if (!dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        dataTransfer.dropEffect = "copy";
    });
    on(compose, "drop", "form", (event) => {
        const dataTransfer = "dataTransfer" in event ? /** @type {DataTransfer | null} */ (event.dataTransfer) : null;
        if (!dataTransfer || dataTransfer.files.length === 0) return;
        event.preventDefault();
        void queueAttachmentFiles(Array.from(dataTransfer.files));
    });

    return {
        hasItems: () => attachments.length > 0,
        snapshotPayload() {
            return {
                idsKey: attachments.map(({ id }) => id).join(","),
                items: /** @type {PromptImageAttachment[]} */ (attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }))),
                idSet: new Set(attachments.map(({ id }) => id)),
            };
        },
        /** @param {ReadonlySet<string>} attachmentIds */
        removeAcknowledged(attachmentIds) {
            if (attachmentIds.size === 0) return;
            attachments = attachments.filter((item) => !attachmentIds.has(item.id));
            syncAttachments();
        },
    };
}
