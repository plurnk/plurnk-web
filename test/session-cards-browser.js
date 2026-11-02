import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { engines } from "./engines.js";
import Documents from "../ai.plurnk/documents.js";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import { privateHeaders } from "../ai.plurnk/http.js";
import browserDiagnostics from "./browser-diagnostics.js";

export default async function verifySessionCards(t) {
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
    const sessions = [
        { id: 1, name: "_plurnk", parentSessionId: null, origin: "_plurnk", kind: "root", lifecycle: "idle", hidden_at: null },
        { id: 3, name: "child", parentSessionId: 2, origin: "model", kind: "work", lifecycle: "parked", hidden_at: null },
        { id: 2, name: "parent", parentSessionId: null, origin: "model", kind: "root", lifecycle: "running", hidden_at: null },
        { id: 4, name: "leaf", parentSessionId: 3, origin: "model", kind: "fork", lifecycle: "failed", hidden_at: null },
        { id: 5, name: "background", parentSessionId: 1, origin: "model", kind: "work", lifecycle: "queued", hidden_at: null },
        { id: 6, name: "done", parentSessionId: null, origin: "model", kind: "root", lifecycle: "completed", hidden_at: null },
        { id: 7, name: "cancelled", parentSessionId: null, origin: "model", kind: "root", lifecycle: "cancelled", hidden_at: null },
        { id: 8, name: "idle", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", hidden_at: null },
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
                            listWorkspaces: async () => [{ id: 7, name, project_root, project_label: project_root, hidden_at: null }],
                            listSessions: async () => sessions,
                        }, false);
                        await page.goto(new URL(workspacePath, base).href);
                        if (!javaScriptEnabled) {
                            // {§web-session-creation} {§web-workspace-rename} {§web-workspace-hide} Without scripting each form is a card in main:
                            // it takes only its own space, inside main's measure.
                            const boxes = await page.locator("main > dialog").evaluateAll((dialogs) => dialogs.map((dialog) => {
                                const box = dialog.getBoundingClientRect(), card = dialog.firstElementChild.getBoundingClientRect();
                                const main = dialog.parentElement.getBoundingClientRect();
                                return [dialog.id, Math.abs(box.height - card.height) < 1, box.left >= main.left && box.right <= main.right];
                            }));
                            assert.deepEqual(boxes, [["dialog-workspace-rename", true, true], ["dialog-workspace-hide", true, true], ["dialog-session-create", true, true]]);
                        }
                        const link = (name) => page.locator(`main a[data-session-link][aria-label=${JSON.stringify(name)}]`);
                        const card = (name) => link(name).locator("xpath=ancestor::article[1]");
                        const parent = card("parent");
                        const summary = parent.locator(":scope > details > summary");
                        assert.equal(await summary.count(), 1, "the identity is the native disclosure, not a child-count teaser");
                        assert.equal(await link("_plurnk").count(), 0);
                        assert.equal(await page.locator('main a[data-session-link]').count(), sessions.length - 1);
                        assert.equal(await parent.locator(':scope > details > summary [data-session-workspace] a').textContent(), name);
                        assert.equal(await parent.locator(':scope > details > summary [data-session-workspace] a').getAttribute("href"), workspacePath);
                        const folder = parent.locator(':scope > details > summary [data-session-workspace] [role="img"]');
                        assert.equal(await folder.getAttribute("aria-label"), project_root === null ? "Folderless workspace" : "Project workspace");
                        assert.match(await folder.evaluate((element) => getComputedStyle(element, "::before").content), project_root === null ? /☁️/u : /🗂️/u);
                        assert.equal(await link("child").isVisible(), false);
                        assert.equal(await card("done").locator(":scope > details").count(), 0, "a leaf has no fabricated answer or empty disclosure");
                        assert.equal(await card("done").locator(":scope > header").count(), 1);
                        for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
                            await page.emulateMedia({ colorScheme });
                            for (const width of [320, 1280]) {
                                await page.setViewportSize({ width, height: 844 });
                                await summary.focus();
                                await page.keyboard.press("Enter");
                                assert.equal(await link("child").isVisible(), true);
                                assert.equal(await link("leaf").isVisible(), false);
                                assert.equal(await card("child").locator(':scope > details > summary [data-session-parent] a').textContent(), "parent");
                                for (const [session, glyph] of [["parent", "⌛"], ["child", "💤"], ["done", "✓"], ["cancelled", "🛑"], ["idle", "○"]]) {
                                    const status = card(session).locator(':scope > header, :scope > details > summary').locator('[data-lifecycle]');
                                    const expected = sessions.find(({ name }) => name === session).lifecycle;
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
                        const sessionPath = directoryPath({ kind: "session", workspace: name, session: "parent" });
                        if (javaScriptEnabled) {
                            await parent.locator(":scope > details").evaluate((details) => {
                                addEventListener("click", () => {
                                    queueMicrotask(() => { window.name = String(details.open); });
                                }, { once: true });
                            });
                        }
                        await link("parent").click();
                        assert.equal(new URL(page.url()).pathname, sessionPath);
                        if (javaScriptEnabled) {
                            assert.equal(await page.evaluate(() => window.name), "true", "a real ant link does not toggle its enclosing summary");
                        }
                        await summary.press("Enter");
                        await parent.locator(':scope > details > summary [data-session-workspace] a').click();
                        assert.equal(new URL(page.url()).pathname, workspacePath);
                        assert.equal(await page.locator('main [data-connection-indicator], main [role="tree"], main [data-text="session-kind"]').count(), 0);
                        assert.equal(requests.some((path) => path.startsWith("/acp")), false, "directory browsing does not start conversation observation");
                    }
                    checkBrowser();
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    });
}
