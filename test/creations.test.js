import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Creations from "../ai.plurnk/creations.js";
import { RequestError } from "../ai.plurnk/http.js";

const envelope = (name) => ({ workspaceId: 41, workspaceName: name, projectRoot: null, projectLabel: null });

test("{§web-workspace-creation} one token settles once and converges racing and retried posts", async () => {
    const creations = new Creations({ ttl: 600, tokens: 128 });
    const token = randomUUID();
    let calls = 0;
    const create = async () => { calls++; return envelope("fresh"); };
    assert.equal(await creations.submit(token, create), "/~/fresh/");
    assert.equal(await creations.submit(token, create), "/~/fresh/");
    assert.equal(calls, 1);
});

test("{§web-workspace-creation} racing posts share one in-flight creation", async () => {
    const creations = new Creations({ ttl: 600, tokens: 128 });
    const token = randomUUID();
    const gate = Promise.withResolvers();
    let calls = 0;
    const create = async () => { calls++; await gate.promise; return envelope("raced"); };
    const posts = [creations.submit(token, create), creations.submit(token, create)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    assert.deepEqual(await Promise.all(posts), ["/~/raced/", "/~/raced/"]);
    assert.equal(calls, 1);
});

test("{§web-workspace-creation} invalid token syntax is rejected without invoking create", async () => {
    const creations = new Creations({ ttl: 600, tokens: 128 });
    let calls = 0;
    const create = async () => { calls++; return envelope("never"); };
    for (const invalid of ["not-a-uuid", "", "12345", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"]) {
        await assert.rejects(creations.submit(invalid, create),
            (error) => error instanceof RequestError && error.status === 400 && error.message.includes("Invalid workspace creation token"));
    }
    assert.equal(calls, 0);
});

test("{§web-workspace-creation} expired tokens are pruned so retries after TTL create fresh workspaces", async () => {
    const creations = new Creations({ ttl: 1, tokens: 128 });
    const token = randomUUID();
    let calls = 0;
    const create = async () => { calls++; return envelope(`run-${calls}`); };
    assert.equal(await creations.submit(token, create), "/~/run-1/");
    assert.equal(calls, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await creations.submit(token, create), "/~/run-2/");
    assert.equal(calls, 2);
});

test("{§web-workspace-creation} a settled failure is retained under its token, and an internal fault is not reworded", async () => {
    for (const failure of [new RequestError(409, "Workspace name 'taken' is already in use."), new Error("internal violation")]) {
        const creations = new Creations({ ttl: 600, tokens: 128 });
        const token = randomUUID();
        let calls = 0;
        const create = async () => { calls++; throw failure; };
        await assert.rejects(creations.submit(token, create), (error) => error === failure);
        await assert.rejects(creations.submit(token, create), (error) => error === failure, "a retry of the settled failure replays it");
        assert.equal(calls, 1);
    }
});

test("{§web-workspace-creation} envelope violations fail visibly instead of adapting the creation", async () => {
    for (const [returned, message] of [
        [{ workspaceId: 1, workspaceName: "foldered", projectRoot: "/srv/project", projectLabel: null },
            /The daemon created a workspace with a project folder from a folderless request\./u],
        [{ workspaceId: 1, workspaceName: "../legacy", projectRoot: null, projectLabel: null },
            /The daemon returned a workspace name without a directory address\./u],
    ]) {
        const creations = new Creations({ ttl: 600, tokens: 128 });
        await assert.rejects(creations.submit(randomUUID(), async () => returned), message);
    }
});

test("{§web-workspace-creation} the bound evicts oldest completed entries when full", async () => {
    const creations = new Creations({ ttl: 600, tokens: 2 });
    const token1 = randomUUID();
    const token2 = randomUUID();
    const token3 = randomUUID();
    assert.equal(await creations.submit(token1, async () => envelope("one")), "/~/one/");
    assert.equal(await creations.submit(token2, async () => envelope("two")), "/~/two/");
    // Submitting a third token evicts the oldest completed entry (token1).
    assert.equal(await creations.submit(token3, async () => envelope("three")), "/~/three/");
    // Token2 and Token3 are still retained.
    assert.equal(await creations.submit(token2, async () => { throw new Error("should converge"); }), "/~/two/");
    assert.equal(await creations.submit(token3, async () => { throw new Error("should converge"); }), "/~/three/");
});