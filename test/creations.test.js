import assert from "node:assert/strict";
import { test } from "node:test";
import Creations from "../ai.plurnk/creations.js";
import { RequestError } from "../ai.plurnk/http.js";

const envelope = (name) => ({ workspaceId: 41, workspaceName: name, projectRoot: null, projectLabel: null });

test("{§web-workspace-creation} one token settles once and converges racing and retried posts", async () => {
    const creations = new Creations({ ttl: 600, tokens: 128 });
    const token = creations.mint();
    let calls = 0;
    const create = async () => { calls++; return envelope("fresh"); };
    assert.equal(await creations.submit(token, create), "/~/fresh/");
    assert.equal(await creations.submit(token, create), "/~/fresh/");
    assert.equal(calls, 1);
});

test("{§web-workspace-creation} racing posts share one in-flight creation", async () => {
    const creations = new Creations({ ttl: 600, tokens: 128 });
    const token = creations.mint();
    const gate = Promise.withResolvers();
    let calls = 0;
    const create = async () => { calls++; await gate.promise; return envelope("raced"); };
    const posts = [creations.submit(token, create), creations.submit(token, create)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    assert.deepEqual(await Promise.all(posts), ["/~/raced/", "/~/raced/"]);
    assert.equal(calls, 1);
});

test("{§web-workspace-creation} unknown and expired tokens are stale forms, never second creations", async () => {
    const creations = new Creations({ ttl: 600, tokens: 128 });
    let calls = 0;
    const create = async () => { calls++; return envelope("never"); };
    await assert.rejects(creations.submit("not-minted", create),
        (error) => error instanceof RequestError && error.status === 400);
    const brief = new Creations({ ttl: 1, tokens: 128 });
    const token = brief.mint();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await assert.rejects(brief.submit(token, create), { status: 400 });
    assert.equal(calls, 0);
});

test("{§web-workspace-creation} a daemon failure is retained and surfaced with its cause", async () => {
    const creations = new Creations({ ttl: 600, tokens: 128 });
    const token = creations.mint();
    let calls = 0;
    const create = async () => { calls++; throw new Error("daemon refused"); };
    await assert.rejects(creations.submit(token, create),
        (error) => error instanceof RequestError && error.status === 502 && error.cause.message === "daemon refused");
    await assert.rejects(creations.submit(token, create), { status: 502 });
    assert.equal(calls, 1);
});

test("{§web-workspace-creation} envelope violations fail visibly instead of adapting the creation", async () => {
    for (const [returned, message] of [
        [{ workspaceId: 1, workspaceName: "foldered", projectRoot: "/srv/project", projectLabel: null },
            /The daemon created a workspace with a project folder from a folderless request\./u],
        [{ workspaceId: 1, workspaceName: "../legacy", projectRoot: null, projectLabel: null },
            /The daemon returned a workspace name without a directory address\./u],
    ]) {
        const creations = new Creations({ ttl: 600, tokens: 128 });
        await assert.rejects(creations.submit(creations.mint(), async () => returned), message);
    }
});

test("{§web-workspace-creation} the bound yields unsubmitted, then settled, tokens before minting", async () => {
    const creations = new Creations({ ttl: 600, tokens: 2 });
    const first = creations.mint();
    const second = creations.mint();
    assert.equal(await creations.submit(first, async () => envelope("one")), "/~/one/");
    const third = creations.mint(); // Yields the unsubmitted second token.
    await assert.rejects(creations.submit(second, async () => envelope("never")), { status: 400 });
    assert.equal(await creations.submit(third, async () => envelope("two")), "/~/two/");
    creations.mint(); // Yields the oldest settled outcome: first.
    await assert.rejects(creations.submit(first, async () => envelope("never")), { status: 400 });
    const gate = Promise.withResolvers();
    const flights = new Creations({ ttl: 600, tokens: 1 });
    const pending = flights.submit(flights.mint(), async () => { await gate.promise; return envelope("in-flight"); });
    const extra = flights.mint(); // An all-in-flight registry mints rather than failing a page render.
    assert.match(extra, /^[0-9a-f-]{36}$/u);
    gate.resolve();
    assert.equal(await pending, "/~/in-flight/");
});