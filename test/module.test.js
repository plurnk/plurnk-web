import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import createModule from "../ai.plurnk/module.js";
import verifyDirectories from "./directories.js";

process.env.PLURNK_AUTH = "0";

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
    }, listWorkspaces: async () => [], listWorkers: async () => [] });
    const server = createServer(handler);
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const index = await fetch(`${base}/index.html`);
    assert.equal(index.status, 200, "{§web-index-documents} explicit root index is served");
    assert.equal(await index.text(), await (await fetch(`${base}/`)).text());
    const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200, "{§web-installation} manifest is available on the module route");
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    for (const [path, file, type] of inventory) {
        const expected = await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url));
        for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${base}${path}?ignored=yes`, { method });
            assert.equal(res.status, 200, `${method} ${path}`);
            assert.equal(res.headers.get("content-type"), type.startsWith("image/") ? type : `${type}; charset=utf-8`);
            assert.equal(res.headers.get("content-length"), String(expected.byteLength));
            assert.equal(res.headers.get("x-content-type-options"), "nosniff");
            assert.deepEqual(Buffer.from(await res.arrayBuffer()), method === "HEAD" ? Buffer.alloc(0) : expected);
        }
    }
    for (const path of ["/missing", "/~/workspace@user/", "/.env.defaults", "/module.js", "/package.json", "/assets.json", "/@vite/client", "/app.js", "/vendor/otm.js", "/vendor/", "/%2e%2e/.env.defaults", "/vendor/%2fetc/passwd", "/%00"]) {
        for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${base}${path}`, { method });
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
            assert.equal(res.headers.get("cache-control"), "no-store");
            assert.equal(res.headers.get("referrer-policy"), "no-referrer");
            assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
            if (method === "HEAD") assert.equal(await res.text(), "");
            else {
                const body = await res.text();
                assert.match(body, /<h1[^>]*>404 Not Found<\/h1>/u);
                assert.match(body, /<nav aria-label="Main navigation">/u);
                assert.equal(Buffer.byteLength(body), Number(res.headers.get("content-length")));
            }
        }
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const res = await fetch(base, { method });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "GET, HEAD");
        assert.match(await res.text(), /<h1[^>]*>405 Method Not Allowed<\/h1>/u);
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

test("{§web-index-documents} production resolves only admitted directory indexes", async (t) => {
    const directory = await mkdtemp(new URL("../.module-test-", import.meta.url));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const base = pathToFileURL(`${directory}/`);
    for (const file of ["module.js", "index-document.js", "directory-addresses.js", "documents.js", "session.js", "http.js"]) {
        await copyFile(new URL(`../ai.plurnk/${file}`, import.meta.url), new URL(file, base));
    }
    await mkdir(new URL("dist/", base));
    const inventory = [
        ["/index.html", "root.html", "text/html"],
        ["/nested/index.html", "nested.html", "text/html"],
        ["/nested/child.txt", "child.txt", "text/plain"],
    ];
    await writeFile(new URL("assets.json", base), JSON.stringify(inventory));
    await writeFile(new URL("dist/root.html", base), "<title>Plurnk</title><main><h1>Plurnk</h1></main>");
    await writeFile(new URL("dist/nested.html", base), "<h1>Nested document</h1>");
    await writeFile(new URL("dist/child.txt", base), "Child resource\n");
    const { default: fixtureModule } = await import(new URL("module.js", base).href);
    let handler;
    await fixtureModule().start({ registerHttpRoute(_prefix, serve) { handler = serve; } });
    const server = createServer(handler);
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await verifyDirectories(`http://127.0.0.1:${server.address().port}`);
});
