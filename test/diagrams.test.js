import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Piscina } from "piscina";
import createModule from "../ai.plurnk/module.js";

async function fixture(t, overrides = {}, unsubscribe = () => {}, port = {}) {
    const env = { PLURNK_AUTH: "0", ...overrides };
    const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const module = createModule();
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    const claims = { kind: "session", clientId: "plurnk-web", scopes: ["agui"] };
    const credentials = { registerClient: () => ({ clientId: "plurnk-web", clientSecret: "test-only" }),
        face: () => ({ issuer: () => "http://test.invalid" }), onRevoked: () => unsubscribe,
        verify: (token) => token === "valid" ? claims : null };
    let handler;
    await module.setup({ credentials });
    await module.start({ credentials, ...port, registerHttpRoute(_prefix, serve) { handler = serve; } });
    const errors = [];
    const server = createServer((req, res) => {
        void handler(req, res).catch((error) => { errors.push(error); res.writeHead(500); res.end(); });
    });
    t.after(async () => {
        await module.close();
        await new Promise((resolve) => server.close(resolve));
        assert.deepEqual(errors, [], "unexpected handler failures");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (source, init = {}) => fetch(`${base}/render/mermaid`, {
        method: "POST", body: JSON.stringify({ source }), ...init,
        headers: { "content-type": "application/json", ...init.headers },
    });
    return { base, module, post, errors };
}

const simple = "flowchart LR\n A[Client] --> B[Daemon]";
const dense = "flowchart LR\n" + Array.from({ length: 60 }, (_, a) =>
    Array.from({ length: a }, (_, b) => ` N${a} --> N${b}`).join("\n")).join("\n");

async function problem(response, status, message) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.status, status);
    assert.match(body.detail, message);
    return response;
}

test("{§web-diagram-service} the module compiles JSON source to a private standalone image", async (t) => {
    const { post } = await fixture(t);
    const image = await post(simple);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/svg+xml");
    assert.equal(image.headers.get("cache-control"), "no-store");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(image.headers.get("content-security-policy"), /^sandbox; default-src 'none';/u);
    const svg = await image.text();
    assert.match(svg, /^<svg\b/u);
    assert.match(svg, /Client/u);
    assert.match(svg, /Daemon/u);
    assert.equal(Buffer.byteLength(svg), Number(image.headers.get("content-length")));
});

test("{§web-diagram-service} HTTP admission rejects forms, cross-origin requests and malformed input", async (t) => {
    const { base, post } = await fixture(t);
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]) {
        const response = await fetch(`${base}/render/mermaid`, { method });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("allow"), "POST");
        assert.equal(response.headers.get("access-control-allow-origin"), null);
        if (method === "HEAD") assert.equal(await response.text(), "");
        else await problem(response, 405, /Use POST/u);
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/json; charset=latin1"]) {
        await problem(await post(simple, { headers: { "content-type": type } }), 415, /UTF-8 application\/json/u);
    }
    for (const site of ["cross-site", "same-site", "none"]) {
        await problem(await post(simple, { headers: { "sec-fetch-site": site } }), 403, /Same-origin/u);
    }
    for (const body of ["{", Buffer.from([0xff])]) await problem(await post(simple, { body }), 400, /Invalid diagram JSON/u);
    for (const body of ["null", "[]", '"a"', "{}", '{"source":2}', '{"source":"a","other":1}']) {
        await problem(await post(simple, { body }), 400, /Expected a source string/u);
    }
    await problem(await post("x".repeat(Number(process.env.PLURNK_WEB_DIAGRAM_INPUT_BYTES))), 413, /source exceeds/u);
    const valid = await post(simple, { headers: { "content-type": 'Application/JSON; charset="UTF-8"', "sec-fetch-site": "same-origin" } });
    assert.equal(valid.status, 200);
    await valid.text();
});

