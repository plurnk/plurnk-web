import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import createModule from "../src/module.js";
import verifyDirectories from "./directories.js";
import verifyStaticAssets from "./static-assets.js";

test("{§web-host} {§web-configuration} installed module claims root on the assembled floor", () => {
    const enabled = createModule();
    assert.deepEqual(enabled.mounts, ["/"]);
    assert.deepEqual(enabled.contained, []);
});

test("{§web-configuration} missing and invalid limits never select code defaults", (t) => {
    const keys = [
        "PLURNK_WEB_OVERVIEW_SESSIONS",
        "PLURNK_WEB_OVERVIEW_EXCERPT_CHARS",
        "PLURNK_WEB_DIAGRAM_THREADS",
        "PLURNK_WEB_DIAGRAM_PENDING",
        "PLURNK_WEB_DIAGRAM_TIMEOUT_MS",
        "PLURNK_WEB_DIAGRAM_INPUT_BYTES",
        "PLURNK_WEB_DIAGRAM_OUTPUT_BYTES",
        "PLURNK_WEB_DIAGRAM_EDGES",
    ];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    for (const key of keys) {
        assert.ok(original[key], `${key} runs on the real environment floor`);
        delete process.env[key];
        assert.throws(createModule, { message: `${key} is missing from the assembled environment floor.` });
        for (const value of ["", "0", "-1", "1.5", "unbounded"]) {
            process.env[key] = value;
            const mod = createModule();
            assert.deepEqual(mod.mounts, ["/"]);
            assert.equal(mod.contained?.length, 1);
            assert.equal(mod.contained?.[0]?.key, key);
            assert.match(mod.contained?.[0]?.message ?? "", /safe integer of at least 1/u);
        }
        process.env[key] = original[key];
    }
});

test("{§web-configuration} {§web-workspace-creation} PLURNK_WEB_ALLOW_PROJECT_FOLDER and PLURNK_ACP_URL validate at startup", (t) => {
    const keys = ["PLURNK_WEB_ALLOW_PROJECT_FOLDER", "PLURNK_ACP_URL"];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    assert.equal(original.PLURNK_WEB_ALLOW_PROJECT_FOLDER, "1");
    for (const value of ["0", "1"]) {
        process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER = value;
        const mod = createModule();
        assert.deepEqual(mod.mounts, ["/"]);
        assert.deepEqual(mod.contained, []);
    }
    for (const value of ["", "true", "2"]) {
        process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER = value;
        const mod = createModule();
        assert.equal(mod.contained?.length, 1);
        assert.equal(mod.contained?.[0]?.key, "PLURNK_WEB_ALLOW_PROJECT_FOLDER");
        assert.match(mod.contained?.[0]?.message ?? "", /must be 0 or 1/u);
    }
    delete process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER;
    assert.throws(createModule, { message: "PLURNK_WEB_ALLOW_PROJECT_FOLDER is missing from the assembled environment floor." });
    process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER = "1";

    for (const validUrl of ["", "/acp", "http://127.0.0.1:4321/acp", "https://acp.example/acp"]) {
        process.env.PLURNK_ACP_URL = validUrl;
        assert.deepEqual(createModule().contained, []);
    }
    for (const invalidUrl of ["ws://127.0.0.1:4321/acp", "//evil.example/acp", "acp", "https://user:pass@acp.example/acp"]) {
        process.env.PLURNK_ACP_URL = invalidUrl;
        const mod = createModule();
        assert.equal(mod.contained?.length, 1, invalidUrl);
        assert.equal(mod.contained?.[0]?.key, "PLURNK_ACP_URL");
    }
});

test("{§web-configuration} diagram deadlines cannot overflow Node's timer range", (t) => {
    const key = "PLURNK_WEB_DIAGRAM_TIMEOUT_MS";
    const original = process.env[key];
    t.after(() => { process.env[key] = original; });
    process.env[key] = String(2 ** 31);
    const mod = createModule();
    assert.deepEqual(mod.mounts, ["/"]);
    assert.equal(mod.contained?.length, 1);
    assert.equal(mod.contained?.[0]?.key, key);
    assert.match(mod.contained?.[0]?.message ?? "", /must not exceed 2147483647 milliseconds/u);
});

