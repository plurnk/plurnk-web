import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import createModule from "../src/module.js";
import { resolveIssuerOrigin } from "../src/http.js";
import { readAsset } from "../src/static-assets.js";
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

test("{§web-configuration} PLURNK_ACP_URL validates at startup", (t) => {
    const original = process.env.PLURNK_ACP_URL;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_ACP_URL;
        else process.env.PLURNK_ACP_URL = original;
    });

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
    const keys = ["PLURNK_ACP_URL", "PLURNK_WEB_OVERVIEW_SESSIONS", "PLURNK_WEB_OVERVIEW_EXCERPT_CHARS", "PLURNK_WEB_DIAGRAM_THREADS"];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    process.env.PLURNK_ACP_URL = "https://acp.example:8443/acp";
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
        assert.match(html, /\bdata-app-name="Plurnk"/u);
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
    for (const file of ["brand.js", "module.js", "index-document.js", "directory-addresses.js", "documents.js", "http.js", "static-assets.js", "diagrams.js", "diagram-compiler.js"]) {
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

    // Packaged dist/ representations record file URLs and byte lengths without pinning private Buffers in heap.
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    const [, file, mediaType, encoded] = inventory.find(([, , , map]) => Object.keys(map).length > 0);
    const descriptor = await readAsset(file, mediaType, encoded);
    for (const [encoding, rep] of descriptor.representations) {
        assert.equal("body" in rep, false, `${encoding} representation does not pin Buffer bytes in private heap`);
        assert.equal("file" in rep, true, `${encoding} representation points to a packaged file URL`);
        assert.ok(rep.byteLength > 0, `${encoding} representation records exact byte length`);
    }
});

