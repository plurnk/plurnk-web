import assert from "node:assert/strict";
import { test } from "node:test";
import { elapsed, gauges, clocks, workspaceIdentity, descendantTree } from "../web/worker-status.js";

const idle = { lifecycle: "idle", model: null, loopId: null, packetCount: 0, waitUntil: null, descendants: [], inbox: [],
    claimedAt: null, terminatedAt: null,
    spend: { requests: 0, usage: { inputTokens: 0, outputTokens: 0 }, knownUsage: { inputTokens: 0, outputTokens: 0 }, costUsd: "0", knownCostUsd: "0" } };

const emptyBudget = { contextTokens: null, contextCapacity: null, curationWeight: null, curationBudget: null };

test("{§web-worker-observer} elapsed uses daemon bounds, including completion and clock skew", () => {
    assert.equal(elapsed({ claimedAt: null, terminatedAt: null }, 10_000), "Unknown");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 2500), "1s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 500), "0s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: 62_000 }, 900_000), "1m 1s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 3_662_000), "1h 1m 1s");
});

test("{§web-worker-observer} unknown accounting is not zero or a known subtotal", () => {
    const zero = gauges(idle, emptyBudget);
    assert.equal(zero.requests, "0");
    assert.equal(zero.input, "0");
    assert.equal(zero.output, "0");
    assert.equal(zero.cost, "0");
    const incomplete = gauges({ ...idle, lifecycle: "failed", loopId: 7, packetCount: 3,
        spend: { requests: 4, usage: null, knownUsage: { inputTokens: 400, outputTokens: 10 }, costUsd: null, knownCostUsd: "0.12" } }, emptyBudget);
    assert.equal(incomplete.lifecycle, "failed");
    assert.equal(incomplete.loop, "7");
    assert.equal(incomplete.turns, "3");
    assert.equal(incomplete.requests, "4");
    assert.equal(incomplete.input, "Unknown");
    assert.equal(incomplete.output, "Unknown");
    assert.equal(incomplete.cost, "Unknown");
    assert.equal(incomplete["known-input"], "400");
    assert.equal(incomplete["known-output"], "10");
    assert.equal(incomplete["known-cost"], "0.12");
    const partial = gauges({ ...idle, spend: { requests: 1, usage: { inputTokens: 12 }, knownUsage: { inputTokens: 12 },
        costUsd: "0.0000000123", knownCostUsd: "0.0000000123" } }, emptyBudget);
    assert.equal(partial.input, "12");
    assert.equal(partial.output, "Unknown");
    assert.equal(partial.cost, "0.0000000123");
    assert.equal(partial["known-input"], "—", "a complete field needs no duplicate subtotal");
    assert.equal(partial["known-output"], "Unknown", "missing evidence is not zero");
    assert.equal(partial["known-cost"], "—");
});

test("{§web-worker-status} model identity, effort, direct children and budgets remain daemon facts", () => {
    const unselected = gauges(idle, emptyBudget);
    assert.equal(unselected.model, "Not selected");
    assert.equal(unselected.effort, "Unspecified");
    assert.equal(unselected.children, "0");
    assert.equal(unselected.context, "Unknown / Unknown");
    assert.equal(unselected.curation, "Unknown / Unknown");
    const selected = gauges({ ...idle, model: { alias: "local", provider: "host", model: "qwen", effort: "high", effortSource: "explicit" },
        descendants: [
            { id: 2, name: "first", parentWorkerId: 1, kind: "work", lifecycle: "queued", gates: 0 },
            { id: 3, name: "nested", parentWorkerId: 2, kind: "work", lifecycle: "running", gates: 2 },
            { id: 4, name: "second", parentWorkerId: 1, kind: "fork", lifecycle: "parked", gates: 0 },
            { id: 5, name: "finished", parentWorkerId: 1, kind: "bare", lifecycle: "completed", gates: 0 },
        ], inbox: [{ path: "message://user/one", id: "one", loopId: 2, lifecycle: "queued" }] },
    { contextTokens: 0, contextCapacity: 32768, curationWeight: 4200, curationBudget: 8000 });
    assert.equal(selected.model, "local — host/qwen");
    assert.equal(selected.effort, "high (explicit)");
    assert.equal(selected.children, "2");
    assert.equal(selected.gated, "1", "count workers awaiting input, not gates");
    assert.equal(selected.descendants, "4", "the census includes completed descendants");
    assert.equal(selected.context, "0 / 32768");
    assert.equal(selected.curation, "4200 / 8000");
    assert.equal(selected.inbox, "1");
    assert.equal(gauges({ ...idle, model: { provider: "host", model: "other" } }).model, "host/other");
    assert.equal(gauges(idle).context, "Unknown / Unknown", "absence is not an inherited previous budget");
});

