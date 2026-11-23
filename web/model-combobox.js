import { $, $$, on } from "on_the_money";

const MODEL_SEARCH_DEBOUNCE_MS = 100;
let comboboxCounter = 0;

/** @typedef {import("./session-models.js").ModelChoice} ModelChoice */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

/**
 * {§web-workspace-settings} {§web-session-commands} Reusable ARIA combobox searching aliases + configured catalog.
 * @param {HTMLElement} container
 * @param {{
 *   getCache: () => ModelSearchCache | null,
 *   includeInherit?: boolean,
 *   inline?: boolean,
 *   onSelect?: (value: string, choice?: ModelChoice) => void,
 *   onInput?: (value: string) => void,
 *   signal?: AbortSignal,
 * }} options
 */
export function attachModelCombobox(container, {
    getCache,
    includeInherit = false,
    inline = false,
    onSelect,
    onInput,
    signal,
}) {
    const rawInput = $(container, 'input[role="combobox"]');
    const rawList = $(container, '[role="listbox"][data-combobox-list]');
    if (!(rawInput instanceof HTMLInputElement) || !(rawList instanceof HTMLUListElement)) {
        throw new Error("Model combobox markup is incomplete.");
    }
    const input = rawInput;
    const list = rawList;
    if (!list.id) {
        comboboxCounter += 1;
        list.id = `model-combobox-list-${comboboxCounter}`;
    }
    input.setAttribute("aria-controls", list.id);

    let open = false;
    let suppressOpen = false;
    let committedValue = input.value.trim();
    let activeIndex = -1;
    /** @type {ModelChoice[]} */
    let currentItems = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    let debounceTimer = null;
    /** @type {AbortController | null} */
    let activeLookup = null;
    let disposed = false;

    function clearTimer() {
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }

    function abortLookup() {
        activeLookup?.abort();
        activeLookup = null;
    }

    /** @param {number} index */
    function setActiveIndex(index) {
        if (currentItems.length === 0) {
            activeIndex = -1;
            input.removeAttribute("aria-activedescendant");
            return;
        }
        const bounded = ((index % currentItems.length) + currentItems.length) % currentItems.length;
        activeIndex = bounded;
        const rows = $$(list, '[role="option"]');
        let activeId = "";
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            if (!(row instanceof HTMLElement)) continue;
            const selected = i === activeIndex;
            row.setAttribute("aria-selected", selected ? "true" : "false");
            if (selected) {
                activeId = row.id;
                row.scrollIntoView({ block: "nearest" });
            }
        }
        if (activeId) input.setAttribute("aria-activedescendant", activeId);
        else input.removeAttribute("aria-activedescendant");
    }

    /**
     * @param {readonly ModelChoice[]} items
     * @param {{ readonly total?: number, readonly hasMore?: boolean, readonly loading?: boolean, readonly query?: string }} [meta]
     */
    function render(items, meta = {}) {
        currentItems = [...items];
        $.cloneEach(list, "#model-combobox-option", currentItems, (li, choice, index) => {
            li.id = `${list.id}-opt-${index}`;
            li.setAttribute("data-combobox-option", choice.value);
            li.setAttribute("data-combobox-kind", choice.kind);
            li.setAttribute("aria-selected", "false");
            const primaryEl = $(li, "[data-combobox-primary]");
            const secondaryEl = $(li, "[data-combobox-secondary]");
            if (primaryEl) primaryEl.textContent = choice.primary;
            if (secondaryEl) {
                secondaryEl.textContent = choice.secondary;
                if (secondaryEl instanceof HTMLElement) secondaryEl.hidden = choice.secondary.length === 0;
            }
        });

        if (currentItems.length === 0) {
            const hint = $.clone(list, "#model-combobox-hint");
            if (hint) {
                hint.textContent = meta.loading ? "Searching models…" : "No matching configured models.";
            }
        } else if (meta.hasMore && typeof meta.total === "number" && meta.total > 0) {
            const hint = $.clone(list, "#model-combobox-hint");
            if (hint) {
                hint.textContent = `Showing matches from ${meta.total} configured models — type to narrow.`;
            }
        }

        const currentIdx = committedValue
            ? currentItems.findIndex((item) => item.value === committedValue)
            : -1;
        setActiveIndex(currentIdx >= 0 ? currentIdx : (currentItems.length > 0 ? 0 : -1));
    }

    function openList() {
        if (disposed || input.disabled) return;
        open = true;
        list.hidden = false;
        container.dataset.comboboxOpen = "true";
        input.setAttribute("aria-expanded", "true");
    }

    function closeList() {
        if (inline) return;
        open = false;
        list.hidden = true;
        container.dataset.comboboxOpen = "false";
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        clearTimer();
        abortLookup();
    }

    /**
     * @param {string} query
     * @param {{ readonly immediate?: boolean }} [opts]
     */
    function triggerSearch(query, opts = {}) {
        if (disposed) return;
        const cache = getCache();
        if (!cache) return;
        const cached = cache.searchCached(query, { includeInherit });
        render(cached, { loading: cached.length === 0, query });

        const run = async () => {
            abortLookup();
            const controller = new AbortController();
            activeLookup = controller;
            const lookupSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            try {
                const result = await cache.search(query, {
                    includeInherit,
                    limit: 50,
                    signal: lookupSignal,
                });
                if (disposed || controller.signal.aborted || !open) return;
                render(result.items, {
                    total: result.total,
                    hasMore: result.hasMore,
                    loading: false,
                    query,
                });
            } catch {
                if (controller.signal.aborted || disposed) return;
            } finally {
                if (activeLookup === controller) activeLookup = null;
            }
        };

        clearTimer();
        if (opts.immediate) {
            void run();
        } else {
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void run();
            }, MODEL_SEARCH_DEBOUNCE_MS);
        }
    }

    /** @param {ModelChoice} choice */
    function selectChoice(choice) {
        committedValue = choice.value;
        input.value = choice.value;
        if (inline) {
            const idx = currentItems.findIndex((item) => item.value === choice.value);
            if (idx >= 0) setActiveIndex(idx);
        } else {
            closeList();
        }
        onSelect?.(choice.value, choice);
    }

    /** @param {string} value */
    function setValue(value) {
        committedValue = value.trim();
        input.value = committedValue;
    }

    const offFocus = on(container, "focusin", 'input[role="combobox"]', () => {
        if (input.disabled || suppressOpen) return;
        openList();
        const trimmed = input.value.trim();
        const query = trimmed === committedValue ? "" : trimmed;
        triggerSearch(query, { immediate: true });
    });

    const offClickInput = on(container, "click", 'input[role="combobox"]', () => {
        if (input.disabled || open || suppressOpen) return;
        openList();
        const trimmed = input.value.trim();
        const query = trimmed === committedValue ? "" : trimmed;
        triggerSearch(query, { immediate: true });
    });

    const offInput = on(container, "input", 'input[role="combobox"]', () => {
        const value = input.value;
        if (!open) openList();
        triggerSearch(value, { immediate: value.trim() === "" });
        onInput?.(value.trim());
    });

    const offKeydown = on(container, "keydown", 'input[role="combobox"]', (rawEvent) => {
        if (!(rawEvent instanceof KeyboardEvent) || rawEvent.isComposing) return;
        if (rawEvent.key === "ArrowDown") {
            rawEvent.preventDefault();
            if (!open) {
                openList();
                const trimmed = input.value.trim();
                triggerSearch(trimmed === committedValue ? "" : trimmed, { immediate: true });
            } else {
                setActiveIndex(activeIndex + 1);
            }
            return;
        }
        if (rawEvent.key === "ArrowUp") {
            rawEvent.preventDefault();
            if (!open) {
                openList();
                const trimmed = input.value.trim();
                triggerSearch(trimmed === committedValue ? "" : trimmed, { immediate: true });
            } else {
                setActiveIndex(activeIndex - 1);
            }
            return;
        }
        if (rawEvent.key === "Escape" && open && !inline) {
            rawEvent.preventDefault();
            rawEvent.stopPropagation();
            closeList();
            return;
        }
        if (rawEvent.key === "Enter" && open) {
            const chosen = activeIndex >= 0 ? currentItems[activeIndex] : undefined;
            if (chosen && (!inline || input.value.trim() !== committedValue || chosen.value !== committedValue)) {
                rawEvent.preventDefault();
                selectChoice(chosen);
            } else if (!inline) {
                closeList();
            }
            return;
        }
        if (rawEvent.key === "Tab" && open) {
            const trimmed = input.value.trim();
            if (trimmed !== committedValue && currentItems.length > 0) {
                const chosen = activeIndex >= 0 ? currentItems[activeIndex] : currentItems[0];
                if (chosen) {
                    selectChoice(chosen);
                    return;
                }
            }
            closeList();
        }
    });

    const offMousedownOption = on(list, "mousedown", '[role="option"]', (event) => {
        event.preventDefault();
    });

    const offClickOption = on(list, "click", '[role="option"]', (event, option) => {
        event.preventDefault();
        event.stopPropagation();
        const value = option.getAttribute("data-combobox-option") ?? "";
        const chosen = currentItems.find((item) => item.value === value);
        if (chosen) {
            suppressOpen = true;
            try {
                selectChoice(chosen);
                if (document.activeElement !== input) input.focus();
            } finally {
                queueMicrotask(() => {
                    suppressOpen = false;
                });
            }
        }
    });

    const offFocusout = on(container, "focusout", "*", (rawEvent) => {
        const next = rawEvent instanceof FocusEvent ? rawEvent.relatedTarget : null;
        if (next instanceof Node && container.contains(next)) return;
        closeList();
        const trimmed = input.value.trim();
        if (trimmed !== committedValue) {
            committedValue = trimmed;
            onSelect?.(trimmed, undefined);
        }
    });

    const offOutsidePointer = on.target(document, "pointerdown", (event) => {
        if (!open) return;
        if (event.target instanceof Node && container.contains(event.target)) return;
        closeList();
    });

    return {
        input,
        list,
        setValue,
        getValue: () => input.value.trim(),
        open: () => {
            openList();
            triggerSearch("", { immediate: true });
        },
        close: closeList,
        isOpen: () => open,
        refresh: () => {
            if (open) {
                const trimmed = input.value.trim();
                triggerSearch(trimmed === committedValue ? "" : trimmed, { immediate: true });
            }
        },
        dispose() {
            disposed = true;
            clearTimer();
            abortLookup();
            offFocus();
            offClickInput();
            offInput();
            offKeydown();
            offMousedownOption();
            offClickOption();
            offFocusout();
            offOutsidePointer();
        },
    };
}
