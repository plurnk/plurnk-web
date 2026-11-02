import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import createModule from "../ai.plurnk/module.js";
import verifyDirectories from "./directories.js";
import verifyStaticAssets from "./static-assets.js";

test("{§web-host} {§web-configuration} configuration admits only an enabled root owner", (t) => {
    const original = process.env.PLURNK_WEB_ENABLED;
    t.after(() => { process.env.PLURNK_WEB_ENABLED = original; });
    process.env.PLURNK_WEB_ENABLED = "1";
    const enabled = createModule();
    assert.deepEqual(enabled.mounts, ["/"]);
    assert.deepEqual(enabled.contained, []);
    process.env.PLURNK_WEB_ENABLED = "0";
    assert.deepEqual(createModule(), {});
    for (const value of ["", "true", "2"]) {
        process.env.PLURNK_WEB_ENABLED = value;
        assert.throws(createModule, (error) => error instanceof ConfigurationError
            && error.key === "PLURNK_WEB_ENABLED" && error.message.includes("must be 0 or 1"));
    }
});

test("{§web-configuration} missing and invalid limits never select code defaults; disabled web ignores them", (t) => {
    const keys = ["PLURNK_WEB_ENABLED", "PLURNK_WEB_LOGIN_TTL_SEC", "PLURNK_WEB_REASONING_PREVIEW_CHARS",
        "PLURNK_WEB_CREATE_TTL_SEC", "PLURNK_WEB_CREATE_TOKENS", "PLURNK_WEB_FORM_BYTES",
        "PLURNK_WEB_DIAGRAM_THREADS", "PLURNK_WEB_DIAGRAM_PENDING", "PLURNK_WEB_DIAGRAM_TIMEOUT_MS",
        "PLURNK_WEB_DIAGRAM_INPUT_BYTES", "PLURNK_WEB_DIAGRAM_OUTPUT_BYTES", "PLURNK_WEB_DIAGRAM_EDGES"];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    process.env.PLURNK_WEB_ENABLED = "1";
    for (const key of keys.slice(1)) {
        assert.ok(original[key], "the package test runs on the real environment floor");
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
        process.env.PLURNK_WEB_ENABLED = "0";
        assert.deepEqual(createModule(), {});
        process.env.PLURNK_WEB_ENABLED = "1";
        process.env[key] = original[key];
    }
});

