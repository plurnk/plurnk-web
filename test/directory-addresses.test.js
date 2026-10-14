import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import { directoryPath, parseDirectory } from "../ai.plurnk/directory-addresses.js";
import createModule from "../ai.plurnk/module.js";

process.env.PLURNK_AUTH = "0";

const directories = [
    [{ kind: "daemon" }, "/~/"],
    ...[
        ["~/ptl/project", "~/ptl/project"],
        ["/home/user/project", "/home/user/project"],
        ["plain", "plain"],
        ["Plain", "Plain"],
        ["a@b", "a%40b"],
        ["a%40b", "a%2540b"],
        ["%", "%25"],
        ["%2E%2E", "%252E%252E"],
        ["a%2Fb", "a%252Fb"],
        ["a/b", "a/b"],
        ["a//b/", "a//b/"],
        ["/", "/"],
        ["//", "//"],
        [" ", "%20"],
        [" space ", "%20space%20"],
        ["a?b#c", "a%3Fb%23c"],
        ["a\\b", "a%5Cb"],
        ["café", "caf%C3%A9"],
        ["cafe\u0301", "cafe%CC%81"],
        ["分析/🐹", "%E5%88%86%E6%9E%90/%F0%9F%90%B9"],
        ["~", "~"],
        ["a~b", "a~b"],
        [".config/.../file.txt", ".config/.../file.txt"],
        ["index.html", "index.html"],
        ["a/index.html/", "a/index.html/"],
        ["a\u0000\t\n\rb", "a%00%09%0A%0Db"],
        ['<a href="x">&</a>', "%3Ca%20href%3D%22x%22%3E%26%3C/a%3E"],
    ].flatMap(([workspace, encoded]) => [
        [{ kind: "workspace", workspace }, `/~/${encoded}/`],
        [{ kind: "worker", workspace, worker: "user_1" }, `/~/${encoded}@user_1/`],
    ]),
];

test("{§web-directory-addresses} generated paths preserve exact identities through URL parsing", () => {
    const seen = new Set();
    for (const [directory, expected] of directories) {
        const path = directoryPath(directory);
        assert.equal(path, expected, JSON.stringify(directory));
        assert.ok(!seen.has(path), `distinct identities must not share ${path}`);
        seen.add(path);
        for (const suffix of ["", "index.html", "?q=%2F@other#fragment", "index.html?q=%2F@other#fragment"]) {
            const url = new URL(`${path}${suffix}`, "https://example.test");
            assert.equal(url.origin, "https://example.test");
            assert.equal(url.pathname, path + (suffix.startsWith("index.html") ? "index.html" : ""));
            assert.deepEqual(parseDirectory(url.pathname + url.search + url.hash), directory, url.href);
        }
    }
});

test("{§web-directory-addresses} delimiters precede one decoding pass", () => {
    for (const path of ["/%7E/a%2fb/", "/%7e/a%2Fb/index.html", "/~/a/b/"]) {
        assert.deepEqual(parseDirectory(path), { kind: "workspace", workspace: "a/b" }, path);
    }
    assert.deepEqual(parseDirectory("/~/a%40b@user_1/"), { kind: "worker", workspace: "a@b", worker: "user_1" });
    assert.deepEqual(parseDirectory("/~/a%2540b/"), { kind: "workspace", workspace: "a%40b" });
    assert.deepEqual(parseDirectory("/~/a/%252e%252e/"), { kind: "workspace", workspace: "a/%2e%2e" });
    assert.deepEqual(parseDirectory("/~/a@%75ser_1/"), { kind: "worker", workspace: "a", worker: "user_1" });
    assert.equal(directoryPath({ kind: "worker", workspace: "a", worker: "_plurnk" }), "/~/a@_plurnk/");
});

test("{§web-directory-addresses} unrepresentable legacy names are not repaired or aliased", () => {
    for (const workspace of ["", ".", "..", "a/./b", "../a", "a/..", "a//../", "\ud800", "a\udfff"]) {
        for (const directory of [{ kind: "workspace", workspace }, { kind: "worker", workspace, worker: "user" }]) {
            assert.equal(directoryPath(directory), null, JSON.stringify(directory));
        }
    }
    for (const worker of ["", "\ud800"]) {
        assert.equal(directoryPath({ kind: "worker", workspace: "a", worker }), null);
    }
    for (const path of [
        "/", "/index.html", "/~", "/@/a/", "/~myHome/a/", "https://example.test/~/a/",
        "/~/a", "/~/a@user", "/~/@user/", "/~/a@/", "/~/a@user@other/", "/~/a@user/child/",
        "/~/a@user/asset.txt", "/~/./", "/~/a/../", "/~/a/%2E/", "/~/a%2F..%2fb/",
        "/~/%/", "/~/%GG/", "/~/%c0%af/", "/~/%ED%A0%80/", "/~/a@%GG/",
    ]) {
        assert.equal(parseDirectory(path), null, path);
    }
});

