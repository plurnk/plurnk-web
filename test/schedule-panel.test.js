import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGuidedFields, parseRuleToTimingState, synthesizeScheduleRule } from "../web/schedule-panel.js";
import {
    COLLECTION_PAGE_SIZE,
    extractMembersPreviewToken,
    formatCandidateSummary,
    formatCollectionSummary,
    formatMembersPreview,
} from "../web/workspace-collection.js";

test("{§web-workspace-settings} synthesizeScheduleRule and parseRuleToTimingState cover manual, once, relative, timestamp, repeating presets, RFC 5545 canonical round-trips, and custom fallback", () => {
    /** @type {import("../web/schedule-panel.js").ScheduleTimingState} */
    const base = {
        mode: "manual",
        relativeAmount: 15,
        relativeUnit: "m",
        atLocal: "2026-12-01T14:30",
        repeatPreset: "daily",
        repeatInterval: 1,
        repeatTime: "09:00",
        repeatDays: [1, 3, 5],
        repeatDayOfMonth: 15,
        customRule: "FREQ=YEARLY;BYMONTH=1",
    };

    assert.equal(synthesizeScheduleRule({ ...base, mode: "manual" }), "manual");
    assert.equal(parseRuleToTimingState("manual").mode, "manual");
    assert.equal(parseRuleToTimingState("").mode, "manual");

    assert.equal(synthesizeScheduleRule({ ...base, mode: "once" }), "once");
    assert.equal(parseRuleToTimingState("once").mode, "once");

    for (const [amount, unit, expected] of /** @type {const} */ ([
        [30, "s", "+30s"],
        [15, "m", "+15m"],
        [2, "h", "+2h"],
        [1, "d", "+1d"],
        [3, "w", "+3w"],
    ])) {
        assert.equal(synthesizeScheduleRule({ ...base, mode: "relative", relativeAmount: amount, relativeUnit: unit }), expected);
        const parsed = parseRuleToTimingState(expected);
        assert.equal(parsed.mode, "relative");
        assert.equal(parsed.relativeAmount, amount);
        assert.equal(parsed.relativeUnit, unit);
    }

    assert.equal(synthesizeScheduleRule({ ...base, mode: "at", atLocal: "2026-12-01T14:30" }), "2026-12-01T14:30:00");
    assert.equal(parseRuleToTimingState("2026-12-01T14:30:00").mode, "at");
    assert.equal(parseRuleToTimingState("2026-12-01T14:30:00").atLocal, "2026-12-01T14:30");
    const parsedCanonicalOnce = parseRuleToTimingState("DTSTART;TZID=America/New_York:20261201T143000\nRRULE:FREQ=SECONDLY;COUNT=1");
    assert.equal(parsedCanonicalOnce.mode, "at");
    assert.equal(parsedCanonicalOnce.atLocal, "2026-12-01T14:30");

    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: 1 }), "* * * * *");
    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "every-minutes", repeatInterval: 10 }), "*/10 * * * *");
    assert.deepEqual(
        [parseRuleToTimingState("*/10 * * * *").repeatPreset, parseRuleToTimingState("*/10 * * * *").repeatInterval],
        ["every-minutes", 10],
    );
    assert.deepEqual(
        [parseRuleToTimingState("DTSTART;TZID=UTC:20261123T090000\nRRULE:FREQ=MINUTELY;INTERVAL=5;BYSECOND=0").repeatPreset, parseRuleToTimingState("DTSTART;TZID=UTC:20261123T090000\nRRULE:FREQ=MINUTELY;INTERVAL=5;BYSECOND=0").repeatInterval],
        ["every-minutes", 5],
    );

    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: 1 }), "0 * * * *");
    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "every-hours", repeatInterval: 4 }), "0 */4 * * *");
    assert.deepEqual(
        [parseRuleToTimingState("0 */4 * * *").repeatPreset, parseRuleToTimingState("0 */4 * * *").repeatInterval],
        ["every-hours", 4],
    );

    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "daily", repeatTime: "07:45" }), "45 7 * * *");
    const parsedDaily = parseRuleToTimingState("DTSTART;TZID=UTC:20261123T074500\nRRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=45;BYSECOND=0");
    assert.equal(parsedDaily.mode, "repeating");
    assert.equal(parsedDaily.repeatPreset, "daily");
    assert.equal(parsedDaily.repeatTime, "07:45");

    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "weekdays", repeatTime: "09:00" }), "0 9 * * 1-5");
    const parsedWeekdays = parseRuleToTimingState("DTSTART;TZID=UTC:20261123T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
    assert.equal(parsedWeekdays.repeatPreset, "weekdays");
    assert.equal(parsedWeekdays.repeatTime, "09:00");

    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "weekly", repeatTime: "18:30", repeatDays: [5, 1, 3] }), "30 18 * * 1,3,5");
    const parsedWeekly = parseRuleToTimingState("DTSTART;TZID=UTC:20261123T183000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=30;BYSECOND=0");
    assert.equal(parsedWeekly.repeatPreset, "weekly");
    assert.deepEqual(parsedWeekly.repeatDays, [1, 3, 5]);
    assert.equal(parsedWeekly.repeatTime, "18:30");

    assert.equal(synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "monthly", repeatTime: "08:15", repeatDayOfMonth: 15 }), "15 8 15 * *");
    const parsedMonthly = parseRuleToTimingState("DTSTART;TZID=UTC:20261115T081500\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=8;BYMINUTE=15;BYSECOND=0");
    assert.equal(parsedMonthly.repeatPreset, "monthly");
    assert.equal(parsedMonthly.repeatDayOfMonth, 15);
    assert.equal(parsedMonthly.repeatTime, "08:15");

    // Complex RFC 5545 rules preserve exact text in custom mode without lossy simplification
    const complexRrule = "DTSTART;TZID=UTC:20261123T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0\nEXDATE;TZID=UTC:20261225T090000";
    const parsedComplex = parseRuleToTimingState(complexRrule);
    assert.equal(parsedComplex.mode, "custom");
    assert.equal(parsedComplex.customRule, complexRrule);

    // Validation errors on incomplete timing states
    assert.throws(() => synthesizeScheduleRule({ ...base, mode: "relative", relativeAmount: 0 }), /positive/u);
    assert.throws(() => synthesizeScheduleRule({ ...base, mode: "at", atLocal: "" }), /date and time/u);
    assert.throws(() => synthesizeScheduleRule({ ...base, mode: "repeating", repeatPreset: "weekly", repeatDays: [] }), /day of the week/u);
    assert.throws(() => synthesizeScheduleRule({ ...base, mode: "custom", customRule: "   " }), /Enter a schedule rule/u);
});

