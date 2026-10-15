import assert from "node:assert/strict";
import { test } from "node:test";
import { elapsed, gauges } from "../web/worker-status.js";

test("{§web-worker-observer} elapsed uses daemon bounds, including completion and clock skew", () => {
    assert.equal(elapsed({ claimedAt: null, terminatedAt: null }, 10_000), "Unknown");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 2500), "1s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 500), "0s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: 62_000 }, 900_000), "1m 1s");
    assert.equal(elapsed({ claimedAt: 1000, terminatedAt: null }, 3_662_000), "1h 1m 1s");
});

test("{§web-worker-observer} unknown accounting is not zero or a known subtotal", () => {
    const status = { lifecycle: "idle", loopId: null, packetCount: 0,
        spend: { requests: 0, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: "0" } };
    assert.deepEqual(gauges(status), { lifecycle: "idle", loop: "None", turns: "0", requests: "0", input: "0", output: "0", cost: "0" });
    assert.deepEqual(gauges({ ...status, lifecycle: "failed", loopId: 7, packetCount: 3,
        spend: { requests: 4, usage: null, knownUsage: { inputTokens: 400, outputTokens: 10 }, costUsd: null, knownCostUsd: "0.12" } }),
    { lifecycle: "failed", loop: "7", turns: "3", requests: "4", input: "Unknown", output: "Unknown", cost: "Unknown" });
    assert.deepEqual(gauges({ ...status, spend: { requests: 1, usage: { inputTokens: 12 }, costUsd: "0.0000000123" } }),
        { lifecycle: "idle", loop: "None", turns: "0", requests: "1", input: "12", output: "Unknown", cost: "0.0000000123" });
});