test("{§web-configuration} {§web-browser-security} PLURNK_ACP_URL stamps boot data-* attributes and expands CSP connect-src/img-src without inline scripts", async (t) => {
    const keys = ["PLURNK_ACP_URL", "PLURNK_WEB_ALLOW_PROJECT_FOLDER", "PLURNK_WEB_OVERVIEW_SESSIONS", "PLURNK_WEB_OVERVIEW_EXCERPT_CHARS", "PLURNK_WEB_DIAGRAM_THREADS"];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    process.env.PLURNK_ACP_URL = "https://acp.example:8443/acp";
    process.env.PLURNK_WEB_ALLOW_PROJECT_FOLDER = "0";
    process.env.PLURNK_WEB_OVERVIEW_SESSIONS = "42";
    process.env.PLURNK_WEB_OVERVIEW_EXCERPT_CHARS = "96";
    process.env.PLURNK_WEB_DIAGRAM_THREADS = "0";

    const mod = createModule();
    assert.deepEqual(mod.contained?.map(({ key }) => key), ["PLURNK_WEB_DIAGRAM_THREADS"]);

    let handler;
    await mod.start({
        credentials: {
            face: () => ({ issuer: () => "https://idp.example/oauth" }),
            verify: () => null,
        },
        registerHttpRoute(_prefix, serve) { handler = serve; },
    });
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    const daemonDir = await fetch(`${base}/~/`, { redirect: "manual" });
    assert.equal(daemonDir.status, 303, "{§web-search} GET /~/ redirects to /search/");
    assert.equal(daemonDir.headers.get("location"), "/search/");

    for (const [path, expectedPage] of /** @type {const} */ ([
        ["/", "home"],
        ["/index.html", "home"],
        ["/~/work", "session"],
        ["/~/team/project", "session"],
        ["/search/", "search"],
        ["/search/index.html", "search"],
        ["/settings/?workspace=work", "settings"],
        ["/settings/", "settings"],
        ["/auth/callback", "callback"],
    ])) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(
            res.headers.get("content-security-policy"),
            "default-src 'self'; script-src 'self'; connect-src 'self' https://acp.example:8443 wss://acp.example:8443 https://idp.example; img-src 'self' https://acp.example:8443 data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        );
        const html = await res.text();
        assert.match(html, /<html\b[^>]*\bdata-acp-url="https:\/\/acp\.example:8443\/acp"/u);
        assert.match(html, /\bdata-allow-project-folder="0"/u);
        assert.match(html, /\bdata-overview-sessions="42"/u);
        assert.match(html, /\bdata-overview-excerpt-chars="96"/u);
        assert.match(html, /\bdata-web-version="\d+\.\d+\.\d+"/u);
        assert.match(html, new RegExp(`<main id="main" data-page="${expectedPage}"`, "u"));
        assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/iu, "strict script-src 'self' forbids inline script blocks");
    }

    assert.equal((await fetch(`${base}/render/mermaid`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: base,
            authorization: "Bearer test",
        },
        body: JSON.stringify({ source: "flowchart LR\n A-->B" }),
    })).status, 503, "diagram compilation is withheld when PLURNK_WEB_DIAGRAM_THREADS is invalid");
});

test("{§web-assets} {§web-directory-documents} exact public resources, pure static shells without seam backdoors, and HTTP method matrix", async (t) => {
    let handler;
    // Start with ONLY { registerHttpRoute } to prove zero seam.* workspace/session methods are required.
    const mod = createModule();
    await mod.start({
        registerHttpRoute(prefix, serve) {
            assert.equal(prefix, "/");
            handler = serve;
        },
    });
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    const index = await fetch(`${base}/index.html`);
    assert.equal(index.status, 200, "{§web-index-documents} explicit root index is served");
    const indexBody = await index.text();
    assert.equal(indexBody, await (await fetch(`${base}/`)).text());
    const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200, "{§web-installation} manifest is available on the module route");

    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    for (const [path, file, type] of inventory) {
        const expected = path === "/index.html" ? Buffer.from(indexBody) : await readFile(new URL(`../dist/${file}`, import.meta.url));
        for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${base}${path}?ignored=yes`, { method, headers: { "accept-encoding": "identity" } });
            assert.equal(res.status, 200, `${method} ${path}`);
            assert.equal(res.headers.get("content-type"), type.startsWith("text/") ? `${type}; charset=utf-8` : type);
            assert.equal(res.headers.get("content-length"), String(expected.byteLength));
            assert.equal(res.headers.get("x-content-type-options"), "nosniff");
            const body = Buffer.from(await res.arrayBuffer());
            if (method === "HEAD") assert.deepEqual(body, Buffer.alloc(0));
            else if (path === "/index.html") {
                assert.match(body.toString(), /<main\b[^>]*data-page="home"[^>]*>\s*<\/main>/u);
                assert.match(body.toString(), /<template id="conversation-message">/u,
                    "{§web-session-conversation} the shared HTML owns inert message structure");
                assert.equal(body.byteLength, Number(res.headers.get("content-length")));
            } else assert.deepEqual(body, expected);
        }
    }

    for (const path of ["/missing", "/~", "/~/%GG", "/.env.defaults", "/module.js", "/package.json", "/assets.json", "/@vite/client", "/app.js", "/vendor/otm.js", "/vendor/", "/%2e%2e/.env.defaults", "/vendor/%2fetc/passwd", "/%00"]) {
        for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${base}${path}`, { method });
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
            assert.equal(res.headers.get("cache-control"), "no-store");
            assert.equal(res.headers.get("referrer-policy"), "no-referrer");
            assert.equal(
                res.headers.get("content-security-policy"),
                "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
                "{§web-browser-security} default same-origin CSP locks down script-src and connect-src",
            );
            if (method === "HEAD") assert.equal(await res.text(), "");
            else {
                const body = await res.text();
                assert.match(body, /<h1 id="error-title"><span aria-hidden="true">⚠️<\/span> <span data-text="error-title">404 Not Found<\/span><\/h1>/u);
                assert.match(body, /<nav aria-label="Main navigation">/u);
                assert.equal(Buffer.byteLength(body), Number(res.headers.get("content-length")));
            }
        }
    }

    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const res = await fetch(base, { method });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get("allow"), "GET, HEAD");
        assert.match(await res.text(), /<h1 id="error-title"><span aria-hidden="true">⚠️<\/span> <span data-text="error-title">405 Method Not Allowed<\/span><\/h1>/u);
    }

    for (const rawPath of ["/../../package.json", "/~/a/..", "/~/a/%2e%2e"]) {
        const raw = await new Promise((resolve, reject) => {
            request(`${base}/`, { path: rawPath }, (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode));
            }).on("error", reject).end();
        });
        assert.equal(raw, 404, rawPath);
    }
});

