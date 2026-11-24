import { $, $$, the } from "on_the_money";
import describeFailure from "./failure.js";
import { isRecord } from "./session-translator.js";

const SCHEDULE_PREVIEW_DEBOUNCE_MS = 200;

/**
 * @typedef {{
 *   readonly mode: "manual" | "once" | "relative" | "at" | "repeating" | "custom",
 *   readonly relativeAmount: number,
 *   readonly relativeUnit: "s" | "m" | "h" | "d" | "w",
 *   readonly atLocal: string,
 *   readonly repeatPreset: "daily" | "weekdays" | "weekly" | "monthly" | "every-hours" | "every-minutes",
 *   readonly repeatInterval: number,
 *   readonly repeatTime: string,
 *   readonly repeatDays: readonly number[],
 *   readonly repeatDayOfMonth: number,
 *   readonly customRule: string,
 * }} ScheduleTimingState
 */

const ICAL_DOW_TO_CRON = Object.freeze({
    SU: 0,
    MO: 1,
    TU: 2,
    WE: 3,
    TH: 4,
    FR: 5,
    SA: 6,
});

/** @param {number} value */
const pad2 = (value) => String(Math.max(0, Math.floor(value))).padStart(2, "0");

/**
 * {§web-workspace-settings} Synthesize a canonical schedule `rule` string from structured timing builder controls.
 * @param {ScheduleTimingState} state
 * @returns {string}
 */
