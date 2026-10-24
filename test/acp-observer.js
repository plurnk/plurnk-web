import assert from "node:assert/strict";
import verifyConversation from "./acp-conversation.js";
import { httpFailure } from "./browser-diagnostics.js";

// {§web-acp-conformance} Exercise the public observer contract through the official browser SDK.
export default async function verifyObserver({ tab, t, start, finish, read, event, successful, prompt, model, checkBrowser, action, detach, observe, inspect }) {

    await action("observer-workspace", "named-worker", "worker.model.set", { selector: "browser" });
    // A real client operation creates the runtime journal; workspace attachment no longer fabricates actors.
    const seeded = await action("observer-workspace", "named-worker", "op.parse", { text: "```READ (witness.txt)\n```" });
    assert.deepEqual(seeded.results.map(({ status }) => status), [200]);
    assert.match(seeded.results[0].content, /cobalt heron/u);

    await t.test("{§web-acp-conformance} explicit observation refuses absent and internal targets without mutation", async () => {
        const beforeCalls = model.requests.length;
        const before = await action("observer-workspace", "named-worker", "workspace.workers");
        const workspaces = await action(undefined, "observer-census", "workspace.list");
        const internal = before.workers.find(({ origin }) => origin === "_plurnk");
        assert.ok(internal);
        for (const [workspace, worker, code] of [
            ["missing-observer-workspace", "named-worker", "workspace-not-found"],
            ["observer-workspace", "absent-worker", "worker-not-found"],
            ["observer-workspace", internal.name, "worker-not-found"],
        ]) {
            const id = `missing-${workspace}-${worker}`;
            await start(id, { workspace, threadId: worker, observe: true });
            const result = await finish(id);
            assert.equal(result.failure?.status, 404);
            const problem = typeof result.failure.payload === "string" ? JSON.parse(result.failure.payload) : result.failure.payload;
            assert.ok(problem.type.endsWith(`/${code}`), JSON.stringify(problem));
            assert.equal(problem.detail, code === "workspace-not-found"
                ? `No workspace named "${workspace}" exists.`
                : `No model worker named "${worker}" exists in workspace "${workspace}".`);
            assert.deepEqual(result.events, []);
            checkBrowser([
                httpFailure("/acp/connect", 404),
            ]);
        }
        // More than a browser's per-origin HTTP/1 connection limit: detachment must release transport too.
        for (let visit = 0; visit < 8; visit++) {
            const id = `existing-explicit-${visit}`;
            const result = await observe(id, "observer-workspace", "named-worker");
            assert.deepEqual(result.messages, [], "administrative receipts do not enter the model's history");
            await detach(id);
        }
        assert.deepEqual(await action("observer-workspace", "named-worker", "workspace.workers"), before);
        assert.deepEqual(await action(undefined, "observer-census", "workspace.list"), workspaces);
        assert.equal(model.requests.length, beforeCalls);
    });

    await t.test("{§web-acp-conformance} exact binding survives name equality and rejects a renamed-away workspace", async () => {
        await start("rename-seed", { workspace: "before-observer-rename", threadId: "exact-worker", messages: prompt("binding") });
        const seeded = await finish("rename-seed");
        successful(seeded);
        const before = await action("before-observer-rename", "exact-worker", "workspace.workers");
        const beforeCalls = model.requests.length;
        await observe("cached-before-rename", "before-observer-rename", "exact-worker");
        await detach("cached-before-rename");
        await action("before-observer-rename", "exact-worker", "workspace.rename", { name: "exact-worker" });
        for (const id of ["equal-name-first", "equal-name-again"]) {
            const result = await observe(id, "exact-worker", "exact-worker");
            assert.equal(result.messages.findLast(({ role }) => role === "assistant")?.content, "Completed binding.");
            assert.equal(result.state.plurnk.status.loopId, seeded.state.plurnk.status.loopId);
            assert.equal(result.state.plurnk.workspace.name, "exact-worker");
            await detach(id);
        }
        await tab.evaluate(() => globalThis.lifecycle.reconnect("cached-before-rename"));
        await tab.waitForFunction(() => {
            const result = globalThis.lifecycle.read("cached-before-rename");
            return result.settled || result.events.some(({ type }) => type === "MESSAGES_SNAPSHOT");
        }, undefined, { timeout: 10_000 });
        const stale = await read("cached-before-rename");
        if (!stale.settled) await detach("cached-before-rename");
        assert.equal(model.requests.length, beforeCalls);
        assert.equal(stale.failure?.status, 404,
            `a cached envelope cannot resurrect a renamed-away workspace: ${JSON.stringify(stale.state.plurnk?.workspace)}`);
        const problem = typeof stale.failure.payload === "string" ? JSON.parse(stale.failure.payload) : stale.failure.payload;
        assert.ok(problem.type.endsWith("/workspace-not-found"), JSON.stringify(problem));
        assert.deepEqual(stale.events, []);
        checkBrowser([
            httpFailure("/acp/connect", 404),
        ]);
        assert.deepEqual(await action("exact-worker", "exact-worker", "workspace.workers"), before,
            "renaming or observing must not fabricate workers");
    });

    await verifyConversation({ tab, t, start, finish, read, event, successful, prompt, model, action, observe, detach, inspect });

    await t.test("{§web-acp-conformance} live and fresh observers agree on spend and timing across consecutive loops", async (probe) => {
        const mismatches = [];
        const compare = (actual, expected, label) => {
            try { assert.deepEqual(actual, expected); }
            catch (error) {
                if (!(error instanceof assert.AssertionError)) throw error;
                mismatches.push({ label, actual, expected });
            }
        };
        const gauge = ({ lifecycle, loopId, packetCount, claimedAt, terminatedAt, spend }) =>
            ({ lifecycle, loopId, packetCount, claimedAt, terminatedAt, spend });
        const workspace = "observer-workspace";
        const worker = "named-worker";
        const zero = await observe("continuity", workspace, worker);
        assert.equal(zero.state.plurnk.status.loopId, null);
        assert.equal(zero.state.plurnk.status.claimedAt, null);
        assert.equal(zero.state.plurnk.status.terminatedAt, null);
        assert.equal(zero.state.plurnk.status.spend.requests, 0);
        assert.equal(zero.state.plurnk.status.spend.usage.inputTokens, 0);
        assert.equal(zero.state.plurnk.status.spend.costUsd, "0");
        let priorLoop;
        for (let turn = 1; turn <= 2; turn++) {
            if (turn > 1) {
                await tab.evaluate(() => globalThis.lifecycle.reconnect("continuity"));
                await event("continuity", "MESSAGES_SNAPSHOT");
            }
            await start(`continuity-controller-${turn}`, {
                workspace, threadId: worker,
                messages: [{ ...prompt("held-continuity")[0], id: `continuity-prompt-${turn}` }],
            });
            await event(`continuity-controller-${turn}`, "REASONING_MESSAGE_CONTENT");
            await event("continuity", "REASONING_MESSAGE_CONTENT");
            const late = await observe(`late-${turn}`, workspace, worker);
            await tab.waitForFunction(() => {
                const status = globalThis.lifecycle.read("continuity").state.plurnk.status;
                return status.lifecycle === "running" && status.claimedAt !== null;
            }, undefined, { timeout: 10_000 });
            const active = await read("continuity");
            assert.equal(late.state.plurnk.status.lifecycle, "running");
            compare(gauge(active.state.plurnk.status), gauge(late.state.plurnk.status), `loop ${turn}: live and late while running`);
            compare(active.state.budget, late.state.budget, `loop ${turn}: live and late packet gauges`);
            probe.diagnostic(JSON.stringify({ phase: "running", turn, live: gauge(active.state.plurnk.status), fresh: gauge(late.state.plurnk.status) }));
            assert.notEqual(late.state.plurnk.status.loopId, priorLoop);
            assert.ok(Number.isSafeInteger(late.state.plurnk.status.claimedAt));
            assert.equal(late.state.plurnk.status.terminatedAt, null);
            assert.equal(late.state.plurnk.status.spend.requests, turn - 1);
            await detach(`late-${turn}`);
            assert.equal((await read(`continuity-controller-${turn}`)).settled, false);
            model.release("held-continuity");
            const [controller, observed] = await Promise.all([finish(`continuity-controller-${turn}`), finish("continuity")]);
            successful(controller);
            successful(observed);
            const fresh = await observe(`fresh-${turn}`, workspace, worker);
            const status = observed.state.plurnk.status;
            assert.equal(status.lifecycle, "completed");
            compare(gauge(status), gauge(fresh.state.plurnk.status), `loop ${turn}: live and fresh after completion`);
            compare(observed.state.budget, fresh.state.budget, `loop ${turn}: live and fresh packet gauges`);
            assert.equal(fresh.state.budget.contextTokens, 400);
            assert.ok(fresh.state.budget.curationWeight > 0);
            probe.diagnostic(JSON.stringify({ phase: "completed", turn, live: gauge(status), fresh: gauge(fresh.state.plurnk.status),
                budget: { live: observed.state.budget, fresh: fresh.state.budget } }));
            assert.ok(fresh.state.plurnk.status.terminatedAt >= fresh.state.plurnk.status.claimedAt);
            assert.equal(fresh.state.plurnk.status.spend.requests, turn);
            assert.equal(fresh.state.plurnk.status.spend.usage.inputTokens, 400 * turn);
            assert.equal(fresh.state.plurnk.status.spend.costUsd, null, "unknown fixture pricing is not free");
            assert.equal(fresh.events.some(({ type }) => type === "RUN_FINISHED" || type === "RUN_ERROR"), false, "a snapshot is not a new completion");
            await detach(`fresh-${turn}`);
            priorLoop = status.loopId;
        }
        assert.deepEqual(mismatches, [], "live and fresh observations must converge without a client accounting ledger");
    });
}
