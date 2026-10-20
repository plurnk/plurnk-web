import { directoryPath } from "../ai.plurnk/directory-addresses.js";

/** @typedef {{worker: import("@plurnk/plurnk-agui/client").AguiDescendant, children: DescendantNode[]}} DescendantNode */

/** {§web-worker-descendants} Nest one supplied census, not an accumulated browser topology.
 * @param {readonly import("@plurnk/plurnk-agui/client").AguiDescendant[]} workers
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
    return `${hours ? `${hours}h ` : ""}${hours || minutes ? `${minutes}m ` : ""}${seconds % 60}s`;
}

/** {§web-worker-observer} Elapsed time is a projection of daemon timestamps, not a browser stopwatch.
 * @param {import("@plurnk/plurnk-agui/client").AguiStatusState} status @param {number} now
 */
export function elapsed(status, now) {
    if (status.claimedAt === null) return "Unknown";
    const seconds = Math.max(0, Math.floor(((status.terminatedAt ?? now) - status.claimedAt) / 1000));
    return duration(seconds);
}

/** {§web-worker-status} Time never supplies a lifecycle transition.
 * @param {import("@plurnk/plurnk-agui/client").AguiStatusState} status @param {number} now
 */
export function clocks(status, now) {
    return {
        elapsed: elapsed(status, now),
        wait: status.waitUntil === null ? "None" : duration(Math.max(0, Math.ceil((status.waitUntil - now) / 1000))),
        waitAt: status.waitUntil === null ? null : new Date(status.waitUntil).toISOString(),
    };
}

/** @param {import("@plurnk/plurnk-contracts").ProviderUsage | null} usage */
function quantities(usage) {
    return {
        input: usage?.inputTokens, output: usage?.outputTokens, total: usage?.totalTokens,
        uncached: usage?.inputTokenDetails?.noCacheTokens, "cache-read": usage?.inputTokenDetails?.cacheReadTokens,
        "cache-write": usage?.inputTokenDetails?.cacheWriteTokens,
        text: usage?.outputTokenDetails?.textTokens, reasoning: usage?.outputTokenDetails?.reasoningTokens,
    };
}

/** {§web-worker-status} Unknown complete values and known subtotals are different facts.
 * @param {import("@plurnk/plurnk-agui/client").AguiStatusState} status
 * @param {import("@plurnk/plurnk-agui/client").AguiBudgetState} [budget]
 */
export function gauges(status, budget) {
    const { model, spend } = status;
    const tree = descendantTree(status.descendants);
    const complete = { ...quantities(spend.usage), cost: spend.costUsd };
    const known = { ...quantities(spend.knownUsage), cost: spend.knownCostUsd };
    return {
        lifecycle: status.lifecycle,
        loop: status.loopId === null ? "None" : String(status.loopId),
        turns: String(status.packetCount),
        requests: String(status.spend.requests),
        input: String(status.spend.usage?.inputTokens ?? "Unknown"),
        output: String(status.spend.usage?.outputTokens ?? "Unknown"),
        cost: status.spend.costUsd ?? "Unknown",
        model: model === null ? "Not selected" : `${model.alias ? `${model.alias} — ` : ""}${model.provider}/${model.model}`,
        effort: model?.effort === undefined ? "Unspecified" : `${model.effort}${model.effortSource ? ` (${model.effortSource})` : ""}`,
        children: String(tree.filter(({ worker }) => ["queued", "running", "parked"].includes(worker.lifecycle)).length),
        descendants: String(status.descendants.length),
        gated: String(status.descendants.filter(({ gates }) => gates > 0).length),
        context: `${budget?.contextTokens ?? "Unknown"} / ${budget?.contextCapacity ?? "Unknown"}`,
        curation: `${budget?.curationWeight ?? "Unknown"} / ${budget?.curationBudget ?? "Unknown"}`,
        inbox: String(status.inbox.length),
        ...Object.fromEntries(Object.entries(complete).flatMap(([key, value]) => [
            [`usage-${key}`, String(value ?? "Unknown")],
            [`known-${key}`, value == null ? String(known[/** @type {keyof typeof known} */ (key)] ?? "Unknown") : "—"],
        ])),
    };
}

/** {§web-worker-identity} One directory codec for server and browser navigation.
 * @param {Pick<import("@plurnk/plurnk-agui/client").AguiWorkspaceState, "name" | "projectLabel">} workspace
 * @param {string} worker
 */
export function workspaceIdentity({ name, projectLabel }, worker) {
    const workspacePath = directoryPath({ kind: "workspace", workspace: name });
    const workerPath = directoryPath({ kind: "worker", workspace: name, worker });
    if (workspacePath === null || workerPath === null) throw new Error("Workspace has no directory address.");
    const namedFolder = projectLabel !== null && projectLabel !== name;
    return {
        workspaceName: name, workspacePath, workerPath, projectLabel: namedFolder ? projectLabel : "",
        workspaceIcon: projectLabel !== null && !namedFolder ? "📁" : "☁️",
        workspaceIconLabel: projectLabel === null ? "Folderless workspace" : namedFolder ? "Workspace" : "Project workspace",
        pageTitle: `${name}@${worker} — Plurnk`,
    };
}
