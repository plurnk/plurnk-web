import { $, on, the } from "on_the_money";
import { isRecord } from "./session-translator.js";

export const COLLECTION_PAGE_SIZE = 10;
const FILTER_DEBOUNCE_MS = 180;
const MEMBERS_PREVIEW_DEBOUNCE_MS = 180;

/**
 * {§web-workspace-settings} Summarize a paginated `*.list` response for the shared collection bar.
 * @param {unknown} res
 */
export function formatCollectionSummary(res) {
    const definitions = isRecord(res) && Array.isArray(res.definitions) ? res.definitions : [];
    const offset = isRecord(res) && typeof res.offset === "number" ? res.offset : 0;
    const total = isRecord(res) && typeof res.total === "number" ? res.total : definitions.length;
    const nextOffset = isRecord(res) && typeof res.nextOffset === "number" ? res.nextOffset : undefined;
    const count = definitions.length;
    const summary = count === 0
        ? `Showing 0 of ${total}`
        : `Showing ${offset + 1}–${offset + count} of ${total}`;
    return {
        offset,
        total,
        nextOffset,
        count,
        summary,
        canPrev: offset > 0,
        canNext: nextOffset !== undefined,
    };
}

/**
 * {§web-workspace-settings} Summarize a cursor-paginated `*.discover` response.
 * @param {unknown} res
 * @param {number} pageIndex
 */
export function formatCandidateSummary(res, pageIndex) {
    const candidates = isRecord(res) && Array.isArray(res.candidates) ? res.candidates : [];
    const total = isRecord(res) && typeof res.total === "number" ? res.total : undefined;
    const nextCursor = isRecord(res) && typeof res.nextCursor === "string" && res.nextCursor.length > 0
        ? res.nextCursor
        : undefined;
    const count = candidates.length;
    const start = pageIndex * COLLECTION_PAGE_SIZE + 1;
    const end = pageIndex * COLLECTION_PAGE_SIZE + count;
    let summary;
    if (count === 0) {
        summary = total !== undefined ? `Showing 0 of ${total}` : "0 results";
    } else if (total !== undefined) {
        summary = `Showing ${start}–${end} of ${total}`;
    } else if (pageIndex > 0 || nextCursor !== undefined) {
        summary = `Showing ${start}–${end}`;
    } else {
        summary = `${count} ${count === 1 ? "result" : "results"}`;
    }
    return {
        count,
        total,
        nextCursor,
        summary,
        canPrev: pageIndex > 0,
        canNext: nextCursor !== undefined,
    };
}

/**
 * {§web-workspace-settings} Extract the active rule token under the caret (or last non-empty rule token) for inline Members preview.
 * @param {string} value
 * @param {number | null} selectionStart
 * @returns {string}
 */
export function extractMembersPreviewToken(value, selectionStart) {
    if (!value.trim()) return "";
    const caret = typeof selectionStart === "number" && selectionStart >= 0 && selectionStart <= value.length
        ? selectionStart
        : value.length;
    let start = caret;
    while (start > 0 && !/\s/u.test(value[start - 1] ?? "")) start -= 1;
    let end = caret;
    while (end < value.length && !/\s/u.test(value[end] ?? "")) end += 1;
    const active = value.slice(start, end).trim();
    if (active.length > 0) return active;
    const tokens = value.trim().split(/\s+/u).filter((tok) => tok.length > 0);
    return tokens.at(-1) ?? "";
}

/**
 * {§web-workspace-settings} Project a `workspace.members.discover` response into an inline live preview model.
 * @param {unknown} res
 * @returns {{ readonly state: "idle" | "matched" | "empty", readonly summary: string, readonly files: readonly string[] }}
 */
