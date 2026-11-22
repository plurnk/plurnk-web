import { directoryPath, workspaceSettingsPath } from "../src/directory-addresses.js";

/** @typedef {Omit<import("@plurnk/plurnk-acp/client").AcpDescendantState, "gates"> & {gates: import("@plurnk/plurnk-acp/client").AcpDescendantState["gates"] | number}} DescendantItem */
/** @typedef {{session: DescendantItem, children: DescendantNode[]}} DescendantNode */

/** @param {DescendantItem["gates"]} gates */
export const gateCount = (gates) => typeof gates === "number" ? gates : gates.length;

/** {§web-session-descendants} Nest one supplied census, not an accumulated browser topology.
 * @param {readonly DescendantItem[]} sessions
 * @returns {DescendantNode[]}
 */
export function descendantTree(sessions) {
    if (sessions.length === 0) return [];
    const ids = new Set(sessions.map(({ id }) => id));
    const parents = new Set(
        sessions
            .filter(({ parentSessionId }) => parentSessionId === null || !ids.has(parentSessionId))
            .map(({ parentSessionId }) => parentSessionId),
    );
    if (ids.size !== sessions.length || parents.size !== 1) throw new Error("Descendant census is not one session tree.");
    const rootParent = [...parents][0];
    if (rootParent === null) throw new Error("Descendant census is not one session tree.");
    const byParent = Map.groupBy(sessions, ({ parentSessionId }) => parentSessionId);
    let visited = 0;
    /** @param {number} parent @returns {DescendantNode[]} */
    const nest = (parent) => (byParent.get(parent) ?? []).map((session) => {
        visited++;
        return { session, children: nest(session.id) };
    });
    const tree = nest(rootParent);
    if (visited !== sessions.length) throw new Error("Descendant census is not one session tree.");
    return tree;
}

/** @param {number} seconds */
function duration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return `${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${hours || minutes ? String(seconds % 60).padStart(2, "0") : seconds % 60}s`;
}

/** {§web-session-observer} Elapsed time is a projection of daemon timestamps, not a browser stopwatch.
 * @param {Pick<import("@plurnk/plurnk-acp/client").AcpSessionStatus, "claimedAt" | "terminatedAt">} status @param {number} now
 */
export function elapsed(status, now) {
    if (status.claimedAt === null) return "";
    const seconds = Math.max(0, Math.floor(((status.terminatedAt ?? now) - status.claimedAt) / 1000));
    return duration(seconds);
}

/** {§web-session-status} Time never supplies a lifecycle transition.
 * @param {Pick<import("@plurnk/plurnk-acp/client").AcpSessionStatus, "claimedAt" | "terminatedAt" | "waitUntil">} status @param {number} now
 */
