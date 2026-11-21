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
    const keys = ["PLURNK_WEB_LOGIN_TTL_SEC",
        "PLURNK_WEB_OVERVIEW_SESSIONS", "PLURNK_WEB_OVERVIEW_EXCERPT_CHARS",
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
    for (const key of keys) {
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
        process.env[key] = original[key];
    }
});

test("{§web-configuration} {§web-workspace-creation} browser YOLO and PLURNK_WEB_ALLOW_PROJECT_FOLDER use the assembled floor and validate their switches", (t) => {
    for (const [key, expectedDefault] of /** @type {const} */ ([
        ["PLURNK_WEB_YOLO", "0"],
        ["PLURNK_WEB_ALLOW_PROJECT_FOLDER", "1"],
    ])) {
        const original = process.env[key];
        t.after(() => {
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        });
        assert.equal(original, expectedDefault, `${key} default comes from .env.defaults`);
        for (const value of ["0", "1"]) {
            process.env[key] = value;
            const mod = createModule();
            assert.deepEqual(mod.mounts, ["/"]);
            assert.deepEqual(mod.contained, []);
        }
        for (const value of ["", "true", "2"]) {
            process.env[key] = value;
            const mod = createModule();
            assert.deepEqual(mod.mounts, ["/"]);
            assert.equal(mod.contained?.length, 1);
            assert.equal(mod.contained?.[0]?.key, key);
            assert.match(mod.contained?.[0]?.message ?? "", /must be 0 or 1/u);
        }
        delete process.env[key];
        assert.throws(createModule, { message: `${key} is missing from the assembled environment floor.` });
        process.env[key] = original;
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
        listWorkspaces: async () => [{ id: 1, name: "work", project_root: null, project_label: null, archived_at: null }],
        listSessions: async () => [{ id: 2, name: "session1", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null }],
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
    const daemonDir = await fetch(`${base}/~/`, { redirect: "manual" });
    assert.equal(daemonDir.status, 303, "{§web-search} /~/ redirects to /search/");
    assert.equal(daemonDir.headers.get("location"), "/search/");
    assert.equal((await fetch(`${base}/search/`)).status, 200, "search stays live when other parts are contained and face() is null");
    assert.equal((await fetch(`${base}/~/work`)).status, 503, "workspace session page is withheld when PLURNK_WEB_YOLO is invalid");
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
    const renameRes = await fetch(`${base}/workspaces/rename`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" },
        body: "workspace=work&name=renamed",
        redirect: "manual",
    });
    assert.equal(renameRes.status, 303, "rename does not depend on creation tokens and stays live");
    assert.equal(renameRes.headers.get("location"), "/~/renamed");
    assert.equal((await fetch(`${base}/settings/?workspace=work`)).status, 200, "/settings/ stays live when unrelated knobs are contained");
    assert.equal((await fetch(`${base}/settings/?workspace=work`, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(`${base}/settings/?workspace=missing`)).status, 404);
    assert.equal((await fetch(`${base}/settings/`)).status, 404);
});

test("{§web-arrival} {§web-search} GET / resolves 3-tier remembered session arrival, converges empty-daemon allocation, and records POST /place", async (t) => {
    /** @type {Array<{ id: number, name: string, project_root: string | null, project_label: string | null, archived_at: string | null }>} */
    let workspaces = [];
    /** @type {Map<number, Array<{ id: number, name: string, origin: string, parentSessionId: number | null, kind: string, lifecycle: string, archived_at: string | null, reply?: { id: number, at: number, coordinate: string, excerpt: string, continued: boolean } | null }>>} */
    const sessionsByWs = new Map();
    let wsAllocated = 0;
    let sessAllocated = 0;
    const starterGate = Promise.withResolvers();
    let holdStarter = true;

    let handler;
    const mod = createModule();
    await mod.start(/** @type {any} */ ({
        registerHttpRoute(_prefix, serve) { handler = serve; },
        listWorkspaces: async () => workspaces,
        listSessions: async (wsId) => sessionsByWs.get(wsId) ?? [],
        createWorkspace: async ({ name, projectRoot }) => {
            if (holdStarter) await starterGate.promise;
            wsAllocated += 1;
            const ws = { id: 10 + wsAllocated, name: name ?? `amber-brook-${wsAllocated}`, project_root: projectRoot ?? null, project_label: projectRoot ?? null, archived_at: null };
            workspaces = [...workspaces, ws];
            return { workspaceId: ws.id, workspaceName: ws.name, projectRoot: ws.project_root, projectLabel: ws.project_label };
        },
        createSession: async ({ workspaceId, name }) => {
            sessAllocated += 1;
            const sessionName = name ?? `s-${sessAllocated}`;
            const row = { id: 100 + sessAllocated, name: sessionName, origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null, reply: null };
            sessionsByWs.set(workspaceId, [...(sessionsByWs.get(workspaceId) ?? []), row]);
            return { sessionId: row.id, sessionName };
        },
    }));
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    // Tier 3: racing GET / requests on an empty daemon converge on one starter workspace1#session1 allocation.
    const racing = [
        fetch(`${base}/`, { redirect: "manual" }),
        fetch(`${base}/`, { redirect: "manual" }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 15));
    starterGate.resolve();
    holdStarter = false;
    const [firstArrival, secondArrival] = await Promise.all(racing);
    assert.equal(firstArrival.status, 303);
    assert.equal(secondArrival.status, 303);
    assert.equal(firstArrival.headers.get("location"), "/~/workspace1#session1");
    assert.equal(secondArrival.headers.get("location"), "/~/workspace1#session1");
    assert.equal(wsAllocated, 1, "starterFlight allocates one workspace across concurrent GET / requests");
    assert.equal(sessAllocated, 1, "starterFlight allocates one session1 session across concurrent GET / requests");
    assert.match(firstArrival.headers.get("set-cookie") ?? "", /^plurnk_web_place=11:101;/u);

    // Add a second workspace with a newer session and an older remembered session in workspace 11.
    workspaces.push({ id: 12, name: "cobalt-pine", project_root: null, project_label: null, archived_at: null });
    sessionsByWs.set(11, [
        { id: 101, name: "session1", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null, reply: { id: 1, at: 1000, coordinate: "1/1/1", excerpt: "Earlier", continued: false } },
        { id: 102, name: "review", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null, reply: { id: 2, at: 2000, coordinate: "1/1/1", excerpt: "Review", continued: false } },
    ]);
    sessionsByWs.set(12, [
        { id: 201, name: "latest", origin: "model", parentSessionId: null, kind: "root", lifecycle: "idle", archived_at: null, reply: { id: 9, at: 9000, coordinate: "1/1/1", excerpt: "Newest", continued: false } },
    ]);

    // Tier 1: browser with plurnk_web_place=11:102 returns to /~/workspace1#review instead of cobalt-pine#latest.
    const rememberedRes = await fetch(`${base}/`, {
        headers: { cookie: "plurnk_web_place=11:102" },
        redirect: "manual",
    });
    assert.equal(rememberedRes.status, 303);
    assert.equal(rememberedRes.headers.get("location"), "/~/workspace1#review");

    // Tier 2: stale/archived cookie falls through to the most recently active unarchived root session.
    sessionsByWs.get(11)[1].archived_at = "2026-11-20T00:00:00Z";
    const fallbackRes = await fetch(`${base}/`, {
        headers: { cookie: "plurnk_web_place=11:102" },
        redirect: "manual",
    });
    assert.equal(fallbackRes.status, 303);
    assert.equal(fallbackRes.headers.get("location"), "/~/cobalt-pine#latest");
    assert.match(fallbackRes.headers.get("set-cookie") ?? "", /^plurnk_web_place=12:201;/u);

    // POST /place records active tab switch in plurnk_web_place and enforces same-origin POST.
    const placeRes = await fetch(`${base}/place`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
        body: new URLSearchParams({ workspace: "workspace1", session: "session1" }),
    });
    assert.equal(placeRes.status, 204);
    assert.match(placeRes.headers.get("set-cookie") ?? "", /^plurnk_web_place=11:101;/u);
    assert.equal((await fetch(`${base}/place`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
        body: "workspace=workspace1&session=session1",
    })).status, 403);
});