export function formatMembersPreview(res) {
    const rawCandidates = isRecord(res) && Array.isArray(res.candidates) ? res.candidates : [];
    const first = isRecord(rawCandidates[0]) ? rawCandidates[0] : null;
    if (!first) {
        return { state: "empty", summary: "0 matches", files: [] };
    }
    const rawSummary = typeof first.summary === "string" ? first.summary : "";
    const detail = isRecord(first.detail) ? first.detail : null;
    if (detail && detail.kind === "preview") {
        const matched = typeof detail.matched === "number" ? detail.matched : 0;
        const fresh = typeof detail.fresh === "number" ? detail.fresh : 0;
        const alreadyMembers = typeof detail.alreadyMembers === "number" ? detail.alreadyMembers : 0;
        const ignored = typeof detail.ignored === "number" ? detail.ignored : 0;
        const effect = detail.effect === "exclude" ? "exclude" : "include";
        const primaryFiles = Array.isArray(detail.files)
            ? detail.files.filter((entry) => typeof entry === "string")
            : [];
        const fallbackFiles = Array.isArray(detail.matchedFiles)
            ? detail.matchedFiles.filter((entry) => typeof entry === "string")
            : [];
        const files = (primaryFiles.length > 0 ? primaryFiles : fallbackFiles).slice(0, COLLECTION_PAGE_SIZE);
        const matchWord = matched === 1 ? "match" : "matches";
        let summary;
        if (matched === 0) {
            summary = "0 matches";
        } else if (effect === "exclude") {
            summary = `${matched} ${matchWord} (would exclude ${matched} ${matched === 1 ? "member" : "members"})`;
        } else {
            const parts = [`${fresh} new`];
            if (alreadyMembers > 0) parts.push(`${alreadyMembers} already ${alreadyMembers === 1 ? "member" : "members"}`);
            if (ignored > 0) parts.push(`${ignored} ignored`);
            summary = `${matched} ${matchWord} (${parts.join(", ")})`;
        }
        return {
            state: matched > 0 ? "matched" : "empty",
            summary,
            files,
        };
    }
    if (detail && detail.kind === "verdict") {
        const matched = typeof detail.matched === "number" ? detail.matched : 0;
        const files = Array.isArray(detail.files)
            ? detail.files.filter((entry) => typeof entry === "string").slice(0, COLLECTION_PAGE_SIZE)
            : [];
        const matchWord = matched === 1 ? "match" : "matches";
        return {
            state: matched > 0 ? "matched" : "empty",
            summary: rawSummary ? `${matched} ${matchWord} — ${rawSummary}` : `${matched} ${matchWord}`,
            files,
        };
    }
    return {
        state: rawSummary ? "matched" : "empty",
        summary: rawSummary || "0 matches",
        files: [],
    };
}

/**
 * {§web-workspace-settings} Mount the shared always-available search/state filter + pagination bar inside a settings panel.
 * @param {HTMLElement} panel
 * @param {{
 *   readonly label: string,
 *   readonly onChange: () => void,
 *   readonly signal: AbortSignal,
 *   readonly stateOptions?: readonly { readonly value: string, readonly label: string }[],
 *   readonly initialState?: string,
 * }} options
 */
