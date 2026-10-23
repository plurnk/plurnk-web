import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { engines } from "./engines.js";
import Documents from "../ai.plurnk/documents.js";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import { privateHeaders } from "../ai.plurnk/http.js";
import browserDiagnostics from "./browser-diagnostics.js";

test("{§web-worker-directory} two-line cards retain native links, lineage and disclosure without a browser controller", async (t) => {
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, contentType]) =>
        [path, { body: await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url)), contentType }])));
    const documents = new Documents(assets.get("/index.html").body.toString(), false, 128);
    let html;
    const requests = [];
    const server = createServer((request, response) => {
        const path = new URL(request.url, "http://fixture.invalid").pathname;
        requests.push(path);
        const asset = assets.get(path) ?? (path.startsWith("/~/") ? { body: html, contentType: "text/html" } : null);
        response.writeHead(asset ? 200 : 404, { ...privateHeaders, "content-type": asset?.contentType ?? "text/plain" });
        response.end(asset?.body ?? "Not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const workers = [
        { id: 1, name: "_plurnk", parentWorkerId: null, origin: "_plurnk", kind: "root", lifecycle: "idle" },
        { id: 3, name: "child", parentWorkerId: 2, origin: "model", kind: "work", lifecycle: "parked" },
        { id: 2, name: "parent", parentWorkerId: null, origin: "model", kind: "root", lifecycle: "running" },
        { id: 4, name: "leaf", parentWorkerId: 3, origin: "model", kind: "fork", lifecycle: "failed" },
        { id: 5, name: "background", parentWorkerId: 1, origin: "model", kind: "work", lifecycle: "queued" },
        { id: 6, name: "done", parentWorkerId: null, origin: "model", kind: "root", lifecycle: "completed" },
        { id: 7, name: "cancelled", parentWorkerId: null, origin: "model", kind: "root", lifecycle: "cancelled" },
        { id: 8, name: "idle", parentWorkerId: null, origin: "model", kind: "root", lifecycle: "idle" },
    ];
    for (const engine of engines) await t.test(engine.name(), async () => {
        const browser = await engine.launch();
        try {
            for (const javaScriptEnabled of [false, true]) {
                const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
                try {
                    const checkBrowser = browserDiagnostics(context);
                    requests.length = 0;
                    const page = await context.newPage();
                    for (const project_root of [null, "/srv/project"]) {
                        const name = `~/research/<script>&"${"long-".repeat(12)}`;
                        const workspacePath = directoryPath({ kind: "workspace", workspace: name });
                        html = await documents.read({ kind: "workspace", workspace: name }, {
                            listWorkspaces: async () => [{ id: 7, name, project_root, project_label: project_root }],
                            listWorkers: async () => workers,
                        }, false);
                        await page.goto(new URL(workspacePath, base).href);
                        const link = (name) => page.locator(`main a[data-worker-link][aria-label=${JSON.stringify(name)}]`);
                        const card = (name) => link(name).locator("xpath=ancestor::article[1]");
                        const parent = card("parent");
                        const summary = parent.locator(":scope > details > summary");
                        assert.equal(await summary.count(), 1, "the identity is the native disclosure, not a child-count teaser");
                        assert.equal(await link("_plurnk").count(), 0);
                        assert.equal(await page.locator('main a[data-worker-link]').count(), workers.length - 1);
                        assert.equal(await parent.locator(':scope > details > summary [data-worker-workspace] a').textContent(), name);
                        assert.equal(await parent.locator(':scope > details > summary [data-worker-workspace] a').getAttribute("href"), workspacePath);
                        const folder = parent.locator(':scope > details > summary [data-worker-workspace] [role="img"]');
                        assert.equal(await folder.getAttribute("aria-label"), project_root === null ? "Folderless workspace" : "Project workspace");
                        assert.match(await folder.evaluate((element) => getComputedStyle(element, "::before").content), project_root === null ? /☁️/u : /🗂️/u);
                        assert.equal(await link("child").isVisible(), false);
                        assert.equal(await card("done").locator(":scope > details").count(), 0, "a leaf has no fabricated answer or empty disclosure");
                        assert.equal(await card("done").locator(":scope > header").count(), 1);
                        for (const colorScheme of ["light", "dark"]) {
                            await page.emulateMedia({ colorScheme });
                            for (const width of [320, 1280]) {
                                await page.setViewportSize({ width, height: 844 });
                                await summary.focus();
                                await page.keyboard.press("Enter");
                                assert.equal(await link("child").isVisible(), true);
                                assert.equal(await link("leaf").isVisible(), false);
                                assert.equal(await card("child").locator(':scope > details > summary [data-worker-parent] a').textContent(), "parent");
                                for (const [worker, glyph] of [["parent", "⌛"], ["child", "💤"], ["done", "✓"], ["cancelled", "🛑"], ["idle", "○"]]) {
                                    const status = card(worker).locator(':scope > header, :scope > details > summary').locator('[data-lifecycle]');
                                    const expected = workers.find(({ name }) => name === worker).lifecycle;
                                    assert.equal(await status.getAttribute("aria-label"), expected);
                                    assert.equal(await status.getAttribute("title"), expected);
                                    assert.ok((await status.evaluate((element) => getComputedStyle(element, "::before").content)).includes(glyph));
                                }
                                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth), true);
                                await summary.press("Space");
                                assert.equal(await link("child").isVisible(), false);
                            }
                        }
                        const before = requests.length;
                        await summary.press("Enter");
                        await card("child").locator(":scope > details > summary").press("Space");
                        assert.equal(await link("leaf").isVisible(), true);
                        assert.equal(requests.length, before, "native expansion makes no requests, including with JavaScript enabled");
                        const popup = context.waitForEvent("page");
                        await link("parent").click({ modifiers: ["Control"] });
                        const tab = await popup;
                        await tab.waitForLoadState();
                        assert.equal(await parent.locator(":scope > details").getAttribute("open"), "", "a real ant link does not toggle its enclosing summary");
                        await tab.close();
                        await parent.locator(':scope > details > summary [data-worker-workspace] a').click();
                        assert.equal(new URL(page.url()).pathname, workspacePath);
                        assert.equal(await page.locator('main [data-connection-indicator], main [role="tree"], main [data-text="worker-kind"]').count(), 0);
                        assert.equal(requests.some((path) => path.startsWith("/agui")), false, "directory browsing does not start conversation observation");
                    }
                    checkBrowser();
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    });
});