test("{§web-brand} {§web-configuration} brand knobs fail hard on missing/invalid values and serve startup-loaded CSS, icons, and manifest", async (t) => {
    const keys = [
        "PLURNK_WEB_APP_NAME",
        "PLURNK_WEB_APP_DESCRIPTION",
        "PLURNK_WEB_THEME_COLOR",
        "PLURNK_WEB_ABOUT_LINKS",
        "PLURNK_WEB_THEME_CSS_FILE",
        "PLURNK_WEB_ICON_FILE",
        "PLURNK_WEB_MASKABLE_ICON_FILE",
    ];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    // 1. Missing required floor knobs throw immediately.
    for (const key of ["PLURNK_WEB_APP_NAME", "PLURNK_WEB_APP_DESCRIPTION", "PLURNK_WEB_THEME_COLOR", "PLURNK_WEB_ABOUT_LINKS"]) {
        delete process.env[key];
        assert.throws(createModule, { message: `${key} is missing from the assembled environment floor.` });
        process.env[key] = original[key];
    }

    // 2. Invalid brand knob values throw ConfigurationError immediately (no silent fallback).
    const invalidCases = /** @type {const} */ ([
        ["PLURNK_WEB_APP_NAME", ""],
        ["PLURNK_WEB_APP_NAME", "Bad\nName"],
        ["PLURNK_WEB_APP_NAME", "a".repeat(101)],
        ["PLURNK_WEB_APP_DESCRIPTION", "   "],
        ["PLURNK_WEB_THEME_COLOR", "green"],
        ["PLURNK_WEB_THEME_COLOR", "#1234"],
        ["PLURNK_WEB_ABOUT_LINKS", "not-json"],
        ["PLURNK_WEB_ABOUT_LINKS", "{}"],
        ["PLURNK_WEB_ABOUT_LINKS", JSON.stringify([{ label: "XSS", url: "javascript:alert(1)" }])],
        ["PLURNK_WEB_ABOUT_LINKS", JSON.stringify([{ label: "Creds", url: "https://u:p@example.com" }])],
        ["PLURNK_WEB_ABOUT_LINKS", JSON.stringify([{ label: "Extra", url: "https://example.com", extra: 1 }])],
        ["PLURNK_WEB_THEME_CSS_FILE", "relative/theme.css"],
        ["PLURNK_WEB_THEME_CSS_FILE", "/etc/theme.js"],
        ["PLURNK_WEB_ICON_FILE", "relative/icon.svg"],
        ["PLURNK_WEB_ICON_FILE", "/etc/icon.gif"],
        ["PLURNK_WEB_MASKABLE_ICON_FILE", "/etc/icon.jpg"],
    ]);
    for (const [key, value] of invalidCases) {
        process.env[key] = value;
        assert.throws(
            createModule,
            (/** @type {any} */ error) => error?.name === "ConfigurationError" && error?.key === key,
            `expected ConfigurationError for ${key}=${value}`,
        );
        process.env[key] = original[key];
    }

    // 3. Startup-loaded files fail hard when missing, empty, non-regular, invalid UTF-8, or invalid PNG.
    const dir = await mkdtemp(new URL("../.brand-test-", import.meta.url));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const cssPath = new URL("theme.css", pathToFileURL(`${dir}/`)).pathname;
    const svgPath = new URL("icon.svg", pathToFileURL(`${dir}/`)).pathname;
    const pngPath = new URL("maskable.png", pathToFileURL(`${dir}/`)).pathname;
    const emptyCss = new URL("empty.css", pathToFileURL(`${dir}/`)).pathname;
    const badPng = new URL("bad.png", pathToFileURL(`${dir}/`)).pathname;
    const badUtf8Css = new URL("bad-utf8.css", pathToFileURL(`${dir}/`)).pathname;
    await writeFile(cssPath, "@layer scheme { :root { --otm-primary: #0055aa; } }\n".repeat(12));
    await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#0055aa"/></svg>\n');
    // Minimal valid 1x1 PNG header + bytes
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]));
    await writeFile(emptyCss, "");
    await writeFile(badPng, "not a png");
    await writeFile(badUtf8Css, Buffer.from([0xff, 0xfe, 0x80]));

    for (const [key, badPath, pattern] of /** @type {const} */ ([
        ["PLURNK_WEB_THEME_CSS_FILE", `${dir}/missing.css`, /ENOENT/u],
        ["PLURNK_WEB_THEME_CSS_FILE", emptyCss, /must not be empty/u],
        ["PLURNK_WEB_THEME_CSS_FILE", badUtf8Css, /not valid UTF-8/u],
        ["PLURNK_WEB_ICON_FILE", badPng, /not a valid PNG/u],
    ])) {
        process.env[key] = badPath;
        const broken = createModule();
        await assert.rejects(async () => { await broken.start({ registerHttpRoute() {} }); }, pattern, `${key}=${badPath}`);
        process.env[key] = original[key];
    }

    // 4. Valid custom brand serves synthesized manifest, compressed /brand/* assets, and stamped HTML shells.
    process.env.PLURNK_WEB_APP_NAME = "Acme Bot";
    process.env.PLURNK_WEB_APP_DESCRIPTION = "Acme hosted workspace.";
    process.env.PLURNK_WEB_THEME_COLOR = "#0055AA";
    process.env.PLURNK_WEB_ABOUT_LINKS = JSON.stringify([{ label: "Docs", url: "https://docs.acme.example" }]);
    process.env.PLURNK_WEB_THEME_CSS_FILE = cssPath;
    process.env.PLURNK_WEB_ICON_FILE = svgPath;
    process.env.PLURNK_WEB_MASKABLE_ICON_FILE = "";

    const mod = createModule();
    let handler;
    await mod.start({ registerHttpRoute(_prefix, serve) { handler = serve; } });
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    const html = await (await fetch(`${base}/settings/`)).text();
    assert.ok(html.includes('data-app-name="Acme Bot"'));
    assert.ok(html.includes('<meta name="theme-color" content="#0055aa">'));
    assert.ok(html.includes('<meta name="application-name" content="Acme Bot">'));
    assert.ok(html.includes('<meta name="description" content="Acme hosted workspace.">'));
    assert.ok(html.includes('<link rel="icon" href="/brand/icon.svg" type="image/svg+xml" sizes="any">'));
    assert.ok(html.includes('<link rel="stylesheet" href="/brand/theme.css">'));
    assert.ok(html.includes('<dt>Docs</dt><dd><a href="https://docs.acme.example/" target="_blank" rel="noopener noreferrer">docs.acme.example/</a></dd>'));

    const cssRes = await fetch(`${base}/brand/theme.css`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(cssRes.status, 200);
    assert.equal(cssRes.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(cssRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(cssRes.headers.get("content-encoding"), "gzip");
    assert.match(await cssRes.text(), /--otm-primary: #0055aa/u);
    assert.equal((await fetch(`${base}/brand/theme.css`, { method: "POST" })).status, 405);

    const iconRes = await fetch(`${base}/brand/icon.svg`);
    assert.equal(iconRes.status, 200);
    assert.equal(iconRes.headers.get("content-type"), "image/svg+xml");
    assert.equal(iconRes.headers.get("x-content-type-options"), "nosniff");

    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, "Acme Bot");
    assert.equal(manifest.short_name, "Acme Bot");
    assert.equal(manifest.description, "Acme hosted workspace.");
    assert.equal(manifest.theme_color, "#0055aa");
    assert.deepEqual(manifest.icons, [
        { src: "/brand/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ], "custom icon without maskable icon omits the default Plurnk maskable icon");

    // 5. Adding a PNG maskable icon serves /brand/maskable.png and includes it in manifest without sizes:"any".
    process.env.PLURNK_WEB_MASKABLE_ICON_FILE = pngPath;
    const mod2 = createModule();
    let handler2;
    await mod2.start({ registerHttpRoute(_prefix, serve) { handler2 = serve; } });
    const server2 = createServer(handler2);
    t.after(async () => {
        await mod2.close();
        await new Promise((resolve, reject) => server2.close((error) => error ? reject(error) : resolve()));
    });
    server2.listen(0, "127.0.0.1");
    await once(server2, "listening");
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const maskRes = await fetch(`${base2}/brand/maskable.png`);
    assert.equal(maskRes.status, 200);
    assert.equal(maskRes.headers.get("content-type"), "image/png");
    const manifest2 = await (await fetch(`${base2}/manifest.webmanifest`)).json();
    assert.deepEqual(manifest2.icons, [
        { src: "/brand/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "/brand/maskable.png", type: "image/png", purpose: "maskable" },
    ]);
});

test("{§web-settings-extensions} {§web-configuration} {§web-assets} PLURNK_WEB_SETTINGS_TABS validates strictly, rejects unsafe HTML, and serves tab scripts only on /settings/", async (t) => {
    const key = "PLURNK_WEB_SETTINGS_TABS";
    const original = process.env[key];
    t.after(() => {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
    });

    // 1. Missing floor knob throws immediately.
    delete process.env[key];
    assert.throws(createModule, { message: `${key} is missing from the assembled environment floor.` });
    process.env[key] = original;

    // 2. Invalid tab declarations fail fast with ConfigurationError.
    const invalidConfigs = [
        "not-json",
        "{}",
        JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ id: `tab-${i}`, label: `Tab ${i}`, htmlFile: `/tmp/t${i}.html` }))),
        JSON.stringify(["not-an-object"]),
        JSON.stringify([{ id: "account", label: "Account", htmlFile: "/tmp/a.html", extra: true }]),
        JSON.stringify([{ id: "Account", label: "Account", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "bad_slug", label: "Bad", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "-leading", label: "Bad", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "a".repeat(33), label: "Too Long", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "about", label: "About", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "mcp", label: "MCP", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "workspace", label: "Workspace", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([
            { id: "account", label: "Account", htmlFile: "/tmp/a.html" },
            { id: "account", label: "Duplicate", htmlFile: "/tmp/b.html" },
        ]),
        JSON.stringify([{ id: "account", label: "   ", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "account", label: "Bad\nLabel", htmlFile: "/tmp/a.html" }]),
        JSON.stringify([{ id: "account", label: "Account", htmlFile: "relative/account.html" }]),
        JSON.stringify([{ id: "account", label: "Account", htmlFile: "/tmp/account.txt" }]),
        JSON.stringify([{ id: "account", label: "Account", htmlFile: "/tmp/account.html", scriptFile: "" }]),
        JSON.stringify([{ id: "account", label: "Account", htmlFile: "/tmp/account.html", scriptFile: 42 }]),
        JSON.stringify([{ id: "account", label: "Account", htmlFile: "/tmp/account.html", scriptFile: "relative.js" }]),
        JSON.stringify([{ id: "account", label: "Account", htmlFile: "/tmp/account.html", scriptFile: "/tmp/account.mjs" }]),
    ];
    for (const badValue of invalidConfigs) {
        process.env[key] = badValue;
        assert.throws(
            createModule,
            (/** @type {any} */ error) => error?.name === "ConfigurationError" && error?.key === key,
            `expected ConfigurationError for ${badValue}`,
        );
    }
    process.env[key] = original;

    // 3. Startup loading rejects missing, empty, non-regular, invalid UTF-8, or CSP-incompatible HTML/JS files.
    const dir = await mkdtemp(new URL("../.tabs-test-", import.meta.url));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const filePath = (/** @type {string} */ name) => new URL(name, pathToFileURL(`${dir}/`)).pathname;
    const validHtml = filePath("account.html");
    const billingHtml = filePath("billing.html");
    const validJs = filePath("account.js");
    const emptyHtml = filePath("empty.html");
    const badUtf8Html = filePath("bad-utf8.html");
    const emptyJs = filePath("empty.js");
    const badUtf8Js = filePath("bad-utf8.js");
    const dirAsHtml = filePath("subdir.html");
    await mkdir(dirAsHtml);
    await writeFile(validHtml, '<header data-panel-toolbar><h2>Account</h2></header><p data-account-state>Ready</p>\n');
    await writeFile(billingHtml, '<header data-panel-toolbar><h2>Billing</h2></header><p>Plan details.</p>\n');
    await writeFile(validJs, 'export const loaded = "account-tab-ready";\n'.repeat(10));
    await writeFile(emptyHtml, "");
    await writeFile(badUtf8Html, Buffer.from([0xff, 0xfe, 0x80]));
    await writeFile(emptyJs, "");
    await writeFile(badUtf8Js, Buffer.from([0xff, 0xfe, 0x80]));

    const unsafeHtmlFixtures = /** @type {const} */ ([
        ["inline-script.html", "<p>Hi</p><script>alert(1)</script>", /<script>/u],
        ["inline-style-tag.html", "<style>p { color: red; }</style><p>Hi</p>", /inline styles/u],
        ["inline-style-attr.html", '<p style="color:red">Hi</p>', /inline styles/u],
        ["iframe.html", '<iframe src="/other"></iframe>', /<iframe>/u],
        ["object.html", '<object data="/other"></object>', /<object>/u],
        ["embed.html", '<embed src="/other">', /<embed>/u],
        ["body.html", "<body><p>Doc</p></body>", /<body>/u],
        ["onclick.html", '<button type="button" onclick="alert(1)">Go</button>', /inline event handlers/u],
        ["javascript-url.html", '<a href="javascript:alert(1)">Go</a>', /javascript: URLs/u],
    ]);
    for (const [name, content, pattern] of unsafeHtmlFixtures) {
        const unsafePath = filePath(name);
        await writeFile(unsafePath, content);
        process.env[key] = JSON.stringify([{ id: "account", label: "Account", htmlFile: unsafePath }]);
        const broken = createModule();
        let registered = false;
        await assert.rejects(
            async () => { await broken.start({ registerHttpRoute() { registered = true; } }); },
            pattern,
            name,
        );
        assert.equal(registered, false, `${name} fails before route registration`);
    }

    for (const [spec, pattern] of /** @type {const} */ ([
        [{ id: "account", label: "Account", htmlFile: filePath("missing.html") }, /ENOENT/u],
        [{ id: "account", label: "Account", htmlFile: dirAsHtml }, /not a regular file/u],
        [{ id: "account", label: "Account", htmlFile: emptyHtml }, /must not be empty/u],
        [{ id: "account", label: "Account", htmlFile: badUtf8Html }, /not valid UTF-8/u],
        [{ id: "account", label: "Account", htmlFile: validHtml, scriptFile: filePath("missing.js") }, /ENOENT/u],
        [{ id: "account", label: "Account", htmlFile: validHtml, scriptFile: emptyJs }, /must not be empty/u],
        [{ id: "account", label: "Account", htmlFile: validHtml, scriptFile: badUtf8Js }, /not valid UTF-8/u],
    ])) {
        process.env[key] = JSON.stringify([spec]);
        const broken = createModule();
        await assert.rejects(async () => { await broken.start({ registerHttpRoute() {} }); }, pattern);
    }

    // 4. Valid extension tabs serve compressed /brand/tabs/<id>.js and emit scripts/markup only on /settings/.
    process.env[key] = JSON.stringify([
        { id: "account", label: "Account", htmlFile: validHtml, scriptFile: validJs },
        { id: "billing", label: "Billing", htmlFile: billingHtml, scriptFile: null },
    ]);
    const mod = createModule();
    let handler;
    await mod.start({ registerHttpRoute(_prefix, serve) { handler = serve; } });
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    const settingsRes = await fetch(`${base}/settings/`);
    assert.equal(settingsRes.status, 200);
    assert.equal(settingsRes.headers.get("x-frame-options"), "DENY");
    assert.match(settingsRes.headers.get("content-security-policy") ?? "", /script-src 'self'[\s\S]*frame-ancestors 'none'/u);
    const settingsHtml = await settingsRes.text();
    assert.ok(settingsHtml.includes('<script type="module" src="/brand/tabs/account.js"></script>'));
    assert.ok(settingsHtml.includes('data-settings-panel="account" data-settings-extension="true"'));
    assert.ok(settingsHtml.includes('data-settings-panel="billing" data-settings-extension="true"'));

    for (const nonSettingsPath of ["/", "/search/", "/~/work", "/auth/callback", "/missing"]) {
        const html = await (await fetch(`${base}${nonSettingsPath}`)).text();
        assert.doesNotMatch(html, /\/brand\/tabs\/|data-settings-extension/u, nonSettingsPath);
    }

    const jsRes = await fetch(`${base}/brand/tabs/account.js`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(jsRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(jsRes.headers.get("content-encoding"), "gzip");
    assert.match(await jsRes.text(), /account-tab-ready/u);
    assert.equal((await fetch(`${base}/brand/tabs/account.js`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/brand/tabs/billing.js`)).status, 404);
});

test("{§web-bff-auth} {§web-configuration} {§web-browser-security} PLURNK_WEB_AUTH_* validates fail-hard and stamps BFF attributes without weakening CSP", async (t) => {
    const keys = [
        "PLURNK_WEB_AUTH_LOGIN_URL",
        "PLURNK_WEB_AUTH_LOGOUT_URL",
        "PLURNK_WEB_AUTH_LOGOUT_METHOD",
    ];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    delete process.env.PLURNK_WEB_AUTH_LOGOUT_METHOD;
    assert.throws(createModule, { message: "PLURNK_WEB_AUTH_LOGOUT_METHOD is missing from the assembled environment floor." });
    process.env.PLURNK_WEB_AUTH_LOGOUT_METHOD = original.PLURNK_WEB_AUTH_LOGOUT_METHOD;

    const invalidCases = /** @type {const} */ ([
        ["PLURNK_WEB_AUTH_LOGIN_URL", "https://idp.example/login"],
        ["PLURNK_WEB_AUTH_LOGIN_URL", "//evil.example/login"],
        ["PLURNK_WEB_AUTH_LOGIN_URL", "/\\evil.example/login"],
        ["PLURNK_WEB_AUTH_LOGIN_URL", "relative/login"],
        ["PLURNK_WEB_AUTH_LOGIN_URL", "/login#frag"],
        ["PLURNK_WEB_AUTH_LOGIN_URL", "/login with space"],
        ["PLURNK_WEB_AUTH_LOGIN_URL", "/login\nnext"],
        ["PLURNK_WEB_AUTH_LOGIN_URL", "/auth/callback"],
        ["PLURNK_WEB_AUTH_LOGOUT_URL", "https://idp.example/logout"],
        ["PLURNK_WEB_AUTH_LOGOUT_URL", "//evil.example/logout"],
        ["PLURNK_WEB_AUTH_LOGOUT_URL", "relative/logout"],
        ["PLURNK_WEB_AUTH_LOGOUT_URL", "/logout#frag"],
        ["PLURNK_WEB_AUTH_LOGOUT_URL", "/logout space"],
        ["PLURNK_WEB_AUTH_LOGOUT_METHOD", ""],
        ["PLURNK_WEB_AUTH_LOGOUT_METHOD", "DELETE"],
        ["PLURNK_WEB_AUTH_LOGOUT_METHOD", "PUT"],
    ]);
    for (const [key, badValue] of invalidCases) {
        process.env[key] = badValue;
        assert.throws(
            createModule,
            (/** @type {any} */ error) => error?.name === "ConfigurationError" && error?.key === key,
            `expected ConfigurationError for ${key}=${badValue}`,
        );
        process.env[key] = original[key];
    }

    process.env.PLURNK_WEB_AUTH_LOGIN_URL = "/oauth2/start?rd={returnTo}";
    process.env.PLURNK_WEB_AUTH_LOGOUT_URL = "/oauth2/sign_out";
    process.env.PLURNK_WEB_AUTH_LOGOUT_METHOD = "get";
    const mod = createModule();
    let handler;
    await mod.start({ registerHttpRoute(_prefix, serve) { handler = serve; } });
    const server = createServer(handler);
    t.after(async () => {
        await mod.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    for (const path of ["/", "/search/", "/settings/", "/~/work"]) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'[\s\S]*form-action 'self'[\s\S]*frame-ancestors 'none'/u);
        const html = await res.text();
        assert.ok(html.includes('data-auth-login-url="/oauth2/start?rd={returnTo}"'), path);
        assert.ok(html.includes('data-auth-logout-url="/oauth2/sign_out"'), path);
        assert.ok(html.includes('data-auth-logout-method="GET"'), path);
    }
});

test("{§web-browser-security} resolveIssuerOrigin honors loopback X-Forwarded-Host and ignores spoofed non-loopback headers", async (t) => {
    const face = { issuer: () => "https://bot.example.com/oauth" };
    assert.equal(
        resolveIssuerOrigin(face, {
            headers: { host: "127.0.0.1:1066", "x-forwarded-host": "bot.example.com" },
            socket: { remoteAddress: "127.0.0.1" },
        }),
        null,
        "same-origin issuer over loopback X-Forwarded-Host needs no external CSP entry",
    );
    assert.equal(
        resolveIssuerOrigin(face, {
            headers: { host: "127.0.0.1:1066", "x-forwarded-host": "BOT.Example.COM:443, internal.proxy" },
            socket: { remoteAddress: "::1" },
        }),
        null,
        "multi-hop, case-insensitive, default-port loopback X-Forwarded-Host matches same-origin issuer",
    );
    assert.equal(
        resolveIssuerOrigin(face, {
            headers: { host: "127.0.0.1:1066", "x-forwarded-host": "app.example.com" },
            socket: { remoteAddress: "127.0.0.1" },
        }),
        "https://bot.example.com",
        "distinct issuer over loopback X-Forwarded-Host remains an external CSP origin",
    );
    assert.equal(
        resolveIssuerOrigin(face, {
            headers: { host: "app.example.com", "x-forwarded-host": "bot.example.com" },
            socket: { remoteAddress: "203.0.113.5" },
        }),
        "https://bot.example.com",
        "non-loopback sockets ignore spoofed X-Forwarded-Host when evaluating issuer same-origin",
    );

    const mod = createModule();
    let handler;
    await mod.start({
        credentials: { face: () => face, verify: () => null },
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

    const sameOriginRes = await fetch(`${base}/`, { headers: { "x-forwarded-host": "bot.example.com" } });
    assert.equal(sameOriginRes.status, 200);
    assert.match(sameOriginRes.headers.get("content-security-policy") ?? "", /connect-src 'self';/u);
    await sameOriginRes.text();

    const crossOriginRes = await fetch(`${base}/`, { headers: { "x-forwarded-host": "other.example.com" } });
    assert.equal(crossOriginRes.status, 200);
    assert.match(crossOriginRes.headers.get("content-security-policy") ?? "", /connect-src 'self' https:\/\/bot\.example\.com;/u);
    await crossOriginRes.text();
});