export function mountCollectionBar(panel, { label, onChange, signal, stateOptions, initialState }) {
    const outlet = $(panel, "[data-collection-bar-outlet]");
    /** @type {Element | null} */
    let bar = $(panel, "[data-collection-bar]");
    if (!bar && outlet) {
        bar = $.clone(outlet, "#workspace-collection-bar", { position: "beforebegin" });
        outlet.remove();
    }
    if (!bar) {
        return {
            /** @returns {Record<string, unknown>} */
            getParams: () => ({ offset: 0, limit: COLLECTION_PAGE_SIZE }),
            isFiltered: () => false,
            applyResult: () => ({ clamped: false }),
            resetOffset: () => {},
            dispose: () => {},
        };
    }

    const searchInput = $(bar, 'input[name="query"]');
    if (searchInput instanceof HTMLInputElement) {
        searchInput.setAttribute("aria-label", `Filter ${label}`);
        searchInput.placeholder = `Filter ${label}…`;
    }

    const stateSelect = $(bar, 'select[name="state"]');
    const defaultState = initialState ?? (stateOptions ? (stateOptions[0]?.value ?? "") : "");
    if (stateOptions && stateSelect instanceof HTMLSelectElement) {
        $.cloneEach(stateSelect, "#setting-option", stateOptions, (optEl, choice) => {
            the(optEl, { "option-value": choice.value, "option-label": choice.label, "option-disabled": null });
        });
        stateSelect.value = defaultState;
    }

    let query = "";
    let state = defaultState;
    let offset = 0;
    /** @type {number | undefined} */
    let nextOffset;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let debounceTimer = null;

    function clearDebounce() {
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }

    on(bar, "submit", "[data-collection-filter-form]", (event, form) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        clearDebounce();
        const data = new FormData(form);
        query = String(data.get("query") ?? "").trim();
        state = String(data.get("state") ?? "").trim();
        offset = 0;
        onChange();
    });

    on(bar, "input", 'input[name="query"]', (_event, input) => {
        if (!(input instanceof HTMLInputElement)) return;
        query = input.value.trim();
        offset = 0;
        clearDebounce();
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (!signal.aborted) onChange();
        }, FILTER_DEBOUNCE_MS);
    });

    on(bar, "change", 'select[name="state"]', (_event, select) => {
        if (!(select instanceof HTMLSelectElement)) return;
        clearDebounce();
        state = select.value.trim();
        offset = 0;
        onChange();
    });

    on(bar, "click", "[data-collection-prev]", () => {
        if (offset <= 0) return;
        clearDebounce();
        offset = Math.max(0, offset - COLLECTION_PAGE_SIZE);
        onChange();
    });

    on(bar, "click", "[data-collection-next]", () => {
        if (nextOffset === undefined) return;
        clearDebounce();
        offset = nextOffset;
        onChange();
    });

    on.target(signal, "abort", clearDebounce);

    return {
        /** @returns {Record<string, unknown>} */
        getParams() {
            return {
                ...(query ? { query } : {}),
                ...(state ? { state } : {}),
                offset,
                limit: COLLECTION_PAGE_SIZE,
            };
        },
        isFiltered() {
            return query.length > 0 || state !== defaultState;
        },
        /** @param {unknown} res */
        applyResult(res) {
            const info = formatCollectionSummary(res);
            offset = info.offset;
            nextOffset = info.nextOffset;
            if (offset > 0 && info.count === 0 && info.total > 0) {
                offset = Math.max(0, Math.floor((info.total - 1) / COLLECTION_PAGE_SIZE) * COLLECTION_PAGE_SIZE);
                return { clamped: true };
            }
            const prevBtn = $(bar, "[data-collection-prev]");
            const nextBtn = $(bar, "[data-collection-next]");
            if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = !info.canPrev;
            if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = !info.canNext;
            the(bar, { "collection-summary": info.summary });
            the(panel, { "collection-filtered": query || state !== defaultState ? "true" : "false" });
            return { clamped: false };
        },
        resetOffset() {
            offset = 0;
        },
        dispose: clearDebounce,
    };
}

/**
 * {§web-workspace-settings} Mount the shared cursor pagination footer for `*.discover` candidate results.
 * @param {HTMLElement} panel
 * @param {{
 *   readonly onPageChange: (params: Record<string, unknown>) => void,
 * }} options
 */
export function mountCandidatePager(panel, { onPageChange }) {
    const outlet = $(panel, "[data-candidate-pager-outlet]");
    /** @type {Element | null} */
    let pager = $(panel, "[data-candidate-pagination]");
    if (!pager && outlet) {
        pager = $.clone(outlet, "#workspace-candidate-pager", { position: "beforebegin" });
        outlet.remove();
    }
    if (!(pager instanceof HTMLElement)) {
        return {
            startSearch: (/** @type {Record<string, unknown>} */ baseParams) => ({ ...baseParams, limit: COLLECTION_PAGE_SIZE }),
            applyResult: () => {},
            clear: () => {},
        };
    }

    /** @type {Record<string, unknown>} */
    let baseParams = {};
    /** @type {(string | undefined)[]} */
    let cursorStack = [undefined];
    let pageIndex = 0;
    /** @type {string | undefined} */
    let nextCursor;

    function requestCurrentPage() {
        const cursor = cursorStack[pageIndex];
        onPageChange({
            ...baseParams,
            ...(cursor !== undefined ? { cursor } : {}),
            limit: COLLECTION_PAGE_SIZE,
        });
    }

    on(pager, "click", "[data-candidate-prev]", () => {
        if (pageIndex <= 0) return;
        pageIndex -= 1;
        requestCurrentPage();
    });

    on(pager, "click", "[data-candidate-next]", () => {
        if (!nextCursor) return;
        pageIndex += 1;
        cursorStack[pageIndex] = nextCursor;
        requestCurrentPage();
    });

    return {
        /** @param {Record<string, unknown>} nextBase */
        startSearch(nextBase) {
            baseParams = { ...nextBase };
            cursorStack = [undefined];
            pageIndex = 0;
            nextCursor = undefined;
            return { ...baseParams, limit: COLLECTION_PAGE_SIZE };
        },
        /** @param {unknown} res */
        applyResult(res) {
            const info = formatCandidateSummary(res, pageIndex);
            nextCursor = info.nextCursor;
            const prevBtn = $(pager, "[data-candidate-prev]");
            const nextBtn = $(pager, "[data-candidate-next]");
            if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = !info.canPrev;
            if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = !info.canNext;
            the(pager, { "candidate-summary": info.summary });
            pager.hidden = info.count === 0 && pageIndex === 0 && info.nextCursor === undefined;
        },
        clear() {
            cursorStack = [undefined];
            pageIndex = 0;
            nextCursor = undefined;
            pager.hidden = true;
            the(pager, { "candidate-summary": "" });
        },
    };
}

