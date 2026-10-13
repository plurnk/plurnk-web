import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import createModule from "../ai.plurnk/module.js";

test("{§web-host} configuration admits only an enabled root owner", (t) => {
    const original = process.env.PLURNK_WEB_ENABLED;
    t.after(() => { process.env.PLURNK_WEB_ENABLED = original; });
    process.env.PLURNK_WEB_ENABLED = "1";
    assert.deepEqual(createModule().mounts, ["/"]);
    process.env.PLURNK_WEB_ENABLED = "0";
    assert.deepEqual(createModule(), {});
    for (const value of ["", "true", "2"]) {
        process.env.PLURNK_WEB_ENABLED = value;
        assert.throws(createModule, (error) => error instanceof ConfigurationError
            && error.key === "PLURNK_WEB_ENABLED" && error.message.includes("must be 0 or 1"));
    }
});

test("{§web-assets} exact public resources and HTTP method matrix", async (t) => {
    assert.equal(process.env.PLURNK_WEB_ENABLED, "1");
    let handler;
    await createModule().start({ registerHttpRoute(prefix, serve) {
        assert.equal(prefix, "/");
        handler = serve;
    } });
    const server = createServer(handler);
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [path, file, type] of [
        ["/", "index.html", "text/html"],
        ["/app.js", "app.js", "text/javascript"],
        ["/vendor/otm.js", "vendor/otm.js", "text/javascript"],
        ["/locales/en.json", "locales/en.json", "application/json"],
        ["/vendor/OTM-LICENSE.txt", "vendor/OTM-LICENSE.txt", "text/plain"],
    ]) {
        const expected = await readFile(new URL(`../ai.plurnk/public/${file}`, import.meta.url));
        for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${base}${path}?ignored=yes`, { method });
            assert.equal(res.status, 200, `${method} ${path}`);
            assert.equal(res.headers.get("content-type"), `${type}; charset=utf-8`);
            assert.equal(res.headers.get("content-length"), String(expected.byteLength));
            assert.equal(res.headers.get("x-content-type-options"), "nosniff");
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), method === "HEAD" ? Buffer.alloc(0) : expected);
        }
    }
    for (const path of ["/missing", "/index.html", "/.env.defaults", "/module.js", "/package.json", "/vendor/", "/%2e%2e/.env.defaults", "/vendor/%2fetc/passwd", "/%00"]) {
        for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${base}${path}`, { method });
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.equal(await res.text(), method === "HEAD" ? "" : "Not found\n");
        }
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const res = await fetch(base, { method });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "GET, HEAD");
        assert.equal(await res.text(), "Method not allowed\n");
    }
    // Send the raw path: fetch normalizes dot segments before making its request.
    const raw = await new Promise((resolve, reject) => {
        request(`${base}/`, { path: "/../../package.json" }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
        }).on("error", reject).end();
    });
    assert.equal(raw, 404);
});
