import { $, on, the } from "on_the_money";
import { directoryPath } from "../src/directory-addresses.js";
import { isRecord } from "./session-translator.js";

/**
 * @typedef {{
 *   readonly index: number,
 *   readonly server: string,
 *   readonly tool: string,
 *   readonly status: number,
 *   readonly uri?: string,
 *   readonly preview?: string,
 *   readonly problem?: Record<string, unknown>,
 * }} ScheduledStepReceipt
 */

/**
 * @param {unknown} raw
 * @returns {readonly ScheduledStepReceipt[]}
 */
export function parseStepReceipts(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {ScheduledStepReceipt[]} */
    const out = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        if (typeof item.server !== "string" || typeof item.tool !== "string" || typeof item.status !== "number") continue;
        out.push({
            index: typeof item.index === "number" ? item.index : out.length,
            server: item.server,
            tool: item.tool,
            status: item.status,
            ...(typeof item.uri === "string" ? { uri: item.uri } : {}),
            ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
            ...(isRecord(item.problem) ? { problem: item.problem } : {}),
        });
    }
    return out;
}

/**
 * Format a compact human summary of a schedule's action (`Prompt` target or `Run` step chain).
 * @param {Record<string, unknown>} def
 * @returns {string}
 */
export function formatScheduleAction(def) {
    if (Array.isArray(def.run)) {
        const calls = def.run.filter(isRecord).map((step) => {
            const srv = typeof step.server === "string" ? step.server : "?";
            const tool = typeof step.tool === "string" ? step.tool : "?";
            return `${srv}.${tool}`;
        });
        if (calls.length === 0) return "0 steps";
        const preview = calls.length <= 3 ? calls.join(" → ") : `${calls.slice(0, 3).join(" → ")} +${calls.length - 3}`;
        return `${calls.length} ${calls.length === 1 ? "step" : "steps"}: ${preview}`;
    }
    const target = typeof def.target === "string" ? def.target : "";
    const persona = typeof def.persona === "string" && def.persona ? ` (${def.persona})` : "";
    const prompt = typeof def.prompt === "string" ? def.prompt.trim().replace(/\s+/gu, " ") : "";
    const clipped = prompt.length > 72 ? `${prompt.slice(0, 71)}…` : prompt;
    return [target ? `${target}${persona}` : "", clipped].filter(Boolean).join(" · ");
}

/**
 * {§web-workspace-settings} Render the schedule inventory table from a `workspace.schedule.list` response.
 * @param {HTMLElement} panel
 * @param {HTMLTableSectionElement} tbody
 * @param {unknown} res
 * @param {Map<string, Record<string, unknown>>} scheduleByAlias
 */
export function renderScheduleList(panel, tbody, res, scheduleByAlias) {
    const rawItems = isRecord(res) && Array.isArray(res.definitions) ? res.definitions : [];
    const items = rawItems.filter(isRecord);
    scheduleByAlias.clear();
    for (const item of items) {
        if (typeof item.alias === "string" && item.alias) {
            scheduleByAlias.set(item.alias, item);
        }
    }
    $.cloneEach(tbody, "#workspace-schedule-row", items, (tr, item) => {
        const alias = typeof item.alias === "string" ? item.alias : "";
        const origin = typeof item.origin === "string" ? item.origin : "workspace";
        const state = typeof item.state === "string" ? item.state : "active";
        const def = isRecord(item.definition) ? item.definition : {};
        const detail = isRecord(item.detail) ? item.detail : {};
        const isRun = Array.isArray(def.run) || detail.kind === "run";
        const ruleStr = typeof detail.rule === "string" ? detail.rule : (typeof def.rule === "string" ? def.rule : "manual");
        const ruleText = typeof detail.text === "string" && detail.text
            ? detail.text
            : ruleStr === "manual"
                ? "manual trigger"
                : ruleStr === "once"
                    ? "unscheduled single-shot obligation"
                    : ruleStr;
        const nextStr = typeof detail.next === "string" && detail.next ? `Next: ${detail.next}` : "";
        const obligation = detail.status === "done" || detail.status === "fail"
            ? detail.status
            : state === "unavailable"
                ? "fail"
                : "open";
        const problemDetail = (state === "unavailable" || obligation === "fail") && isRecord(item.problem)
            ? (typeof item.problem.detail === "string" ? item.problem.detail
                : typeof item.problem.title === "string" ? item.problem.title : "")
            : "";
        const statusText = state === "disabled"
            ? "disabled"
            : problemDetail
                ? `${obligation}: ${problemDetail}`
                : obligation;
        const metaParts = [];
        if (typeof detail.lastFiredAt === "string" && detail.lastFiredAt) metaParts.push(`Last: ${detail.lastFiredAt}`);
        if (typeof detail.doneAt === "string" && detail.doneAt) metaParts.push(`Done: ${detail.doneAt}`);
        if (origin !== "workspace") metaParts.push(origin);
        const rowState = state === "disabled" ? "disabled"
            : state === "unavailable" ? "retryable"
            : "active";
        const canRun = state !== "disabled" && !(ruleStr === "once" && obligation === "done");
        the(tr, {
            "sched-alias": alias,
            "sched-kind": isRun ? "Macro" : "Prompt",
            "sched-rule-text": ruleText,
            "sched-next": nextStr,
            "sched-action": formatScheduleAction(def),
            "sched-status": statusText,
            "sched-meta": metaParts.join(" · "),
            "family-removable": origin === "workspace" ? "true" : "false",
            "family-state": rowState,
            "schedule-obligation": obligation,
            "schedule-can-run": canRun ? "true" : "false",
            "schedule-row-kind": isRun ? "run" : "prompt",
        });
        const runBtn = $(tr, "[data-schedule-run]");
        if (runBtn instanceof HTMLButtonElement) runBtn.disabled = !canRun;
    });
    the(panel, { "family-count": items.length });
}

