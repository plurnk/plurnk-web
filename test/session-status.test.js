import assert from "node:assert/strict";
import { test } from "node:test";
import { elapsed, gauges, clocks, workspaceIdentity, descendantTree } from "../web/session-status.js";

const idle = { lifecycle: "idle", model: null, loopId: null, packetCount: 0, waitUntil: null, descendants: [], inbox: [],
    claimedAt: null, terminatedAt: null,
    spend: { requests: 0, usage: { inputTokens: 0, outputTokens: 0 }, knownUsage: { inputTokens: 0, outputTokens: 0 }, costUsd: "0", knownCostUsd: "0" } };

const emptyBudget = { contextTokens: null, contextCapacity: null, curationWeight: null, curationBudget: null };

test("{§web-session-observer} elapsed uses daemon bounds, including completion and clock skew", () => {
    assert.equal(elapsed({ claimedAt: null, terminatedAt: null }, 10_000), "");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 2500), "1s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 500), "0s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: 62_000 }, 900_000), "1m01s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 3_662_000), "1h1m01s");
});

test("{§web-session-observer} unknown accounting is not zero or a known subtotal", () => {
    const zero = gauges(idle, emptyBudget);
    assert.equal(zero.input, "0");
    assert.equal(zero.output, "0");
    assert.equal(zero.cost, "$0.0000");
    const incomplete = gauges({ ...idle, lifecycle: "failed", loopId: 7, packetCount: 3,
        spend: { requests: 4, usage: null, knownUsage: { inputTokens: 400, outputTokens: 10 }, costUsd: null, knownCostUsd: "0.12" } }, emptyBudget);
    assert.equal(incomplete.lifecycle, "failed");
    assert.equal(incomplete.input, "400 + ?");
    assert.equal(incomplete.output, "10 + ?");
    assert.equal(incomplete.cost, "$0.1200 + ?");
    assert.equal(incomplete.usageLabel, "Cumulative tokens, session and descendants. Input: unknown total; known subtotal 400. Output: unknown total; known subtotal 10.");
    assert.equal(incomplete.costLabel, "Cumulative USD, session and descendants: unknown total; known subtotal 0.12.");
    const partial = gauges({ ...idle, spend: { requests: 1, usage: { inputTokens: 12 }, knownUsage: { inputTokens: 12 },
        costUsd: "0.0000000123", knownCostUsd: "0.0000000123" } }, emptyBudget);
    assert.equal(partial.input, "12");
    assert.equal(partial.output, "?");
    assert.equal(partial.cost, "<$0.0001", "nonzero expense never rounds to free");
    assert.equal(partial.costLabel, "Cumulative USD, session and descendants: 0.0000000123.");
    const unknown = gauges({ ...idle, spend: { requests: 1, usage: null, knownUsage: null, costUsd: null, knownCostUsd: null } });
    assert.equal(unknown.input, "?");
    assert.equal(unknown.output, "?");
    assert.equal(unknown.cost, "$?");
});

test("{§web-session-status} model identity, effort, direct children and budgets remain daemon facts", () => {
    const unselected = gauges(idle, emptyBudget);
    assert.equal(unselected.model, "No model");
    assert.equal(unselected.effort, "");
    assert.equal(unselected.context, "");
    assert.equal(Object.hasOwn(unselected, "curation"), false);
    const selected = gauges({ ...idle, model: { alias: "local", provider: "host", model: "qwen", effort: "high", effortSource: "explicit" },
        descendants: [
            { id: 2, name: "first", parentSessionId: 1, kind: /** @type {const} */ ("work"), lifecycle: /** @type {const} */ ("queued"), gates: 0 },
            { id: 3, name: "nested", parentSessionId: 2, kind: /** @type {const} */ ("work"), lifecycle: /** @type {const} */ ("running"), gates: 2 },
            { id: 4, name: "second", parentSessionId: 1, kind: /** @type {const} */ ("fork"), lifecycle: /** @type {const} */ ("parked"), gates: 0 },
            { id: 5, name: "finished", parentSessionId: 1, kind: /** @type {const} */ ("bare"), lifecycle: /** @type {const} */ ("completed"), gates: 0 },
        ], inbox: [{ path: "message://user/one", id: "one", loopId: 2, lifecycle: "queued" }] },
    { contextTokens: 0, contextCapacity: 32768, curationWeight: 4200, curationBudget: 8000 });
    assert.equal(selected.model, "local");
    assert.equal(selected.effort, "high");
    assert.equal(selected.modelLabel, "Model: host/qwen; effort: high (explicit)");
    assert.equal(selected.descendantsLabel, "Descendant sessions: 4; active direct children: 2");
    assert.equal(selected.gated, "1", "count sessions awaiting input, not gates");
    assert.equal(selected.descendants, "4", "the census includes completed descendants");
    assert.equal(selected.context, "0%/32.8k");
    assert.equal(selected.contextLabel, "Current packet context: 0 / 32768 tokens");
    assert.equal(Object.hasOwn(selected, "curation"), false, "curation stays in SDK state, not the status projection");
    assert.equal(Object.hasOwn(selected, "curationLabel"), false);
    assert.equal(selected.inbox, "1");
    assert.equal(gauges({ ...idle, model: { provider: "host", model: "other" } }).model, "host/other");
    assert.equal(gauges(idle).context, "", "absence is not an inherited previous budget");
    assert.equal(gauges(idle, { contextTokens: 14080, contextCapacity: 128000 }).context, "11%/128k");
    for (const budget of [{ contextTokens: 1, contextCapacity: 0 }, { contextTokens: null, contextCapacity: 10 }, { contextTokens: 2 }]) {
        assert.equal(gauges(idle, budget).context, "", "incomplete or zero-capacity gauges cannot invent a percentage");
    }
});

