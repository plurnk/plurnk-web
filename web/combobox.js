import { $, on } from "on_the_money";
import { combobox } from "on_the_money/combobox";

const MODEL_SEARCH_DEBOUNCE_MS = 100;
let comboboxCounter = 0;

/**
 * @typedef {{
 *   readonly value: string,
 *   readonly primary: string,
 *   readonly secondary: string,
 *   readonly kind?: string,
 * }} ComboboxItem
 */

/** @typedef {import("./session-models.js").ModelChoice} ModelChoice */
/** @typedef {ReturnType<typeof import("./session-models.js").createModelSearchCache>} ModelSearchCache */

/**
 * {§web-workspace-settings} {§web-session-commands} Shared ARIA combobox primitive over `on_the_money/combobox` and `#model-combobox-option` / `#model-combobox-hint`.
 * @template {ComboboxItem} T
 * @param {HTMLElement} container
 * @param {{
 *   readonly idPrefix?: string,
 *   readonly defaultKind?: string,
 *   readonly inline?: boolean,
 *   readonly errorMessage?: string,
 *   readonly onQuery: (query: string, opts: { readonly immediate: boolean, readonly render: (items: readonly T[], hint?: string) => void }) => void,
 *   readonly onSelect?: (value: string, choice?: T) => void,
 *   readonly onInput?: (value: string) => void,
 *   readonly onClose?: () => void,
 *   readonly onDispose?: () => void,
 * }} options
 */