test("{§web-configuration} browser YOLO uses the assembled floor and validates its switch", (t) => {
    const original = { yolo: process.env.PLURNK_WEB_YOLO, enabled: process.env.PLURNK_WEB_ENABLED };
    t.after(() => {
        if (original.yolo === undefined) delete process.env.PLURNK_WEB_YOLO;
        else process.env.PLURNK_WEB_YOLO = original.yolo;
        process.env.PLURNK_WEB_ENABLED = original.enabled;
    });
    assert.equal(original.yolo, "0", "explicit review is the package default, not a browser fallback");
    for (const value of ["0", "1"]) {
        process.env.PLURNK_WEB_YOLO = value;
        const mod = createModule();
        assert.deepEqual(mod.mounts, ["/"]);
        assert.deepEqual(mod.contained, []);
    }
    for (const value of ["", "true", "2"]) {
        process.env.PLURNK_WEB_YOLO = value;
        const mod = createModule();
        assert.deepEqual(mod.mounts, ["/"]);
        assert.equal(mod.contained?.length, 1);
        assert.equal(mod.contained?.[0]?.key, "PLURNK_WEB_YOLO");
        assert.match(mod.contained?.[0]?.message ?? "", /must be 0 or 1/u);
    }
    delete process.env.PLURNK_WEB_YOLO;
    assert.throws(createModule, { message: "PLURNK_WEB_YOLO is missing from the assembled environment floor." });
    process.env.PLURNK_WEB_ENABLED = "0";
    assert.deepEqual(createModule(), {}, "disabled web does not require its unused approval setting");
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

test("{§web-configuration} {§web-session} contained settings withhold only their own part and posture follows credentials.face()", async (t) => {
    const keys = ["PLURNK_AUTH", "PLURNK_WEB_DIAGRAM_THREADS", "PLURNK_WEB_CREATE_TTL_SEC", "PLURNK_WEB_FORM_BYTES", "PLURNK_WEB_YOLO", "PLURNK_WEB_LOGIN_TTL_SEC"];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    // Even with PLURNK_AUTH=1 in env, a null credentials.face() means anonymous posture.
    process.env.PLURNK_AUTH = "1";
    process.env.PLURNK_WEB_DIAGRAM_THREADS = "0";
    process.env.PLURNK_WEB_CREATE_TTL_SEC = "0";
    process.env.PLURNK_WEB_YOLO = "invalid";
    const mod = createModule();
    assert.deepEqual(mod.contained?.map(({ key }) => key), [
        "PLURNK_WEB_YOLO",
        "PLURNK_WEB_CREATE_TTL_SEC",
        "PLURNK_WEB_DIAGRAM_THREADS",
    ]);
    let handler;
    await mod.setup({ credentials: { registerClient: () => ({ clientId: "plurnk-web", clientSecret: "sec" }) } });
    await mod.start(/** @type {any} */ ({
        credentials: { face: () => null },
        registerHttpRoute(_prefix, serve) { handler = serve; },
        listWorkspaces: async () => [{ id: 1, name: "work", project_root: null, project_label: null, hidden_at: null }],
        listSessions: async () => [{ id: 2, name: "user", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", hidden_at: null }],
        renameWorkspace: async (id, name) => ({ id, name }),
    }));
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/~/`)).status, 200, "directory reads stay live when other parts are contained and face() is null");
    assert.equal((await fetch(`${base}/~/work/`)).status, 200, "workspace directory stays live");
    assert.equal((await fetch(`${base}/~/work@user/`)).status, 503, "session page is withheld when PLURNK_WEB_YOLO is invalid");
    assert.equal((await fetch(`${base}/render/mermaid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "flowchart LR\n A-->B" }),
    })).status, 503, "diagram compilation is withheld when PLURNK_WEB_DIAGRAM_THREADS is invalid");
    assert.equal((await fetch(`${base}/workspaces/new`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
        body: "token=00000000-0000-4000-8000-000000000000",
    })).status, 503, "workspace creation is withheld when PLURNK_WEB_CREATE_TTL_SEC is invalid");
    assert.equal((await fetch(`${base}/workspaces/rename`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
        body: "workspace=work&name=renamed",
        redirect: "manual",
    })).status, 303, "rename does not depend on creation tokens and stays live");
});