test("{§web-authorization-style} the registered browser client uses the packaged application stylesheet", async () => {
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    const stylesheets = inventory.filter(([, , type]) => type === "text/css");
    assert.ok(stylesheets.some(([path]) => /\/math-renderer-[^/]+\.css$/u.test(path)), "the inventory also contains independently loaded renderer CSS");
    assert.ok(stylesheets.some(([path]) => /\/code-highlight-renderer-[^/]+\.css$/u.test(path)), "the inventory also contains the highlighter palette");
    const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
    const stylesheet = /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/u.exec(html)?.[1];
    assert.ok(stylesheet);
    assert.doesNotMatch(stylesheet, /math-renderer|code-highlight-renderer/u);
    const registrations = [];
    await createModule().setup({ credentials: { registerClient(options) {
        registrations.push(options);
        return { clientId: options.id, clientSecret: "test-only" };
    } } });
    assert.deepEqual(registrations, [{ id: "plurnk-web", redirectPaths: ["/auth/callback"], scopes: ["acp"], stylesheetPath: stylesheet }]);
});

test("{§web-assets} exact public resources and HTTP method matrix", async (t) => {
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
                assert.doesNotMatch(body.toString(), /id="session-navigation"|href="\/account\/"|action="\/auth\/logout"/u);
                assert.match(body.toString(), /<template id="conversation-message">/u,
                    "{§web-session-conversation} the shared HTML owns inert message structure, not authenticated navigation");
                assert.equal(body.byteLength, Number(res.headers.get("content-length")));
            } else assert.deepEqual(body, expected);
        }
    }
    for (const path of ["/missing", "/~/workspace/extra", "/.env.defaults", "/module.js", "/package.json", "/assets.json", "/@vite/client", "/app.js", "/vendor/otm.js", "/vendor/", "/%2e%2e/.env.defaults", "/vendor/%2fetc/passwd", "/%00"]) {
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
    await mkdir(new URL("src/", base));
    for (const file of ["module.js", "index-document.js", "directory-addresses.js", "documents.js", "creations.js", "session.js", "http.js", "static-assets.js", "diagrams.js", "diagram-compiler.js"]) {
        await copyFile(new URL(`../src/${file}`, import.meta.url), new URL(`src/${file}`, base));
    }
    await mkdir(new URL("dist/", base));
    const inventory = [
        ["/index.html", "root.html", "text/html", {}],
        ["/nested/index.html", "nested.html", "text/html", {}],
        ["/nested/child.txt", "child.txt", "text/plain", {}],
    ];
    await writeFile(new URL("dist/assets.json", base), JSON.stringify(inventory));
    await writeFile(new URL("dist/root.html", base), '<title>Plurnk</title><header><template id="session-navigation"></template></header><main><h1>Plurnk</h1></main>');
    await writeFile(new URL("dist/nested.html", base), "<h1>Nested document</h1>");
    await writeFile(new URL("dist/child.txt", base), "Child resource\n");
    const { default: fixtureModule } = await import(new URL("src/module.js", base).href);
    let handler;
    await fixtureModule().start({ registerHttpRoute(_prefix, serve) { handler = serve; } });
    const server = createServer(handler);
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await verifyDirectories(`http://127.0.0.1:${server.address().port}`);
    await t.test("{§web-asset-encoding} missing declared bytes fail before route registration", async () => {
        inventory[2][3] = { br: "missing.txt.br" };
        await writeFile(new URL("dist/assets.json", base), JSON.stringify(inventory));
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
    await verifyStaticAssets(base, new URL("../", import.meta.url));
    server.prependListener("request", (_req, res) => res.setHeader("vary", "Origin"));
    const varied = await fetch(`${base}/manifest.webmanifest`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(varied.headers.get("vary"), "Origin, Accept-Encoding");
    assert.equal(varied.headers.get("content-encoding"), "gzip");
    assert.equal((await varied.json()).id, "/");
});