export function attachCombobox(container, {
    idPrefix = "combobox-list",
    defaultKind = "catalog",
    inline = false,
    errorMessage = "Combobox markup is incomplete.",
    onQuery,
    onSelect,
    onInput,
    onClose,
    onDispose,
}) {
    const rawInput = $(container, 'input[role="combobox"]');
    const rawList = $(container, '[role="listbox"][data-combobox-list]');
    if (!(rawInput instanceof HTMLInputElement) || !(rawList instanceof HTMLUListElement)) {
        throw new Error(errorMessage);
    }
    const input = rawInput;
    const list = rawList;
    if (!list.id) {
        comboboxCounter += 1;
        list.id = `${idPrefix}-${comboboxCounter}`;
    }
    if (input.getAttribute("aria-controls") !== list.id) {
        input.setAttribute("aria-controls", list.id);
    }

    let committedValue = input.value.trim();
    /** @type {T[]} */
    let currentItems = [];
    let disposed = false;
    let reopeningInline = false;
    let openedInThisTurn = false;
    let closingViaEscape = false;

    /**
     * @param {string} query
     * @param {boolean} immediate
     */
    function requestQuery(query, immediate) {
        if (disposed) return;
        onQuery(query, { immediate, render: renderItems });
    }

    const offKeydown = on(input, "keydown", '[role="combobox"]', (rawEvent) => {
        if (!(rawEvent instanceof KeyboardEvent) || rawEvent.isComposing) return;
        if (rawEvent.key === "Escape") {
            if (!inline && input.getAttribute("aria-expanded") === "true") {
                rawEvent.stopPropagation();
            } else if (inline) {
                closingViaEscape = true;
                queueMicrotask(() => {
                    closingViaEscape = false;
                });
            }
        }
    });

    /** @type {import("on_the_money/combobox").ComboboxController} */
    const controller = combobox(input, {
        openOnFocus: true,
        closeOnSelect: !inline,
        clearOnEscape: false,
        onOpen() {
            if (reopeningInline || disposed) return;
            openedInThisTurn = true;
            queueMicrotask(() => {
                openedInThisTurn = false;
            });
            const trimmed = input.value.trim();
            requestQuery(trimmed === committedValue ? "" : trimmed, true);
        },
        onClose() {
            if (inline && !disposed) {
                if (closingViaEscape) {
                    const dialog = input.closest("dialog");
                    if (dialog instanceof HTMLDialogElement && dialog.open) {
                        dialog.close();
                        return;
                    }
                }
                reopeningInline = true;
                try {
                    controller.open();
                } finally {
                    reopeningInline = false;
                }
                return;
            }
            onClose?.();
        },
        onSelect(option) {
            const value = option.getAttribute("data-combobox-option") ?? "";
            const chosen = currentItems.find((item) => item.value === value);
            if (!chosen) return;
            committedValue = chosen.value;
            input.value = chosen.value;
            onSelect?.(chosen.value, chosen);
        },
    });

    /**
     * @param {readonly T[]} items
     * @param {string} [hintText]
     */
    function renderItems(items, hintText) {
        if (disposed) return;
        /** @type {T[]} */
        const unique = [];
        /** @type {Set<string>} */
        const seenValues = new Set();
        for (const item of items) {
            if (!item.value || seenValues.has(item.value)) continue;
            seenValues.add(item.value);
            unique.push(item);
        }
        currentItems = unique;
        $.reconcile(list, "#model-combobox-option", currentItems, {
            attr: "data-combobox-option",
            key: (choice) => choice.value,
            fill(li, choice, index) {
                li.id = `${list.id}-opt-${index}`;
                li.setAttribute("data-combobox-kind", choice.kind ?? defaultKind);
                li.setAttribute("aria-selected", choice.value === committedValue ? "true" : "false");
                const primaryEl = $(li, "[data-combobox-primary]");
                const secondaryEl = $(li, "[data-combobox-secondary]");
                if (primaryEl) primaryEl.textContent = choice.primary;
                if (secondaryEl) {
                    secondaryEl.textContent = choice.secondary;
                    if (secondaryEl instanceof HTMLElement) secondaryEl.hidden = choice.secondary.length === 0;
                }
            },
        });
        if (hintText) {
            const hint = $.clone(list, "#model-combobox-hint");
            if (hint) hint.textContent = hintText;
        }
        controller.sync();
        if (controller.activeOption && list.contains(controller.activeOption) && controller.activeOption.id) {
            if (input.getAttribute("aria-activedescendant") !== controller.activeOption.id) {
                input.setAttribute("aria-activedescendant", controller.activeOption.id);
            }
        }
    }

    /** @param {string} value */
    function setValue(value) {
        committedValue = value.trim();
        input.value = committedValue;
    }

    const offInput = on(container, "input", 'input[role="combobox"]', () => {
        const value = input.value;
        if (!openedInThisTurn) {
            requestQuery(value, value.trim() === "");
        }
        onInput?.(value.trim());
    });

    const offFocusout = on(container, "focusout", "*", (rawEvent) => {
        const next = rawEvent instanceof FocusEvent ? rawEvent.relatedTarget : null;
        if (next instanceof Node && container.contains(next)) return;
        const trimmed = input.value.trim();
        if (trimmed !== committedValue) {
            committedValue = trimmed;
            onSelect?.(trimmed, undefined);
        }
    });

    return {
        input,
        list,
        setValue,
        getValue: () => input.value.trim(),
        open: () => {
            if (disposed || input.disabled) return;
            if (!controller.expanded) {
                controller.open();
            } else {
                requestQuery("", true);
            }
        },
        close: () => {
            if (!inline) controller.close();
        },
        isOpen: () => controller.expanded,
        refresh: () => {
            if (controller.expanded) {
                const trimmed = input.value.trim();
                requestQuery(trimmed === committedValue ? "" : trimmed, true);
            }
        },
        dispose() {
            disposed = true;
            onDispose?.();
            offInput();
            offKeydown();
            offFocusout();
            controller.dispose();
        },
    };
}

/**
 * {§web-workspace-settings} Synchronous ARIA listbox combobox over a dynamic choice supplier.
 * @template {ComboboxItem} T
 * @param {HTMLElement} container
 * @param {{
 *   readonly getChoices: (query: string) => readonly T[],
 *   readonly emptyHint: string,
 *   readonly defaultKind?: string,
 *   readonly onSelect?: (value: string, choice?: T) => void,
 *   readonly onInput?: (value: string) => void,
 * }} options
 */