test("{§web-session-descendants} nesting preserves supplied parentage and sibling order", () => {
    const session = (id, parentSessionId) => ({ id, parentSessionId, name: `session-${id}`, kind: /** @type {const} */ ("work"), lifecycle: /** @type {const} */ ("idle"), gates: 0 });
    const rows = [session(2, 1), session(4, 2), session(7, 4), session(5, 2), session(3, 1)];
    const tree = descendantTree(rows);
    const identities = (nodes) => nodes.map(({ session, children }) => [session.id, identities(children)]);
    assert.deepEqual(identities(tree), [[2, [[4, [[7, []]]], [5, []]]], [3, []]]);
    assert.equal(tree[0].session, rows[0], "render the supplied facts without a second state representation");
    assert.deepEqual(descendantTree([]), []);
    for (const invalid of [
        [session(2, 1), session(2, 1)],
        [session(2, 1), session(3, 8)],
        [session(2, 3), session(3, 2)],
        [session(2, 1), session(3, 4), session(4, 3)],
    ]) assert.throws(() => descendantTree(invalid), /Descendant census is not one session tree\./u);
});

test("{§web-session-status} compact accounting preserves exact accessible values without a second ledger", () => {
    const status = { ...idle, spend: { requests: 2, costUsd: "0.0326789", knownCostUsd: "0.0326789",
        usage: { inputTokens: 166123, outputTokens: 7123, inputTokenDetails: { cacheReadTokens: 100000 } },
        knownUsage: { inputTokens: 166123, outputTokens: 7123 } } };
    const before = structuredClone(status);
    const result = gauges(status);
    assert.equal(result.input, "166.1k");
    assert.equal(result.output, "7.1k");
    assert.equal(result.cost, "$0.0327");
    assert.equal(result.usageLabel, "Cumulative tokens, session and descendants. Input: 166123. Output: 7123.");
    assert.equal(result.costLabel, "Cumulative USD, session and descendants: 0.0326789.");
    assert.deepEqual(status, before, "formatting never rewrites SDK accounting");
    assert.equal(Object.hasOwn(result, "requests"), false, "unpresented data stays out of the projection");
    assert.equal(Object.keys(result).some((key) => key.startsWith("usage-") || key.startsWith("known-")), false);
    assert.equal(gauges({ ...idle, spend: { ...idle.spend, costUsd: null, knownCostUsd: "0" } }).cost, "$0.0000 + ?");
});

test("{§web-session-status} WAIT uses the daemon deadline without changing lifecycle at expiry", () => {
    assert.deepEqual(clocks(idle, 1000), { elapsed: "", wait: "", waitAt: null });
    const waiting = { ...idle, lifecycle: "parked", claimedAt: 1000, waitUntil: 62_001 };
    assert.deepEqual(clocks(waiting, 1001), { elapsed: "0s", wait: "1m01s", waitAt: "1970-01-01T00:01:02.001Z" });
    assert.equal(clocks(waiting, 62_000).wait, "1s");
    assert.equal(clocks(waiting, 62_001).wait, "0s");
    assert.equal(clocks(waiting, 90_000).wait, "0s");
    assert.equal(waiting.lifecycle, "parked");
    assert.equal(clocks({ ...waiting, waitUntil: null }, 90_000).wait, "", "a daemon update clears the previous bound");
});

test("{§web-session-identity} folder labels are compared, not derived, and names use the shared URL codec", () => {
    assert.deepEqual(workspaceIdentity({ name: "~/project", projectLabel: "~/project" }, "user"), {
        workspaceName: "~/project", workspacePath: "/~/~/project/", sessionPath: "/~/~/project@user/", projectLabel: "",
        workspaceIcon: "🗂️", workspaceIconLabel: "Project workspace", pageTitle: "~/project@user — Plurnk",
    });
    const named = workspaceIdentity({ name: 'review <&@%>', projectLabel: "~/project" }, "user");
    assert.equal(named.workspaceIcon, "☁️");
    assert.equal(named.workspaceIconLabel, "Workspace");
    assert.equal(named.projectLabel, "~/project");
    assert.equal(named.workspacePath, "/~/review%20%3C%26%40%25%3E/");
    assert.equal(named.sessionPath, "/~/review%20%3C%26%40%25%3E@user/");
    const folderless = workspaceIdentity({ name: "scratch", projectLabel: null }, "user");
    assert.equal(folderless.workspaceIconLabel, "Folderless workspace");
    assert.equal(folderless.projectLabel, "");
    assert.throws(() => workspaceIdentity({ name: "../bad", projectLabel: null }, "user"), /Workspace has no directory address/u);
});
