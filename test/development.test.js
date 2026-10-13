import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

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