export function attachListCombobox(container, {
    getChoices,
    emptyHint,
    defaultKind = "tool",
    onSelect,
    onInput,
}) {
    return attachCombobox(container, {
        idPrefix: "schedule-combobox-list",
        defaultKind,
        errorMessage: "Schedule combobox markup is incomplete.",
        onSelect,
        onInput,
        onQuery(query, { render }) {
            const needle = query.trim().toLowerCase();
            const all = getChoices(query);
            const matched = needle
                ? [
                    ...all.filter((c) => c.value.toLowerCase().startsWith(needle) || c.primary.toLowerCase().startsWith(needle)),
                    ...all.filter((c) =>
                        !c.value.toLowerCase().startsWith(needle)
                        && !c.primary.toLowerCase().startsWith(needle)
                        && (c.value.toLowerCase().includes(needle)
                            || c.primary.toLowerCase().includes(needle)
                            || c.secondary.toLowerCase().includes(needle))),
                ]
                : [...all];
            render(matched, matched.length === 0 ? emptyHint : undefined);
        },
    });
}

/**
 * {§web-workspace-settings} {§web-session-commands} Live-search ARIA combobox across declared aliases and `models.list` catalog.
 * @param {HTMLElement} container
 * @param {{
 *   readonly getCache: () => ModelSearchCache | null,
 *   readonly includeInherit?: boolean,
 *   readonly inline?: boolean,
 *   readonly onSelect?: (value: string, choice?: ModelChoice) => void,
 *   readonly onInput?: (value: string) => void,
 *   readonly signal?: AbortSignal,
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
    /** @type {ReturnType<typeof setTimeout> | null} */
    let debounceTimer = null;
    /** @type {AbortController | null} */
    let activeLookup = null;
    /** @type {ReturnType<typeof attachCombobox<ModelChoice>> | null} */
    let instance = null;

    const clearTimer = () => {
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    };

    const abortLookup = () => {
        activeLookup?.abort();
        activeLookup = null;
    };

    instance = attachCombobox(container, {
        idPrefix: "model-combobox-list",
        defaultKind: "catalog",
        inline,
        errorMessage: "Model combobox markup is incomplete.",
        onSelect,
        onInput,
        onClose() {
            clearTimer();
            abortLookup();
        },
        onDispose() {
            clearTimer();
            abortLookup();
        },
        onQuery(query, { immediate, render }) {
            const cache = getCache();
            if (!cache) return;
            const cached = cache.searchCached(query, { includeInherit });
            render(cached, cached.length === 0 ? "Searching models…" : undefined);

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
                    if (controller.signal.aborted || !instance?.isOpen()) return;
                    const hint = result.items.length === 0
                        ? "No matching configured models."
                        : (result.hasMore && typeof result.total === "number" && result.total > 0
                            ? `Showing matches from ${result.total} configured models — type to narrow.`
                            : undefined);
                    render(result.items, hint);
                } catch {
                    if (controller.signal.aborted) return;
                } finally {
                    if (activeLookup === controller) activeLookup = null;
                }
            };

            clearTimer();
            if (immediate) {
                void run();
            } else {
                debounceTimer = setTimeout(() => {
                    debounceTimer = null;
                    void run();
                }, MODEL_SEARCH_DEBOUNCE_MS);
            }
        },
    });
    return instance;
}

/**
 * {§web-search} Populate a native `<datalist>` from unique candidate strings without DOM string injection.
 * @param {HTMLDataListElement | null} datalist
 * @param {Iterable<string>} terms
 * @param {{ readonly limit?: number }} [options]
 */
export function populateDatalist(datalist, terms, { limit = 100 } = {}) {
    if (!(datalist instanceof HTMLDataListElement)) return;
    /** @type {string[]} */
    const unique = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const raw of terms) {
        if (!raw || seen.has(raw)) continue;
        seen.add(raw);
        unique.push(raw);
        if (unique.length >= limit) break;
    }
    $.cloneEach(datalist, "#search-suggestion-option", unique, (opt, term) => {
        if (opt instanceof HTMLOptionElement) {
            opt.value = term;
            opt.setAttribute("value", term);
        }
    });
}