/**
 * {§web-workspace-settings} Inline execution receipt drawer (`[data-schedule-receipt]`) and `workspace.schedule.run` handler.
 * @param {HTMLElement} receiptBox
 * @param {{
 *   getContext: () => { readonly workspaceName: string },
 *   invoke: (kind: string, params?: Record<string, unknown>) => Promise<unknown>,
 *   runMutation: (work: (signal: AbortSignal) => Promise<string>) => Promise<void>,
 *   renderList: (res: unknown) => void,
 *   refreshList?: () => Promise<void>,
 * }} options
 */
export function createScheduleReceiptController(receiptBox, { getContext, invoke, runMutation, renderList, refreshList }) {
    /** @type {string | null} */
    let lastReceiptAlias = null;

    /**
     * @param {{
     *   readonly alias: string,
     *   readonly status: string,
     *   readonly ok: boolean,
     *   readonly summary: string,
     *   readonly meta?: string,
     *   readonly results?: readonly ScheduledStepReceipt[],
     *   readonly sessionTarget?: string | null,
     *   readonly showReopen?: boolean,
     * }} receipt
     */
    function renderReceipt(receipt) {
        lastReceiptAlias = receipt.alias;
        the(receiptBox, {
            "receipt-status": receipt.ok ? "ok" : "error",
            "receipt-alias": receipt.alias,
            "receipt-status-label": receipt.status,
            "receipt-meta": receipt.meta ?? "",
            "receipt-summary": receipt.summary,
        });
        const reopenBtn = $(receiptBox, "[data-receipt-reopen]");
        if (reopenBtn instanceof HTMLButtonElement) reopenBtn.hidden = receipt.showReopen !== true;

        const linkLine = $(receiptBox, "[data-receipt-session-link]");
        const ctx = getContext();
        const sessionHref = receipt.sessionTarget && ctx.workspaceName
            ? directoryPath({ kind: "session", workspace: ctx.workspaceName, session: receipt.sessionTarget })
            : null;
        if (linkLine instanceof HTMLElement) {
            if (sessionHref && receipt.sessionTarget) {
                the(linkLine, {
                    "receipt-session-href": sessionHref,
                    "receipt-session-label": `Open session #${receipt.sessionTarget} →`,
                });
                linkLine.hidden = false;
            } else {
                linkLine.hidden = true;
            }
        }

        const stepsOl = $(receiptBox, "[data-schedule-receipt-steps]");
        if (stepsOl instanceof HTMLOListElement) {
            const steps = receipt.results ?? [];
            stepsOl.hidden = steps.length === 0;
            $.cloneEach(stepsOl, "#schedule-receipt-step", steps, (li, step) => {
                li.dataset.receiptStepOk = step.status < 400 ? "true" : "false";
                const idxEl = $(li, "[data-receipt-step-index]");
                const callEl = $(li, "[data-receipt-step-call]");
                const statusEl = $(li, "[data-receipt-step-status]");
                const uriEl = $(li, "[data-receipt-step-uri]");
                const preEl = $(li, "[data-receipt-step-preview]");
                const codeEl = preEl ? $(preEl, "code") : null;
                const probEl = $(li, "[data-receipt-step-problem]");
                if (idxEl) idxEl.textContent = `#${step.index + 1}`;
                if (callEl) callEl.textContent = `${step.server}.${step.tool}`;
                if (statusEl) statusEl.textContent = String(step.status);
                if (uriEl instanceof HTMLElement) {
                    uriEl.textContent = step.uri ?? "";
                    uriEl.hidden = !step.uri;
                }
                if (preEl instanceof HTMLElement && codeEl) {
                    codeEl.textContent = step.preview ?? "";
                    preEl.hidden = !step.preview;
                }
                if (probEl instanceof HTMLElement) {
                    const probDetail = isRecord(step.problem)
                        ? [
                            typeof step.problem.detail === "string" ? step.problem.detail : "",
                            typeof step.problem.recovery === "string" ? step.problem.recovery : "",
                        ].filter(Boolean).join(" ")
                        : "";
                    probEl.textContent = probDetail;
                    probEl.hidden = !probDetail;
                }
            });
        }
        receiptBox.hidden = false;
    }

    /**
     * @param {string} alias
     * @param {string | null} sessionTarget
     */
    function runScheduleNow(alias, sessionTarget) {
        void runMutation(async () => {
            try {
                const res = await invoke("workspace.schedule.run", { alias });
                if (refreshList) {
                    await refreshList();
                } else {
                    const fresh = await invoke("workspace.schedule.list", {});
                    renderList(fresh);
                }
                const rec = isRecord(res) ? res : {};
                const status = typeof rec.status === "string" ? rec.status : "open";
                const loopId = typeof rec.loopId === "number" ? rec.loopId : null;
                const lastFiredAt = typeof rec.lastFiredAt === "string" ? rec.lastFiredAt : "";
                const results = parseStepReceipts(rec.results);
                const meta = [
                    loopId !== null ? `loop ${loopId}` : "",
                    lastFiredAt ? `fired ${lastFiredAt}` : "",
                ].filter(Boolean).join(" · ");
                renderReceipt({
                    alias,
                    status,
                    ok: true,
                    summary: results.length > 0
                        ? `Completed ${results.length} ${results.length === 1 ? "step" : "steps"}.`
                        : sessionTarget
                            ? `Delivered prompt to session://${sessionTarget}.`
                            : "Executed schedule.",
                    meta,
                    results,
                    sessionTarget: results.length === 0 ? sessionTarget : null,
                });
                return results.length > 0
                    ? `${alias}  ${status} (${results.length} ${results.length === 1 ? "step" : "steps"})`
                    : `${alias}  ${status}`;
            } catch (error) {
                const cause = error instanceof Error && isRecord(error.cause) ? error.cause : null;
                const problemType = cause && typeof cause.type === "string" ? cause.type : "";
                const problemStatus = cause && typeof cause.status === "number" ? cause.status : 500;
                const problemDetail = cause && typeof cause.detail === "string"
                    ? cause.detail
                    : (error instanceof Error ? error.message : String(error));
                const results = parseStepReceipts(cause?.results);
                const isAlreadyDone = problemType.endsWith("/already-done");
                const isAlreadyRunning = problemType.endsWith("/already-running");
                renderReceipt({
                    alias,
                    status: isAlreadyDone ? "409 already-done" : isAlreadyRunning ? "409 already-running" : `${problemStatus} failed`,
                    ok: false,
                    summary: problemDetail,
                    results,
                    showReopen: isAlreadyDone,
                });
                if (refreshList) {
                    await refreshList().catch(() => null);
                } else {
                    const fresh = await invoke("workspace.schedule.list", {}).catch(() => null);
                    if (fresh !== null) renderList(fresh);
                }
                throw error;
            }
        });
    }

    on(receiptBox, "click", "[data-receipt-dismiss]", () => {
        receiptBox.hidden = true;
    });

    on(receiptBox, "click", "[data-receipt-reopen]", () => {
        if (!lastReceiptAlias) return;
        const alias = lastReceiptAlias;
        void runMutation(async () => {
            await invoke("workspace.schedule.status", { alias, status: "open" });
            if (refreshList) {
                await refreshList();
            } else {
                const fresh = await invoke("workspace.schedule.list", {});
                renderList(fresh);
            }
            receiptBox.hidden = true;
            return `${alias}  open`;
        });
    });

    return {
        renderReceipt,
        runScheduleNow,
    };
}