test("{§web-directory-addresses} native links round-trip through production, Vite dev and preview fixtures", { timeout: 90_000 }, async (t) => {
    const source = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    const compiled = await readFile(new URL("../ai.plurnk/dist/index.html", import.meta.url), "utf8");
    // Test documents only: no workspace enumeration, authentication or product route is simulated.
    const document = (template, directory) => template.replace("</main>", `<pre id="address" data-text="address">${
        JSON.stringify(directory).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    }</pre><ul>${directories.map(([entry], index) => `<li><a href="${directoryPath(entry)}" data-i18n="case-${index}">Case ${index}</a></li>`).join("")}</ul>
        <a href="./index.html" data-i18n="explicit">Explicit index</a>
        <a href="?query=%2F%40#address" data-i18n="query">Query and fragment</a></main>`);
    const respond = (res, html) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
    };
    let assets;
    await createModule().start({ registerHttpRoute(_prefix, handler) { assets = handler; } });
    const production = createHttpServer((req, res) => {
        const directory = parseDirectory(req.url);
        if (directory) respond(res, document(compiled, directory));
        else assets(req, res);
    });
    t.after(() => new Promise((resolve, reject) => production.close((error) => error ? reject(error) : resolve())));
    production.listen(0, "127.0.0.1");
    await once(production, "listening");

    const configFile = fileURLToPath(new URL("../vite.config.js", import.meta.url));
    const fixtures = {
        name: "directory-address-test-documents",
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const directory = parseDirectory(req.url);
                if (!directory) return next();
                try {
                    respond(res, await server.transformIndexHtml(req.url, document(source, directory)));
                } catch (error) { next(error); }
            });
        },
        configurePreviewServer(server) {
            server.middlewares.use((req, res, next) => {
                const directory = parseDirectory(req.url);
                if (directory) respond(res, document(compiled, directory));
                else next();
            });
        },
    };
    const development = await createServer({ configFile, logLevel: "error", server: { port: 0 }, plugins: [fixtures] });
    t.after(() => development.close());
    await development.listen();
    const built = await preview({ configFile, logLevel: "error", preview: { port: 0 }, plugins: [fixtures] });
    t.after(() => new Promise((resolve, reject) => built.httpServer.close((error) => error ? reject(error) : resolve())));
    const browser = await chromium.launch();
    t.after(() => browser.close());

    for (const server of [production, development.httpServer, built.httpServer]) {
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const javaScriptEnabled of [false, true]) {
            const context = await browser.newContext({ javaScriptEnabled });
            try {
                const page = await context.newPage();
                const errors = [];
                const navigations = [];
                page.on("pageerror", (error) => errors.push(error.message));
                page.on("request", (request) => { if (request.isNavigationRequest()) navigations.push(request.url()); });
                await page.goto(`${base}/~/`);
                for (const [index, [directory, path]] of directories.entries()) {
                    if (javaScriptEnabled) await page.evaluate(() => import(document.querySelector('script[type="module"]').src));
                    const before = navigations.length;
                    await page.getByRole("link", { name: `Case ${index}`, exact: true }).click();
                    assert.equal(page.url(), base + path);
                    assert.equal(navigations.length, before + 1, "a real document request, not a pushState shell");
                    assert.deepEqual(JSON.parse(await page.locator("#address").innerText()), directory);
                }
                const [directory, path] = directories.at(-1);
                await page.reload();
                assert.deepEqual(JSON.parse(await page.locator("#address").innerText()), directory);
                await page.getByRole("link", { name: "Explicit index", exact: true }).click();
                assert.equal(page.url(), `${base}${path}index.html`);
                assert.deepEqual(JSON.parse(await page.locator("#address").innerText()), directory);
                await page.getByRole("link", { name: "Query and fragment", exact: true }).click();
                assert.equal(page.url(), `${base}${path}index.html?query=%2F%40#address`);
                assert.deepEqual(JSON.parse(await page.locator("#address").innerText()), directory);
                await page.goBack();
                assert.equal(page.url(), `${base}${path}index.html`);
                await page.goForward();
                assert.deepEqual(JSON.parse(await page.locator("#address").innerText()), directory);
                assert.deepEqual(errors, []);
            } finally {
                await context.close();
            }
        }
    }
});
