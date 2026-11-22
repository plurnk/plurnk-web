import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { setImmediate } from "node:timers/promises";

async function fixture(t, createModule, /** @type {any} */ { credentials } = {}) {
    const module = createModule();
    let handler;
    await module.setup?.({ credentials });
    await module.start({
        credentials,
        registerHttpRoute(prefix, serve) {
            assert.equal(prefix, "/");
            handler = serve;
        },
    });
    const errors = [];
    const server = createServer((req, res) => {
        void handler(req, res).catch((error) => {
            errors.push(error);
            res.writeHead(500);
            res.end();
        });
    });
    let closing;
    const close = () => closing ??= module.close();
    t.after(async () => {
        try { await close(); }
        finally { await new Promise((resolve) => server.close(resolve)); }
        assert.deepEqual(errors, [], "unexpected route errors must reach the host");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    return { module, close, base, errors, server };
}

function hold() {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    return {
        entered: entered.promise,
        release: release.resolve,
        call: async () => {
            entered.resolve();
            return release.promise;
        },
    };
}

async function pending(close) {
    let settled = false;
    const result = close().then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false, "close must not return while an admitted request is held");
    return { result };
}

async function stopping(response) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    const problem = await response.json();
    assert.equal(problem.status, 503);
    assert.match(problem.type, /service-stopping$/u);
    assert.match(problem.detail, /shutting down/u);
}

/** {§web-route-settlement} Real HTTP requests through source and packed module entry points. */
export default async function verifyRouteSettlement(t, createModule) {
    await t.test("stop refuses every route family without inspecting host credentials", async (t) => {
        const credentials = {
            face: () => ({ issuer: () => "https://authority.example" }),
            verify() {
                throw new Error("credentials accessed after stop");
            },
        };
        const f = await fixture(t, createModule, { credentials });
        f.module.stop();
        f.module.stop();
        for (const [path, method] of [
            ["/", "GET"],
            ["/manifest.webmanifest", "GET"],
            ["/search/", "GET"],
            ["/~/", "GET"],
            ["/~/example", "GET"],
            ["/settings/", "GET"],
            ["/auth/callback", "GET"],
            ["/render/mermaid", "POST"],
            ["/missing", "GET"],
        ]) {
            await stopping(await fetch(`${f.base}${path}`, {
                method,
                redirect: "manual",
                headers: { origin: f.base, authorization: "Bearer token" },
            }));
        }
        const head = await fetch(`${f.base}/`, { method: "HEAD" });
        assert.equal(head.status, 503);
        assert.equal(await head.text(), "");
        await f.close();
    });

    await t.test("close joins in-flight Mermaid bearer verification before releasing resources", async (t) => {
        const gate = hold();
        const credentials = {
            face: () => ({ issuer: () => "https://authority.example" }),
            async verify(token) {
                assert.equal(token, "valid-jwt");
                await gate.call();
                return { sub: "operator" };
            },
        };
        const f = await fixture(t, createModule, { credentials });
        const responsePromise = fetch(`${f.base}/render/mermaid`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: f.base,
                authorization: "Bearer valid-jwt",
            },
            body: JSON.stringify({ source: "flowchart LR\n A-->B" }),
        });
        await gate.entered;
        try {
            await pending(f.close);
        } finally {
            gate.release();
        }
        // Once close() has begun, diagrams.close() cancels compilation or settles cleanly; verify close() finishes without orphaned work.
        const response = await responsePromise;
        assert.ok([200, 503].includes(response.status));
        await f.close();
        await stopping(await fetch(`${f.base}/`));
    });

    await t.test("an admitted unfinished diagram body stays owned until the transport settles", async (t) => {
        const f = await fixture(t, createModule);
        const entered = once(f.server, "request");
        const upload = request(`${f.base}/render/mermaid`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: f.base,
            },
        });
        const response = once(upload, "response");
        upload.write('{"source":');
        await entered;
        try { await pending(f.close); }
        finally { upload.end('"flowchart LR\\nA-->B"}'); }
        const [res] = await response;
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        assert.equal(res.statusCode, 503);
        assert.match(JSON.parse(Buffer.concat(chunks).toString()).detail, /stopping/u);
        await f.close();
    });

    await t.test("stop and close tolerate incomplete startup", async () => {
        const module = createModule();
        module.stop();
        await module.close();
        await module.close();

        const rejected = createModule();
        const failure = new Error("host refused route registration");
        await assert.rejects(rejected.start({ registerHttpRoute() { throw failure; } }), (error) => error === failure);
        await rejected.close();
    });
}