test("{§web-diagram-service} existing session authority admits compilation and invalid sessions cannot render", async (t) => {
    const { post } = await fixture(t, { PLURNK_AUTH: "1" });
    for (const cookie of ["", "plurnk_web_session=invalid", "plurnk_web_session=valid; plurnk_web_session=valid"]) {
        const response = await problem(await post(simple, { headers: { cookie } }), 401, /Sign in/u);
        assert.equal(response.headers.get("location"), null);
    }
    const response = await post(simple, { headers: { cookie: "plurnk_web_session=valid" } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<svg/u);
});

test("{§web-diagram-service} invalid syntax and compiler limits fail explicitly without poisoning later rendering", async (t) => {
    const { post } = await fixture(t, { PLURNK_WEB_DIAGRAM_EDGES: "1" });
    await problem(await post("flowchart WRONG\n A-->B"), 422, /Lexical error on line 1\. Unrecognized text\./u);
    await problem(await post("unsupported\n A-->B"), 422, /No diagram type detected/u);
    await problem(await post("flowchart LR\n A-->B\n B-->C"), 422, /edge/iu);
    const valid = await post(simple);
    assert.equal(valid.status, 200);
    await valid.text();
    const limited = await fixture(t, { PLURNK_WEB_DIAGRAM_OUTPUT_BYTES: "64" });
    await problem(await limited.post(simple), 422, /output|limit/iu);
});

test("{§web-diagram-service} a slow compiler leaves HTTP responsive, times out and frees its admission", { timeout: 10_000 }, async (t) => {
    const { base, post } = await fixture(t, { PLURNK_WEB_DIAGRAM_THREADS: "1", PLURNK_WEB_DIAGRAM_PENDING: "1", PLURNK_WEB_DIAGRAM_TIMEOUT_MS: "250" });
    const started = Promise.withResolvers();
    const run = Piscina.prototype.run;
    t.mock.method(Piscina.prototype, "run", function (input, options) {
        const result = run.call(this, input, input.source === dense ? { ...options, filename: new URL("./stalled-compiler.js", import.meta.url).href } : options);
        started.resolve();
        return result;
    });
    let settled = false;
    const slow = post(dense).then((response) => { settled = true; return response; });
    await started.promise;
    const home = await fetch(base);
    assert.equal(home.status, 200, "ordinary HTTP works while compilation is pending");
    await home.text();
    assert.equal(settled, false);
    await problem(await post(simple), 429, /busy/u);
    await problem(await slow, 408, /timed out/u);
    const next = await post(simple);
    assert.equal(next.status, 200);
    await next.text();
});

test("{§web-diagram-service} concurrent requests queue without sharing output", async (t) => {
    const { post } = await fixture(t, { PLURNK_WEB_DIAGRAM_THREADS: "1" });
    const outputs = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
        const response = await post(`flowchart LR\n A[unique-${index}] --> B[Done]`);
        assert.equal(response.status, 200);
        return response.text();
    }));
    for (const [index, output] of outputs.entries()) {
        assert.match(output, new RegExp(`unique-${index}`, "u"));
        assert.equal((output.match(/unique-\d/gu) ?? []).length, 1);
    }
});

test("{§web-diagram-service} disconnect and shutdown terminate compilation without orphaning requests", { timeout: 10_000 }, async (t) => {
    const { post, module } = await fixture(t, { PLURNK_WEB_DIAGRAM_THREADS: "1", PLURNK_WEB_DIAGRAM_TIMEOUT_MS: "5000" });
    const run = Piscina.prototype.run;
    let started = Promise.withResolvers();
    let cancelled = Promise.withResolvers();
    t.mock.method(Piscina.prototype, "run", function (...args) {
        const task = run.apply(this, args);
        void task.then(() => cancelled.resolve(), () => cancelled.resolve());
        started.resolve();
        return task;
    });
    const controller = new AbortController();
    const lost = post(dense, { signal: controller.signal });
    const rejected = assert.rejects(lost, { name: "AbortError" });
    await started.promise;
    controller.abort();
    await rejected;
    await cancelled.promise;
    const valid = await post(simple);
    assert.equal(valid.status, 200);
    await valid.text();
    started = Promise.withResolvers();
    cancelled = Promise.withResolvers();
    const closing = post(dense);
    await started.promise;
    await module.close();
    await problem(await closing, 503, /stopping/u);
    await problem(await post(simple), 503, /The PLURNK service is shutting down\./u);
});

test("{§web-diagram-service} unexpected compiler failures retain their cause and release admission", async (t) => {
    const { post, errors } = await fixture(t, { PLURNK_WEB_DIAGRAM_PENDING: "1" });
    const failure = new Error("compiler fixture failed", { cause: new Error("original failure") });
    t.mock.method(Piscina.prototype, "run", async () => { throw failure; }, { times: 1 });
    const rejected = await post(simple);
    assert.equal(rejected.status, 500);
    await rejected.text();
    assert.equal(errors.shift(), failure, "the host receives the original error, not a syntax error or an empty image");
    const next = await post(simple);
    assert.equal(next.status, 200);
    await next.text();
});

test("{§web-diagram-service} another module cleanup failure cannot leave the compiler running", async (t) => {
    const failure = new Error("credential observer cleanup failed");
    let throws = true;
    const { post, module } = await fixture(t, { PLURNK_AUTH: "1" }, () => { if (throws) throw failure; });
    await assert.rejects(module.close(), (error) => error === failure);
    throws = false;
    await problem(await post(simple, { headers: { cookie: "plurnk_web_session=valid" } }), 503, /The PLURNK service is shutting down\./u);
});

test("{§web-route-settlement} compiler cleanup failure still joins requests before releasing observers", async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const order = [];
    const { base, post, module } = await fixture(t, { PLURNK_AUTH: "1" }, () => order.push("observer closed"), {
        async listWorkspaces() { entered.resolve(); await release.promise; order.push("read settled"); return []; },
    });
    const headers = { cookie: "plurnk_web_session=valid" };
    assert.equal((await post(simple, { headers })).status, 200);
    const response = fetch(`${base}/~/`, { headers });
    await entered.promise;
    const failure = new Error("compiler cleanup failed", { cause: new Error("worker fixture failure") });
    const destroy = Piscina.prototype.destroy;
    t.mock.method(Piscina.prototype, "destroy", async function () { await destroy.call(this); throw failure; }, { times: 1 });
    const closed = assert.rejects(module.close(), (error) => error === failure);
    try { await setImmediate(); assert.deepEqual(order, [], "cleanup must not bypass a held request"); }
    finally { release.resolve(); }
    assert.equal((await response).status, 200);
    await closed;
    assert.deepEqual(order, ["read settled", "observer closed"]);
});
