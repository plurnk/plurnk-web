import assert from "node:assert/strict";
import test from "node:test";
import Documents from "../ai.plurnk/documents.js";

test("{§web-directory-documents} read-only lookup escapes names and never invents identities", async () => {
    const calls = [];
    const port = {
        listWorkspaces: async () => {
            calls.push("workspaces");
            return [{ id: 7, name: '~/a&<script>@"b', project_root: null }, { id: 8, name: "../legacy", project_root: null }];
        },
        listWorkers: async (id) => { calls.push(id); return [{ name: "user" }]; },
    };
    const document = new Documents('<!doctype html><title>Plurnk</title><main>Home</main><script src="/app.js"></script>');
    const index = (await document.read({ kind: "daemon" }, port, true)).toString();
    assert.match(index, /<ul><li><a href="\/~\/~\/a%26%3Cscript%3E%40%22b\/"/u);
    assert.match(index, /~\/a&amp;&lt;script&gt;@&quot;b/u);
    assert.match(index, /<li><span data-text="name">\.\.\/legacy<\/span><\/li>/u);
    assert.match(index, /<form method="post" action="\/auth\/logout">/u);
    assert.match(index, /<script src="\/app.js"><\/script>/u);
    assert.equal(await document.read({ kind: "workspace", workspace: "missing" }, port, false), null);
    assert.deepEqual(calls, ["workspaces", "workspaces"]);
    const workspace = { kind: "workspace", workspace: '~/a&<script>@"b' };
    const workers = (await document.read(workspace, port, false)).toString();
    assert.match(workers, /a%26%3Cscript%3E%40%22b@user\//u);
    assert.doesNotMatch(workers, /<form/u);
    assert.equal(await document.read({ ...workspace, kind: "worker", worker: "absent" }, port, true), null);
    const worker = (await document.read({ ...workspace, kind: "worker", worker: "user" }, port, true)).toString();
    assert.match(worker, /<h1[^>]*>~\/a&amp;&lt;script&gt;@&quot;b@user<\/h1>/u);
    assert.deepEqual(calls, ["workspaces", "workspaces", "workspaces", 7, "workspaces", 7, "workspaces", 7]);
});

test("{§web-directory-documents} a broken document outlet fails at load", () => {
    for (const html of ["", "<main>unclosed", "<main>a</main><main>b</main>"]) {
        assert.throws(() => new Documents(html), /exactly one main element/u);
    }
});