/**
 * {§web-workspace-settings} Debounced inline live preview for `[data-members-save-form]`.
 * @param {HTMLFormElement} form
 * @param {{
 *   readonly invokeWithSignal: (kind: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
 *   readonly signal: AbortSignal,
 * }} options
 */
export function mountMembersLivePreview(form, { invokeWithSignal, signal }) {
    const rawPreviewBox = $(form, "[data-members-preview]");
    const rawListEl = rawPreviewBox ? $(rawPreviewBox, "[data-members-preview-list]") : null;
    const rawFilesInput = $(form, 'input[name="files"]');
    if (!(rawPreviewBox instanceof HTMLElement) || !rawListEl || !(rawFilesInput instanceof HTMLInputElement)) {
        return { clear: () => {}, dispose: () => {} };
    }
    const previewBox = rawPreviewBox;
    const listEl = rawListEl;
    const filesInput = rawFilesInput;

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {AbortController | null} */
    let activeLookup = null;
    let lastRequestedToken = "";

    function clearTimer() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function clear() {
        clearTimer();
        activeLookup?.abort();
        activeLookup = null;
        lastRequestedToken = "";
        the(previewBox, {
            "members-preview-state": "idle",
            "members-preview-summary": "",
        });
        $.cloneEach(listEl, "#members-preview-path", [], () => {});
    }

    /** @param {string} token */
    async function runPreview(token) {
        activeLookup?.abort();
        const controller = activeLookup = new AbortController();
        const combinedSignal = AbortSignal.any([signal, controller.signal]);
        the(previewBox, {
            "members-preview-state": "loading",
            "members-preview-summary": `Previewing ${token}…`,
        });
        try {
            const res = await invokeWithSignal("workspace.members.discover", {
                query: token,
                limit: COLLECTION_PAGE_SIZE,
            }, combinedSignal);
            combinedSignal.throwIfAborted();
            const model = formatMembersPreview(res);
            the(previewBox, {
                "members-preview-state": model.state,
                "members-preview-summary": model.summary,
            });
            $.cloneEach(listEl, "#members-preview-path", model.files, (li, filePath) => {
                the(li, { "preview-path": filePath });
            });
        } catch {
            if (controller.signal.aborted || signal.aborted) return;
            the(previewBox, {
                "members-preview-state": "empty",
                "members-preview-summary": "",
            });
            $.cloneEach(listEl, "#members-preview-path", [], () => {});
        }
    }

    function schedulePreview() {
        const token = extractMembersPreviewToken(filesInput.value, filesInput.selectionStart);
        if (!token) {
            clear();
            return;
        }
        if (token === lastRequestedToken) return;
        lastRequestedToken = token;
        clearTimer();
        timer = setTimeout(() => {
            timer = null;
            if (!signal.aborted) void runPreview(token);
        }, MEMBERS_PREVIEW_DEBOUNCE_MS);
    }

    on(form, "input", 'input[name="files"]', schedulePreview);
    on(form, "keyup", 'input[name="files"]', schedulePreview);
    on(form, "click", 'input[name="files"]', schedulePreview);
    on.target(signal, "abort", () => {
        clearTimer();
        activeLookup?.abort();
    });

    return {
        clear,
        dispose() {
            clearTimer();
            activeLookup?.abort();
        },
    };
}
