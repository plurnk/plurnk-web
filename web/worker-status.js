import { directoryPath } from "../ai.plurnk/directory-addresses.js";

/** @typedef {{worker: import("@plurnk/plurnk-acp/client").AcpDescendant, children: DescendantNode[]}} DescendantNode */

/** {§web-worker-descendants} Nest one supplied census, not an accumulated browser topology.
 * @param {readonly import("@plurnk/plurnk-acp/client").AcpDescendant[]} workers
 * @returns {DescendantNode[]}
 */
export function descendantTree(workers) {
    if (workers.length === 0) return [];
    const ids = new Set(workers.map(({ id }) => id));
    const parents = new Set(workers.filter(({ parentWorkerId }) => !ids.has(parentWorkerId)).map(({ parentWorkerId }) => parentWorkerId));
    if (ids.size !== workers.length || parents.size !== 1) throw new Error("Descendant census is not one worker tree.");
    const byParent = Map.groupBy(workers, ({ parentWorkerId }) => parentWorkerId);
    let visited = 0;
    /** @param {number} parent @returns {DescendantNode[]} */
    const nest = (parent) => (byParent.get(parent) ?? []).map((worker) => {
        visited++;
        return { worker, children: nest(worker.id) };
    });
    const tree = nest([...parents][0]);
    if (visited !== workers.length) throw new Error("Descendant census is not one worker tree.");
    return tree;
}

/** @param {number} seconds */
function duration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return `${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${hours || minutes ? String(seconds % 60).padStart(2, "0") : seconds % 60}s`;
}

/** {§web-worker-observer} Elapsed time is a projection of daemon timestamps, not a browser stopwatch.
 * @param {import("@plurnk/plurnk-acp/client").AcpStatusState} status @param {number} now
 */
export function elapsed(status, now) {
    if (status.claimedAt === null) return "";
    const seconds = Math.max(0, Math.floor(((status.terminatedAt ?? now) - status.claimedAt) / 1000));
    return duration(seconds);
}

/** {§web-worker-status} Time never supplies a lifecycle transition.
 * @param {import("@plurnk/plurnk-acp/client").AcpStatusState} status @param {number} now
 */
export function clocks(status, now) {
    return {
        elapsed: elapsed(status, now),
        wait: status.waitUntil === null ? "" : duration(Math.max(0, Math.ceil((status.waitUntil - now) / 1000))),
        waitAt: status.waitUntil === null ? null : new Date(status.waitUntil).toISOString(),
    };
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const COST_DIGITS = 4;
const dollars = new Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: COST_DIGITS, maximumFractionDigits: COST_DIGITS });

/** @param {number} value */
const tokens = (value) => compact.format(value).toLowerCase();

/** @param {string} value */
function cost(value) {
    const amount = Number(value);
    const precision = 10 ** -COST_DIGITS;
    return amount > 0 && amount < precision ? `<${dollars.format(precision)}` : dollars.format(amount);
}

/** @template {number | string} T @param {T | null | undefined} total @param {T | null | undefined} known
 * @param {(value: T) => string} format
 */
function amount(total, known, format) {
    return total != null ? { text: format(total), exact: String(total) }
        : known != null ? { text: `${format(known)} + ?`, exact: `unknown total; known subtotal ${known}` }
        : { text: "?", exact: "unknown" };
}

/** @param {number | null | undefined} used @param {number | null | undefined} capacity */
const occupancy = (used, capacity) => used != null && capacity != null && capacity > 0
    ? `${Math.round(used / capacity * 100)}%/${tokens(capacity)}` : "";

/** {§web-worker-status} Unknown complete values and known subtotals are different facts.
 * @param {import("@plurnk/plurnk-acp/client").AcpStatusState} status
 * @param {import("@plurnk/plurnk-acp/client").AcpBudgetState} [budget]
 */
export function gauges(status, budget) {
    const { model, spend } = status;
    const tree = descendantTree(status.descendants);
    const children = tree.filter(({ worker }) => ["queued", "running", "parked"].includes(worker.lifecycle)).length;
    const input = amount(spend.usage?.inputTokens, spend.knownUsage?.inputTokens, tokens);
    const output = amount(spend.usage?.outputTokens, spend.knownUsage?.outputTokens, tokens);
    const price = amount(spend.costUsd, spend.knownCostUsd, cost);
    const gated = status.descendants.filter(({ gates }) => gates > 0).length;
    return {
        lifecycle: status.lifecycle,
        input: input.text, output: output.text, cost: price.text === "?" ? "$?" : price.text,
        usageLabel: `Cumulative tokens, worker and descendants. Input: ${input.exact}. Output: ${output.exact}.`,
        costLabel: `Cumulative USD, worker and descendants: ${price.exact}.`,
        model: model === null ? "No model" : model.alias || `${model.provider}/${model.model}`,
        effort: model?.effort ?? "",
        modelLabel: model === null ? "No model selected" : `Model: ${model.provider}/${model.model}${model.effort ? `; effort: ${model.effort}${model.effortSource ? ` (${model.effortSource})` : ""}` : ""}`,
        descendants: String(status.descendants.length),
        descendantsLabel: `Descendant workers: ${status.descendants.length}; active direct children: ${children}`,
        gated: String(gated), gatedLabel: `Descendant workers awaiting input: ${gated}`,
        context: occupancy(budget?.contextTokens, budget?.contextCapacity),
        contextLabel: `Current packet context: ${budget?.contextTokens ?? "unknown"} / ${budget?.contextCapacity ?? "unknown"} tokens`,
        inbox: String(status.inbox.length), inboxLabel: `Accepted messages not yet observed: ${status.inbox.length}`,
    };
}

/** {§web-worker-identity} One directory codec for server and browser navigation.
 * @param {Pick<import("@plurnk/plurnk-acp/client").AcpWorkspaceState, "name" | "projectLabel">} workspace
 * @param {string} worker
 */
export function workspaceIdentity({ name, projectLabel }, worker) {
    const workspacePath = directoryPath({ kind: "workspace", workspace: name });
    const workerPath = directoryPath({ kind: "worker", workspace: name, worker });
    if (workspacePath === null || workerPath === null) throw new Error("Workspace has no directory address.");
    const namedFolder = projectLabel !== null && projectLabel !== name;
    return {
        workspaceName: name, workspacePath, workerPath, projectLabel: namedFolder ? projectLabel : "",
        workspaceIcon: projectLabel !== null && !namedFolder ? "🗂️" : "☁️",
        workspaceIconLabel: projectLabel === null ? "Folderless workspace" : namedFolder ? "Workspace" : "Project workspace",
        pageTitle: `${name}@${worker} — Plurnk`,
    };
}