test("{§web-worker-descendants} nesting preserves supplied parentage and sibling order", () => {
    const worker = (id, parentWorkerId) => ({ id, parentWorkerId, name: `worker-${id}`, kind: "work", lifecycle: "idle", gates: 0 });
    const rows = [worker(2, 1), worker(4, 2), worker(7, 4), worker(5, 2), worker(3, 1)];
    const tree = descendantTree(rows);
    const identities = (nodes) => nodes.map(({ worker, children }) => [worker.id, identities(children)]);
    assert.deepEqual(identities(tree), [[2, [[4, [[7, []]]], [5, []]]], [3, []]]);
    assert.equal(tree[0].worker, rows[0], "render the supplied facts without a second state representation");
    assert.deepEqual(descendantTree([]), []);
    for (const invalid of [
        [worker(2, 1), worker(2, 1)],
        [worker(2, 1), worker(3, 8)],
        [worker(2, 3), worker(3, 2)],
        [worker(2, 1), worker(3, 4), worker(4, 3)],
    ]) assert.throws(() => descendantTree(invalid), /Descendant census is not one worker tree\./u);
});

test("{§web-worker-status} accounting details preserve exact reported fields without reconstructing totals", () => {
    const result = gauges({ ...idle, spend: { requests: 2, costUsd: null, knownCostUsd: "0",
        usage: { inputTokens: 19, inputTokenDetails: { cacheReadTokens: 0 } },
        knownUsage: { inputTokens: 19, outputTokens: 30, inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 5 },
            outputTokenDetails: { textTokens: 6, reasoningTokens: 7 } } } });
    assert.equal(result["usage-total"], "Unknown", "input plus output is not a replacement for absent total evidence");
    assert.equal(result["usage-cache-read"], "0");
    assert.equal(result["known-cache-read"], "—");
    assert.equal(result["known-uncached"], "4");
    assert.equal(result["known-cache-write"], "5");
    assert.equal(result["usage-reasoning"], "Unknown");
    assert.equal(result["known-reasoning"], "7");
    assert.equal(result["known-text"], "6");
    assert.equal(result.cost, "Unknown");
    assert.equal(result["known-cost"], "0", "known exact zero is evidence, not a missing subtotal");
});

test("{§web-worker-status} WAIT uses the daemon deadline without changing lifecycle at expiry", () => {
    assert.deepEqual(clocks(idle, 1000), { elapsed: "Unknown", wait: "None", waitAt: null });
    const waiting = { ...idle, lifecycle: "parked", claimedAt: 1000, waitUntil: 62_001 };
    assert.deepEqual(clocks(waiting, 1001), { elapsed: "0s", wait: "1m 1s", waitAt: "1970-01-01T00:01:02.001Z" });
    assert.equal(clocks(waiting, 62_000).wait, "1s");
    assert.equal(clocks(waiting, 62_001).wait, "0s");
    assert.equal(clocks(waiting, 90_000).wait, "0s");
    assert.equal(waiting.lifecycle, "parked");
    assert.equal(clocks({ ...waiting, waitUntil: null }, 90_000).wait, "None", "a daemon update clears the previous bound");
});

test("{§web-worker-identity} folder labels are compared, not derived, and names use the shared URL codec", () => {
    assert.deepEqual(workspaceIdentity({ name: "~/project", projectLabel: "~/project" }, "user"), {
        workspaceName: "~/project", workspacePath: "/~/~/project/", workerPath: "/~/~/project@user/", projectLabel: "",
        workspaceIcon: "📁", workspaceIconLabel: "Project workspace", pageTitle: "~/project@user — Plurnk",
    });
    const named = workspaceIdentity({ name: 'review <&@%>', projectLabel: "~/project" }, "user");
    assert.equal(named.workspaceIcon, "☁️");
    assert.equal(named.workspaceIconLabel, "Workspace");
    assert.equal(named.projectLabel, "~/project");
    assert.equal(named.workspacePath, "/~/review%20%3C%26%40%25%3E/");
    assert.equal(named.workerPath, "/~/review%20%3C%26%40%25%3E@user/");
    const folderless = workspaceIdentity({ name: "scratch", projectLabel: null }, "user");
    assert.equal(folderless.workspaceIconLabel, "Folderless workspace");
    assert.equal(folderless.projectLabel, "");
    assert.throws(() => workspaceIdentity({ name: "../bad", projectLabel: null }, "user"), /Workspace has no directory address/u);
});