test("{§web-index-documents} production resolves only admitted directory indexes", async (t) => {
    const directory = await mkdtemp(new URL("../.module-test-", import.meta.url));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const base = pathToFileURL(`${directory}/`);
    await copyFile(new URL("../package.json", import.meta.url), new URL("package.json", base));
    await mkdir(new URL("src/", base));
    for (const file of ["module.js", "index-document.js", "directory-addresses.js", "documents.js", "http.js", "static-assets.js", "diagrams.js", "diagram-compiler.js"]) {
        await copyFile(new URL(`../src/${file}`, import.meta.url), new URL(`src/${file}`, base));
    }
    await mkdir(new URL("dist/", base));
    const inventory = [
        ["/index.html", "root.html", "text/html", {}],
        ["/app.css", "app.css", "text/css", {}],
        ["/nested/index.html", "nested.html", "text/html", {}],
        ["/nested/child.txt", "child.txt", "text/plain", {}],
    ];
    await writeFile(new URL("dist/assets.json", base), JSON.stringify(inventory));
    await writeFile(new URL("dist/root.html", base), '<!doctype html><html><head><link rel="stylesheet" href="/app.css"><title>Plurnk</title></head><body><header><nav></nav></header><main><h1>Plurnk</h1></main></body></html>');
    await writeFile(new URL("dist/app.css", base), "body { margin: 0; }\n");
    await writeFile(new URL("dist/nested.html", base), "<h1>Nested document</h1>");
    await writeFile(new URL("dist/child.txt", base), "Child resource\n");
    const { default: fixtureModule } = await import(new URL("src/module.js", base).href);
    let handler;
    const instance = fixtureModule();
    await instance.start({ registerHttpRoute(_prefix, serve) { handler = serve; } });
    const server = createServer(handler);
    t.after(async () => {
        await instance.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await verifyDirectories(`http://127.0.0.1:${server.address().port}`);
    await t.test("{§web-asset-encoding} missing declared bytes fail before route registration", async () => {
        inventory[3][3] = { br: "missing.txt.br" };
        await writeFile(new URL("dist/assets.json", base), JSON.stringify(inventory));
        let registered = false;
        await assert.rejects(fixtureModule().start({ registerHttpRoute() { registered = true; } }),
            (/** @type {any} */ error) => error.code === "ENOENT" && error.path.endsWith("missing.txt.br"));
        assert.equal(registered, false);
    });
});

test("{§web-asset-encoding} static negotiation preserves exact bytes and HTTP semantics", async (t) => {
    let handler;
    const mod = createModule();
    await mod.start({ registerHttpRoute(_prefix, serve) { handler = serve; } });
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    await verifyStaticAssets(base, new URL("../", import.meta.url));
    server.prependListener("request", (_req, res) => res.setHeader("vary", "Origin"));
    const varied = await fetch(`${base}/manifest.webmanifest`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(varied.headers.get("vary"), "Origin, Accept-Encoding");
    assert.equal(varied.headers.get("content-encoding"), "gzip");
    assert.equal((await varied.json()).id, "/");
});