test("{§web-authorization-style} the registered browser client uses the packaged application stylesheet", async () => {
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    const stylesheets = inventory.filter(([, , type]) => type === "text/css");
    assert.ok(stylesheets.some(([path]) => /\/math-renderer-[^/]+\.css$/u.test(path)), "the inventory also contains independently loaded renderer CSS");
    const html = await readFile(new URL("../ai.plurnk/dist/index.html", import.meta.url), "utf8");
    const stylesheet = /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/u.exec(html)?.[1];
    assert.ok(stylesheet);
    assert.doesNotMatch(stylesheet, /math-renderer/u);
    const registrations = [];
    await createModule().setup({ credentials: { registerClient(options) {
        registrations.push(options);
        return { clientId: options.id, clientSecret: "test-only" };
    } } });
    assert.deepEqual(registrations, [{ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"], stylesheetPath: stylesheet }]);
});

test("{§web-assets} exact public resources and HTTP method matrix", async (t) => {
    assert.equal(process.env.PLURNK_WEB_ENABLED, "1");
    let handler;
    await createModule().start(/** @type {any} */ ({ registerHttpRoute(prefix, serve) {
        assert.equal(prefix, "/");
        handler = serve;
    }, listWorkspaces: async () => [], listSessions: async () => [] }));
    const server = createServer(handler);
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = await fetch(`${base}/auth/token`, { method: "POST" });
    assert.equal(token.status, 404, "{§web-access-token} disabled authentication issues no browser credential");
    assert.equal((await token.json()).status, 404);
    const index = await fetch(`${base}/index.html`);
    assert.equal(index.status, 200, "{§web-index-documents} explicit root index is served");
    const indexBody = await index.text();
    assert.equal(indexBody, await (await fetch(`${base}/`)).text());
    const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200, "{§web-installation} manifest is available on the module route");
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    for (const [path, file, type] of inventory) {
        const expected = path === "/index.html" ? Buffer.from(indexBody) : await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url));
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
                assert.doesNotMatch(body.toString(), /id="session-navigation"|href="\/account\/"|action="\/auth\/logout"/u);
                assert.match(body.toString(), /<template id="conversation-message">/u,
                    "{§web-session-conversation} the shared HTML owns inert message structure, not authenticated navigation");
                assert.equal(body.byteLength, Number(res.headers.get("content-length")));
            } else assert.deepEqual(body, expected);
        }
    }
    for (const path of ["/missing", "/~/workspace@user/", "/.env.defaults", "/module.js", "/package.json", "/assets.json", "/@vite/client", "/app.js", "/vendor/otm.js", "/vendor/", "/%2e%2e/.env.defaults", "/vendor/%2fetc/passwd", "/%00"]) {
        for (const method of ["GET", "HEAD"]) {
            const res = await fetch(`${base}${path}`, { method });
            assert.equal(res.status, 404, `${method} ${path}`);
            assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
            assert.equal(res.headers.get("cache-control"), "no-store");
            assert.equal(res.headers.get("referrer-policy"), "no-referrer");
            assert.equal(res.headers.get("content-security-policy"),
                "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
                "{§web-browser-security} image sources do not broaden script or connection permissions");
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
    for (const file of ["module.js", "index-document.js", "directory-addresses.js", "documents.js", "creations.js", "session.js", "http.js", "static-assets.js", "diagrams.js", "diagram-compiler.js"]) {
        await copyFile(new URL(`../ai.plurnk/${file}`, import.meta.url), new URL(file, base));
    }
    await mkdir(new URL("dist/", base));
    const inventory = [
        ["/index.html", "root.html", "text/html", {}],
        ["/nested/index.html", "nested.html", "text/html", {}],
        ["/nested/child.txt", "child.txt", "text/plain", {}],
    ];
    await writeFile(new URL("assets.json", base), JSON.stringify(inventory));
    await writeFile(new URL("dist/root.html", base), '<title>Plurnk</title><header><template id="session-navigation"></template></header><main><h1>Plurnk</h1></main>');
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
    await t.test("{§web-asset-encoding} missing declared bytes fail before route registration", async () => {
        inventory[2][3] = { br: "missing.txt.br" };
        await writeFile(new URL("assets.json", base), JSON.stringify(inventory));
        let registered = false;
        await assert.rejects(fixtureModule().start({ registerHttpRoute() { registered = true; } }),
            (/** @type {any} */ error) => error.code === "ENOENT" && error.path.endsWith("missing.txt.br"));
        assert.equal(registered, false);
    });
});

test("{§web-asset-encoding} static negotiation preserves exact bytes and HTTP semantics", async (t) => {
    let handler;
    await createModule().start(/** @type {any} */ ({ registerHttpRoute(_prefix, serve) { handler = serve; } }));
    const server = createServer(handler);
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    await verifyStaticAssets(base, new URL("../ai.plurnk/", import.meta.url));
    server.prependListener("request", (_req, res) => res.setHeader("vary", "Origin"));
    const varied = await fetch(`${base}/manifest.webmanifest`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(varied.headers.get("vary"), "Origin, Accept-Encoding");
    assert.equal(varied.headers.get("content-encoding"), "gzip");
    assert.equal((await varied.json()).id, "/");
});