export function clocks(status, now) {
    return {
        elapsed: elapsed(status, now),
        wait: status.waitUntil === null ? "" : duration(Math.max(0, Math.ceil((status.waitUntil - now) / 1000))),
        "wait-at": status.waitUntil === null ? null : new Date(status.waitUntil).toISOString(),
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

/**
 * @param {(Partial<NonNullable<import("@plurnk/plurnk-acp/client").AcpSessionStatus["model"]>> & Pick<NonNullable<import("@plurnk/plurnk-acp/client").AcpSessionStatus["model"]>, "provider" | "model">) | null} statusModel
 * @param {{
 *   providers?: readonly Partial<import("@plurnk/plurnk-acp/client").AcpProviderRoute>[],
 *   configOptions?: readonly { configId?: string, currentValue?: unknown }[],
 * }} [defaults]
 */
function resolveDisplayModel(statusModel, defaults) {
    const thoughtOption = Array.isArray(defaults?.configOptions)
        ? defaults.configOptions.find((entry) => entry?.configId === "thought_level")
        : undefined;
    const configEffort = typeof thoughtOption?.currentValue === "string" && thoughtOption.currentValue.length > 0
        ? thoughtOption.currentValue
        : "";
    if (statusModel !== null) {
        const effort = typeof statusModel.effort === "string" && statusModel.effort.length > 0 ? statusModel.effort : configEffort;
        return {
            display: statusModel.alias || `${statusModel.provider}/${statusModel.model}`,
            route: `${statusModel.provider}/${statusModel.model}`,
            effort,
            effortSource: statusModel.effortSource ?? "",
        };
    }
    const activeProvider = Array.isArray(defaults?.providers)
        ? defaults.providers.find((entry) => entry?.active === true && typeof entry.provider === "string" && typeof entry.model === "string")
        : undefined;
    if (activeProvider && typeof activeProvider.provider === "string" && typeof activeProvider.model === "string") {
        const effort = typeof activeProvider.effort === "string" && activeProvider.effort.length > 0
            ? activeProvider.effort
            : configEffort;
        return {
            display: activeProvider.alias || `${activeProvider.provider}/${activeProvider.model}`,
            route: `${activeProvider.provider}/${activeProvider.model}`,
            effort,
            effortSource: activeProvider.effortSource ?? "default",
        };
    }
    const modelOption = Array.isArray(defaults?.configOptions)
        ? defaults.configOptions.find((entry) => entry?.configId === "model")
        : undefined;
    if (typeof modelOption?.currentValue === "string" && modelOption.currentValue.length > 0 && modelOption.currentValue !== "none") {
        return {
            display: modelOption.currentValue,
            route: modelOption.currentValue,
            effort: configEffort,
            effortSource: configEffort ? "default" : "",
        };
    }
    return null;
}

/** {§web-session-status} Unknown complete values and known subtotals are different facts.
 * @param {{
 *   lifecycle: string,
 *   loopId?: number | null,
 *   packetCount?: number | null,
 *   model: (Partial<NonNullable<import("@plurnk/plurnk-acp/client").AcpSessionStatus["model"]>> & Pick<NonNullable<import("@plurnk/plurnk-acp/client").AcpSessionStatus["model"]>, "provider" | "model">) | null,
 *   descendants: readonly DescendantItem[],
 *   inbox: readonly unknown[],
 *   spend: {
 *     requests?: number,
 *     usage?: { inputTokens?: number | null, outputTokens?: number | null } | null,
 *     knownUsage?: { inputTokens?: number | null, outputTokens?: number | null } | null,
 *     costUsd?: string | null,
 *     knownCostUsd?: string | null,
 *   },
 * }} status
 * @param {Partial<import("@plurnk/plurnk-acp/client").AcpBudgetState>} [budget]
 * @param {{
 *   providers?: readonly Partial<import("@plurnk/plurnk-acp/client").AcpProviderRoute>[],
 *   configOptions?: readonly { configId?: string, currentValue?: unknown }[],
 * }} [defaults]
 */
export function gauges(status, budget, defaults) {
    const { spend } = status;
    const resolvedModel = resolveDisplayModel(status.model, defaults);
    const tree = descendantTree(status.descendants);
    const children = tree.filter(({ session }) => ["queued", "running", "parked"].includes(session.lifecycle)).length;
    const input = amount(spend.usage?.inputTokens, spend.knownUsage?.inputTokens, tokens);
    const output = amount(spend.usage?.outputTokens, spend.knownUsage?.outputTokens, tokens);
    const price = amount(spend.costUsd, spend.knownCostUsd, cost);
    const gated = status.descendants.filter(({ gates }) => gateCount(gates) > 0).length;
    const ctxText = occupancy(budget?.contextTokens, budget?.contextCapacity);
    const highContext = budget?.contextTokens != null && budget?.contextCapacity != null && budget.contextCapacity > 0
        && (budget.contextTokens / budget.contextCapacity) >= 0.75
        ? ctxText
        : "";
    return {
        lifecycle: status.lifecycle,
        input: input.text, output: output.text, cost: price.text === "?" ? "$?" : price.text,
        "usage-label": `Cumulative tokens, session and descendants. Input: ${input.exact}. Output: ${output.exact}.`,
        "cost-label": `Cumulative USD, session and descendants: ${price.exact}.`,
        model: resolvedModel === null ? "No model" : resolvedModel.display,
        effort: resolvedModel?.effort ?? "",
        "model-label": resolvedModel === null
            ? "No model selected"
            : `Model: ${resolvedModel.route}${resolvedModel.effort ? `; effort: ${resolvedModel.effort}${resolvedModel.effortSource ? ` (${resolvedModel.effortSource})` : ""}` : ""}`,
        descendants: String(status.descendants.length),
        "descendants-label": `Descendant sessions: ${status.descendants.length}; active direct children: ${children}`,
        gated: String(gated), "gated-label": `Descendant sessions awaiting input: ${gated}`,
        context: ctxText,
        "context-high": highContext,
        "context-label": `Current packet context: ${budget?.contextTokens ?? "unknown"} / ${budget?.contextCapacity ?? "unknown"} tokens`,
        inbox: String(status.inbox.length), "inbox-label": `Accepted messages not yet observed: ${status.inbox.length}`,
    };
}

/** {§web-session-identity} One directory codec for server and browser navigation.
 * @param {Pick<import("@plurnk/plurnk-acp/client").AcpWorkspaceState, "name" | "projectLabel">} workspace
 * @param {string} session
 */
export function workspaceIdentity({ name, projectLabel }, session) {
    const workspacePath = directoryPath({ kind: "workspace", workspace: name });
    const sessionPath = directoryPath({ kind: "session", workspace: name, session });
    if (workspacePath === null || sessionPath === null) throw new Error("Workspace has no directory address.");
    const namedFolder = projectLabel !== null && projectLabel !== name;
    return {
        workspaceName: name,
        workspacePath,
        sessionPath,
        workspaceSettingsPath: workspaceSettingsPath(name, session) ?? workspacePath,
        modelsSettingsPath: workspaceSettingsPath(name, session, "models") ?? workspacePath,
        projectLabel: namedFolder ? projectLabel : "",
        workspaceIcon: projectLabel !== null ? "🗂️" : "☁️",
        workspaceIconLabel: projectLabel === null ? "Folderless workspace" : "Project workspace",
        pageTitle: `${name}#${session} — Plurnk`,
    };
}
