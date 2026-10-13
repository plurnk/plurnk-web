import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { build, createServer, preview } from "vite";
import verifyDirectories from "./directories.js";

test("{§web-build} development reloads HTML and hot-updates CSS without the daemon", { timeout: 30_000 }, async () => {
    // Keep dependency resolution local while editing only a disposable source copy.
    const directory = await mkdtemp(new URL("../.vite-test-", import.meta.url));
    let server;
    let browser;
    try {
        const root = join(directory, "web");
        await cp(new URL("../web/", import.meta.url), root, { recursive: true });
        server = await createServer({
            configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)),
            root,
            cacheDir: join(directory, ".cache"),
            logLevel: "error",
            server: { port: 0 },
        });
        await server.listen();
        const address = server.httpServer.address();
        assert.equal(address.address, "127.0.0.1");
        browser = await chromium.launch();
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const connected = page.waitForEvent("console", { predicate: (message) => message.text().includes("[vite] connected") });
        await page.goto(`http://127.0.0.1:${address.port}/`);
        await connected;
        assert.equal(await page.locator("main h1").innerText(), "Hello world");
        assert.equal(await page.locator('script[src="/@vite/client"]').count(), 1);
        assert.deepEqual(await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
            ["vendor", "structure", "style", "state"].map((name) => `/styles/app-${name}.css`));

        const html = join(root, "index.html");
        await writeFile(html, (await readFile(html, "utf8")).replace("Hello world", "Live reload works"));
        await page.waitForFunction(() => document.querySelector("main h1")?.textContent === "Live reload works");
        await page.evaluate(() => { document.body.dataset.reloadSentinel = "unchanged"; });
        const styles = join(root, "styles", "app-style.css");
        await writeFile(styles, (await readFile(styles, "utf8")) + "\n:root { --live-test: ready; }\n");
        await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--live-test").trim() === "ready");
        assert.equal(await page.locator("body").getAttribute("data-reload-sentinel"), "unchanged", "CSS updates preserve the page");
        assert.equal((await page.request.get(new URL("/manifest.webmanifest", page.url()).href)).status(), 200);
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        await server?.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("{§web-index-documents} Vite dev and compiled preview preserve native directory navigation", { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(new URL("../.vite-test-", import.meta.url));
    const root = join(directory, "web");
    const outDir = join(directory, "dist");
    const configFile = fileURLToPath(new URL("../vite.config.js", import.meta.url));
    let development;
    let compiled;
    let browser;
    try {
        await cp(new URL("../web/", import.meta.url), root, { recursive: true });
        const template = (await readFile(join(root, "index.html"), "utf8")).replace('<h1 data-i18n="greeting">', '<h1 id="greeting" data-i18n="greeting">');
        await writeFile(join(root, "index.html"), template.replace("</main>", '<a href="nested/?q=one%2Ftwo#greeting" data-i18n="child">Nested document</a></main>'));
        await mkdir(join(root, "nested"));
        await mkdir(join(root, "public", "nested"));
        await writeFile(join(root, "nested", "index.html"), template.replace("Hello world", "Nested document")
            .replace("</main>", '<a href="./index.html" data-i18n="index">Explicit index</a><a href="child.txt" data-i18n="asset">Child resource</a><a href="../" data-i18n="parent">Parent</a></main>'));
        await writeFile(join(root, "public", "nested", "child.txt"), "Child resource\n");
        development = await createServer({ configFile, root, cacheDir: join(directory, ".cache"), logLevel: "error", server: { port: 0 } });
        await development.listen();
        await build({
            configFile, root, logLevel: "error",
            build: { outDir, rolldownOptions: { input: [join(root, "index.html"), join(root, "nested", "index.html")] } },
        });
        compiled = await preview({ configFile, root, logLevel: "error", build: { outDir }, preview: { port: 0 } });
        browser = await chromium.launch();
        for (const server of [development, compiled]) {
            const base = `http://127.0.0.1:${server.httpServer.address().port}`;
            await verifyDirectories(base);
            for (const javaScriptEnabled of [false, true]) {
                const context = await browser.newContext({ javaScriptEnabled });
                try {
                    const page = await context.newPage();
                    const errors = [];
                    const navigations = [];
                    page.on("pageerror", (error) => errors.push(error.message));
                    page.on("request", (request) => { if (request.isNavigationRequest()) navigations.push(request.url()); });
                    await page.goto(`${base}/`);
                    if (javaScriptEnabled) await page.evaluate(() => import(document.querySelector('script[type="module"]').src));
                    await page.getByRole("link", { name: "Nested document" }).click();
                    await page.waitForURL(`${base}/nested/?q=one%2Ftwo#greeting`);
                    assert.equal(await page.locator("h1").innerText(), "Nested document");
                    assert.ok(navigations.some((url) => url.includes("/nested/?q=")), "link requests the document instead of replacing it in JavaScript");
                    await page.reload();
                    assert.equal(await page.locator("h1").innerText(), "Nested document");
                    await page.getByRole("link", { name: "Explicit index" }).click();
                    await page.waitForURL(`${base}/nested/index.html`);
                    assert.equal(await page.locator("h1").innerText(), "Nested document");
                    await page.getByRole("link", { name: "Child resource" }).click();
                    await page.waitForURL(`${base}/nested/child.txt`);
                    assert.match(await page.locator("body").innerText(), /Child resource/u);
                    await page.goBack();
                    assert.equal(page.url(), `${base}/nested/index.html`);
                    await page.goForward();
                    assert.equal(page.url(), `${base}/nested/child.txt`);
                    await page.goBack();
                    await page.getByRole("link", { name: "Parent" }).click();
                    await page.waitForURL(`${base}/`);
                    assert.equal(await page.locator("h1").innerText(), "Hello world");
                    assert.deepEqual(errors, []);
                } finally {
                    await context.close();
                }
            }
        }
    } finally {
        await browser?.close();
        await development?.close();
        if (compiled) await new Promise((resolve, reject) => compiled.httpServer.close((error) => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});