export function synthesizeScheduleRule(state) {
    if (state.mode === "manual") return "manual";
    if (state.mode === "once") return "once";
    if (state.mode === "relative") {
        const amount = Number.isFinite(state.relativeAmount) && state.relativeAmount >= 1
            ? Math.floor(state.relativeAmount)
            : 0;
        if (amount < 1) throw new Error("Enter a positive relative delay amount.");
        return `+${amount}${state.relativeUnit}`;
    }
    if (state.mode === "at") {
        const raw = state.atLocal.trim();
        if (!raw) throw new Error("Choose a date and time.");
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(raw) ? `${raw}:00` : raw;
    }
    if (state.mode === "repeating") {
        const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(state.repeatTime.trim());
        const hour = timeMatch ? Math.min(23, Math.max(0, Number.parseInt(timeMatch[1] ?? "9", 10))) : 9;
        const minute = timeMatch ? Math.min(59, Math.max(0, Number.parseInt(timeMatch[2] ?? "0", 10))) : 0;
        const interval = Number.isFinite(state.repeatInterval) && state.repeatInterval >= 1
            ? Math.floor(state.repeatInterval)
            : 1;
        if (state.repeatPreset === "every-minutes") {
            return interval <= 1 ? "* * * * *" : `*/${Math.min(59, interval)} * * * *`;
        }
        if (state.repeatPreset === "every-hours") {
            return interval <= 1 ? "0 * * * *" : `0 */${Math.min(23, interval)} * * *`;
        }
        if (state.repeatPreset === "daily") {
            return `${minute} ${hour} * * *`;
        }
        if (state.repeatPreset === "weekdays") {
            return `${minute} ${hour} * * 1-5`;
        }
        if (state.repeatPreset === "weekly") {
            const days = [...new Set(state.repeatDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
                .toSorted((a, b) => a - b);
            if (days.length === 0) throw new Error("Select at least one day of the week.");
            return `${minute} ${hour} * * ${days.join(",")}`;
        }
        const dom = Number.isFinite(state.repeatDayOfMonth)
            ? Math.min(31, Math.max(1, Math.floor(state.repeatDayOfMonth)))
            : 1;
        return `${minute} ${hour} ${dom} * *`;
    }
    const custom = state.customRule.trim();
    if (!custom) throw new Error("Enter a schedule rule.");
    return custom;
}

/**
 * {§web-workspace-settings} Parse an authored or daemon-canonical rule back into timing builder controls.
 * @param {string | null | undefined} rawRule
 * @returns {ScheduleTimingState}
 */
export function parseRuleToTimingState(rawRule) {
    /** @type {ScheduleTimingState} */
    const base = {
        mode: "manual",
        relativeAmount: 15,
        relativeUnit: "m",
        atLocal: "",
        repeatPreset: "daily",
        repeatInterval: 1,
        repeatTime: "09:00",
        repeatDays: [1],
        repeatDayOfMonth: 1,
        customRule: "",
    };
    const text = typeof rawRule === "string" ? rawRule.trim() : "";
    if (!text || text === "manual") return { ...base, mode: "manual" };
    if (text === "once") return { ...base, mode: "once" };

    const relMatch = /^\+(\d+)([smhdw])$/iu.exec(text);
    if (relMatch) {
        return {
            ...base,
            mode: "relative",
            relativeAmount: Number.parseInt(relMatch[1] ?? "15", 10),
            relativeUnit: /** @type {"s" | "m" | "h" | "d" | "w"} */ ((relMatch[2] ?? "m").toLowerCase()),
        };
    }

    const isoLocalMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/u.exec(text);
    if (isoLocalMatch) {
        return { ...base, mode: "at", atLocal: `${isoLocalMatch[1]}T${isoLocalMatch[2]}` };
    }

    // Check 5-field cron presets
    const cronFields = text.split(/\s+/u);
    if (cronFields.length === 5 && !text.includes("\n")) {
        const [minF, hourF, domF, monF, dowF] = cronFields;
        if (domF === "*" && monF === "*" && dowF === "*") {
            if (minF === "*" && hourF === "*") {
                return { ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: 1 };
            }
            const stepMin = /^\*\/(\d+)$/u.exec(minF ?? "");
            if (stepMin && hourF === "*") {
                return { ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: Number.parseInt(stepMin[1] ?? "1", 10) };
            }
            if (minF === "0" && hourF === "*") {
                return { ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: 1 };
            }
            const stepHr = /^\*\/(\d+)$/u.exec(hourF ?? "");
            if (minF === "0" && stepHr) {
                return { ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: Number.parseInt(stepHr[1] ?? "1", 10) };
            }
            if (/^\d+$/u.test(minF ?? "") && /^\d+$/u.test(hourF ?? "")) {
                return {
                    ...base,
                    mode: "repeating",
                    repeatPreset: "daily",
                    repeatTime: `${pad2(Number(hourF))}:${pad2(Number(minF))}`,
                };
            }
        }
        if (/^\d+$/u.test(minF ?? "") && /^\d+$/u.test(hourF ?? "") && monF === "*") {
            const repeatTime = `${pad2(Number(hourF))}:${pad2(Number(minF))}`;
            if (domF === "*" && dowF === "1-5") {
                return { ...base, mode: "repeating", repeatPreset: "weekdays", repeatTime };
            }
            if (domF === "*" && /^[0-7](?:,[0-7])*$/u.test(dowF ?? "")) {
                const days = (dowF ?? "").split(",").map((d) => Number.parseInt(d, 10) % 7);
                return { ...base, mode: "repeating", repeatPreset: "weekly", repeatTime, repeatDays: days };
            }
            if (/^\d+$/u.test(domF ?? "") && dowF === "*") {
                return {
                    ...base,
                    mode: "repeating",
                    repeatPreset: "monthly",
                    repeatTime,
                    repeatDayOfMonth: Number.parseInt(domF ?? "1", 10),
                };
            }
        }
    }

    // Check daemon-canonical RFC 5545 forms
    const lines = text.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
    const hasExOrRdate = lines.some((l) => /^(?:EXDATE|RDATE)\b/u.test(l));
    const dtstartLine = lines.find((l) => l.startsWith("DTSTART"));
    const rruleLine = lines.find((l) => l.startsWith("RRULE:") || l.startsWith("FREQ="));
    if (!hasExOrRdate && rruleLine) {
        const body = rruleLine.startsWith("RRULE:") ? rruleLine.slice(6) : rruleLine;
        /** @type {Record<string, string>} */
        const parts = {};
        for (const pair of body.split(";")) {
            const eq = pair.indexOf("=");
            if (eq > 0) parts[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const keys = Object.keys(parts).filter((k) => k !== "BYSECOND");
        if (parts.FREQ === "SECONDLY" && parts.COUNT === "1" && dtstartLine && keys.length === 2) {
            const dtMatch = /:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}/u.exec(dtstartLine);
            if (dtMatch) {
                return {
                    ...base,
                    mode: "at",
                    atLocal: `${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}T${dtMatch[4]}:${dtMatch[5]}`,
                };
            }
        }
        const hasNoBounds = !parts.COUNT && !parts.UNTIL && !parts.BYMONTH && !parts.BYSETPOS;
        if (hasNoBounds) {
            if (parts.FREQ === "MINUTELY" && !parts.BYHOUR && !parts.BYDAY && !parts.BYMONTHDAY) {
                const interval = parts.INTERVAL ? Number.parseInt(parts.INTERVAL, 10) : 1;
                if (Number.isInteger(interval) && interval >= 1) {
                    return { ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: interval };
                }
            }
            if (parts.FREQ === "HOURLY" && !parts.BYHOUR && !parts.BYDAY && !parts.BYMONTHDAY && (!parts.BYMINUTE || parts.BYMINUTE === "0")) {
                const interval = parts.INTERVAL ? Number.parseInt(parts.INTERVAL, 10) : 1;
                if (Number.isInteger(interval) && interval >= 1) {
                    return { ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: interval };
                }
            }
            const singleHour = /^\d+$/u.test(parts.BYHOUR ?? "") ? Number.parseInt(parts.BYHOUR ?? "9", 10) : null;
            const singleMin = /^\d+$/u.test(parts.BYMINUTE ?? "") ? Number.parseInt(parts.BYMINUTE ?? "0", 10) : null;
            if (singleHour !== null && singleMin !== null && !parts.INTERVAL) {
                const repeatTime = `${pad2(singleHour)}:${pad2(singleMin)}`;
                if (parts.FREQ === "DAILY" && !parts.BYDAY && !parts.BYMONTHDAY) {
                    return { ...base, mode: "repeating", repeatPreset: "daily", repeatTime };
                }
                if (parts.FREQ === "WEEKLY" && parts.BYDAY && !parts.BYMONTHDAY) {
                    const tokens = parts.BYDAY.split(",");
                    /** @type {number[]} */
                    const mapped = [];
                    let valid = true;
                    for (const tok of tokens) {
                        if (Object.hasOwn(ICAL_DOW_TO_CRON, tok)) {
                            mapped.push(ICAL_DOW_TO_CRON[/** @type {keyof typeof ICAL_DOW_TO_CRON} */ (tok)]);
                        } else {
                            valid = false;
                            break;
                        }
                    }
                    if (valid && mapped.length > 0) {
                        const sorted = [...new Set(mapped)].toSorted((a, b) => a - b);
                        if (sorted.join(",") === "1,2,3,4,5") {
                            return { ...base, mode: "repeating", repeatPreset: "weekdays", repeatTime };
                        }
                        return { ...base, mode: "repeating", repeatPreset: "weekly", repeatTime, repeatDays: sorted };
                    }
                }
                if (parts.FREQ === "MONTHLY" && /^\d+$/u.test(parts.BYMONTHDAY ?? "") && !parts.BYDAY) {
                    return {
                        ...base,
                        mode: "repeating",
                        repeatPreset: "monthly",
                        repeatTime,
                        repeatDayOfMonth: Number.parseInt(parts.BYMONTHDAY ?? "1", 10),
                    };
                }
            }
        }
    }

    return { ...base, mode: "custom", customRule: text };
}

/**
 * @param {HTMLFormElement} form
 * @returns {ScheduleTimingState}
 */
export function readTimingState(form) {
    const modeEl = $(form, 'select[name="scheduleMode"]');
    const relAmtEl = $(form, 'input[name="relativeAmount"]');
    const relUnitEl = $(form, 'select[name="relativeUnit"]');
    const atEl = $(form, 'input[name="atLocal"]');
    const repeatPresetEl = $(form, 'select[name="repeatPreset"]');
    const repeatIntervalEl = $(form, 'input[name="repeatInterval"]');
    const repeatTimeEl = $(form, 'input[name="repeatTime"]');
    const repeatDomEl = $(form, 'input[name="repeatDayOfMonth"]');
    const customEl = $(form, 'input[name="rule"]');
    const checkedDays = $$(form, 'input[name="repeatDay"]:checked')
        .filter((el) => el instanceof HTMLInputElement)
        .map((el) => Number.parseInt(/** @type {HTMLInputElement} */ (el).value, 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const rawMode = modeEl instanceof HTMLSelectElement ? modeEl.value : "manual";
    const mode = rawMode === "once" || rawMode === "relative" || rawMode === "at" || rawMode === "repeating" || rawMode === "custom"
        ? rawMode
        : "manual";
    const rawUnit = relUnitEl instanceof HTMLSelectElement ? relUnitEl.value : "m";
    const relativeUnit = rawUnit === "s" || rawUnit === "m" || rawUnit === "h" || rawUnit === "d" || rawUnit === "w"
        ? rawUnit
        : "m";
    const rawPreset = repeatPresetEl instanceof HTMLSelectElement ? repeatPresetEl.value : "daily";
    const repeatPreset = rawPreset === "weekdays" || rawPreset === "weekly" || rawPreset === "monthly" || rawPreset === "every-hours" || rawPreset === "every-minutes"
        ? rawPreset
        : "daily";
    return {
        mode,
        relativeAmount: relAmtEl instanceof HTMLInputElement ? Number.parseInt(relAmtEl.value, 10) : 15,
        relativeUnit,
        atLocal: atEl instanceof HTMLInputElement ? atEl.value : "",
        repeatPreset,
        repeatInterval: repeatIntervalEl instanceof HTMLInputElement ? Number.parseInt(repeatIntervalEl.value, 10) : 1,
        repeatTime: repeatTimeEl instanceof HTMLInputElement ? repeatTimeEl.value : "09:00",
        repeatDays: checkedDays,
        repeatDayOfMonth: repeatDomEl instanceof HTMLInputElement ? Number.parseInt(repeatDomEl.value, 10) : 1,
        customRule: customEl instanceof HTMLInputElement ? customEl.value : "",
    };
}

/**
 * @param {HTMLFormElement} form
 * @param {ScheduleTimingState} state
 * @param {string | null} editingAlias
 */
export function writeTimingState(form, state, editingAlias) {
    const setVal = (/** @type {string} */ selector, /** @type {string} */ value) => {
        const el = $(form, selector);
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = value;
    };
    setVal('select[name="scheduleMode"]', state.mode);
    setVal('input[name="relativeAmount"]', String(state.relativeAmount));
    setVal('select[name="relativeUnit"]', state.relativeUnit);
    setVal('input[name="atLocal"]', state.atLocal);
    setVal('select[name="repeatPreset"]', state.repeatPreset);
    setVal('input[name="repeatInterval"]', String(state.repeatInterval));
    setVal('input[name="repeatTime"]', state.repeatTime);
    setVal('input[name="repeatDayOfMonth"]', String(state.repeatDayOfMonth));
    setVal('input[name="rule"]', state.customRule);
    const daySet = new Set(state.repeatDays);
    for (const box of $$(form, 'input[name="repeatDay"]')) {
        if (box instanceof HTMLInputElement) {
            box.checked = daySet.has(Number.parseInt(box.value, 10));
        }
    }
    syncScheduleFormAttributes(form, editingAlias);
}

/**
 * @param {HTMLFormElement} form
 * @param {string | null} editingAlias
 */
export function syncScheduleFormAttributes(form, editingAlias) {
    const kindEl = $(form, 'select[name="kind"]');
    const modeEl = $(form, 'select[name="scheduleMode"]');
    const repeatEl = $(form, 'select[name="repeatPreset"]');
    const kind = kindEl instanceof HTMLSelectElement && kindEl.value === "run" ? "run" : "prompt";
    const mode = modeEl instanceof HTMLSelectElement ? modeEl.value : "manual";
    const repeat = repeatEl instanceof HTMLSelectElement ? repeatEl.value : "daily";
    the(form, {
        "schedule-kind": kind,
        "schedule-mode": mode,
        "schedule-repeat": repeat,
        "schedule-editing": editingAlias !== null ? "true" : "false",
        "schedule-editing-alias": editingAlias ?? "",
    });
}

/**
 * {§web-workspace-settings} Debounced `workspace.schedule.discover` live occurrence preview controller.
 * @param {HTMLFormElement} form
 * @param {{
 *   getContext: () => { readonly workspaceId: number, readonly signal: AbortSignal },
 *   invoke: (kind: string, params?: Record<string, unknown>) => Promise<unknown>,
 * }} host
 */
export function createSchedulePreviewController(form, host) {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let previewTimer = null;
    /** @type {AbortController | null} */
    let previewAbort = null;

    function dispose() {
        if (previewTimer !== null) {
            clearTimeout(previewTimer);
            previewTimer = null;
        }
        previewAbort?.abort();
        previewAbort = null;
    }

    /** @param {{ immediate?: boolean }} [opts] */
    function schedule(opts = {}) {
        dispose();
        const state = readTimingState(form);
        if (state.mode === "manual") {
            the(form, "schedule-preview", "Manual trigger — runs only when triggered on demand and stays open.");
            return;
        }
        if (state.mode === "once") {
            the(form, "schedule-preview", "Single-shot obligation — runs once on demand, then transitions open → done.");
            return;
        }

        let rule;
        try {
            rule = synthesizeScheduleRule(state);
        } catch (err) {
            the(form, "schedule-preview", err instanceof Error ? err.message : String(err));
            return;
        }
        const runPreview = async () => {
            const ctx = host.getContext();
            if (ctx.workspaceId <= 0) return;
            const req = previewAbort = new AbortController();
            the(form, "schedule-preview", `Previewing ${rule}…`);
            try {
                const res = await host.invoke("workspace.schedule.discover", { rule });
                if (req.signal.aborted || ctx.signal.aborted) return;
                const candidates = isRecord(res) && Array.isArray(res.candidates) ? res.candidates : [];
                const first = candidates.find(isRecord);
                const summary = typeof first?.summary === "string" && first.summary
                    ? first.summary
                    : `Rule: ${rule}`;
                the(form, "schedule-preview", `${rule} — ${summary}`);
            } catch (error) {
                if (req.signal.aborted || ctx.signal.aborted) return;
                const { message } = await describeFailure(error);
                the(form, "schedule-preview", message);
            } finally {
                if (previewAbort === req) previewAbort = null;
            }
        };

        if (opts.immediate) {
            void runPreview();
        } else {
            previewTimer = setTimeout(() => {
                previewTimer = null;
                void runPreview();
            }, SCHEDULE_PREVIEW_DEBOUNCE_MS);
        }
    }

    return {
        schedule,
        dispose,
    };
}