test("{§web-workspace-settings} extractGuidedFields maps JSON Schema scalar, $ref, oneOf, and string-array properties into guided step argument inputs", () => {
    const fields = extractGuidedFields({
        type: "object",
        required: ["path", "text"],
        $defs: {
            wsRef: { type: "string", description: "Workspace handle." },
        },
        properties: {
            path: {
                oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                description: "Target path or globs.",
            },
            text: { type: "string", description: "Body text." },
            count: { type: ["integer", "null"], description: "Max items." },
            ratio: { type: "number", description: "Scale factor." },
            force: { type: "boolean", description: "Overwrite existing." },
            mode: { type: "string", enum: ["fast", "safe"], description: "Run mode." },
            args: { type: "array", items: { type: "string" }, description: "Extra arguments." },
            workspace: { $ref: "#/$defs/wsRef" },
            nested: { type: "object", description: "Ignored in guided fields; edited in raw JSON." },
        },
    });
    assert.deepEqual(fields, [
        { name: "path", type: "string", required: true, description: "Target path or globs." },
        { name: "text", type: "textarea", required: true, description: "Body text." },
        { name: "count", type: "integer", required: false, description: "Max items." },
        { name: "ratio", type: "number", required: false, description: "Scale factor." },
        { name: "force", type: "boolean", required: false, description: "Overwrite existing." },
        { name: "mode", type: "enum", required: false, description: "Run mode.", enumValues: ["fast", "safe"] },
        { name: "args", type: "string-list", required: false, description: "Extra arguments." },
        { name: "workspace", type: "string", required: false, description: "Workspace handle." },
    ]);
    assert.deepEqual(extractGuidedFields(undefined), []);
});

test("{§web-workspace-settings} workspace collection helpers format paged list/discover summaries and inline members previews", () => {
    assert.equal(COLLECTION_PAGE_SIZE, 10);
    assert.deepEqual(
        formatCollectionSummary({ definitions: [{}, {}], offset: 0, total: 12, nextOffset: 2 }),
        { offset: 0, total: 12, nextOffset: 2, count: 2, summary: "Showing 1–2 of 12", canPrev: false, canNext: true },
    );
    assert.deepEqual(
        formatCollectionSummary({ definitions: [], offset: 0, total: 0 }),
        { offset: 0, total: 0, nextOffset: undefined, count: 0, summary: "Showing 0 of 0", canPrev: false, canNext: false },
    );

    assert.deepEqual(
        formatCandidateSummary({ candidates: Array.from({ length: 10 }, () => ({})), nextCursor: "c2" }, 0),
        { count: 10, total: undefined, nextCursor: "c2", summary: "Showing 1–10", canPrev: false, canNext: true },
    );
    assert.deepEqual(
        formatCandidateSummary({ candidates: [{}, {}], total: 12 }, 1),
        { count: 2, total: 12, nextCursor: undefined, summary: "Showing 11–12 of 12", canPrev: true, canNext: false },
    );

    assert.equal(extractMembersPreviewToken("docs/** !docs/drafts/**", 4), "docs/**");
    assert.equal(extractMembersPreviewToken("docs/** !docs/drafts/**", 15), "!docs/drafts/**");
    assert.equal(extractMembersPreviewToken("docs/**   ", 10), "docs/**");
    assert.equal(extractMembersPreviewToken("   ", 1), "");

    assert.deepEqual(
        formatMembersPreview({
            candidates: [{
                alias: "docs/**",
                summary: "fallback",
                detail: {
                    kind: "preview",
                    effect: "include",
                    pattern: "docs/**",
                    matched: 12,
                    fresh: 10,
                    alreadyMembers: 2,
                    ignored: 0,
                    files: Array.from({ length: 12 }, (_, i) => `docs/f${i + 1}.md`),
                },
            }],
        }),
        {
            state: "matched",
            summary: "12 matches (10 new, 2 already members)",
            files: Array.from({ length: 10 }, (_, i) => `docs/f${i + 1}.md`),
        },
    );
    assert.deepEqual(
        formatMembersPreview({
            candidates: [{
                alias: "README.md",
                summary: "member — tracked by git",
                detail: {
                    kind: "verdict",
                    verdict: "member",
                    path: "README.md",
                    matched: 1,
                    fresh: 0,
                    alreadyMembers: 1,
                    ignored: 0,
                    files: ["README.md"],
                },
            }],
        }),
        {
            state: "matched",
            summary: "1 match — member — tracked by git",
            files: ["README.md"],
        },
    );
});
