import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { engines } from "./engines.js";
import Documents from "../src/documents.js";
import { directoryPath } from "../src/directory-addresses.js";
import { privateHeaders } from "../src/http.js";
import browserDiagnostics from "./browser-diagnostics.js";

export default async function verifySessionCards(t) {
    const inventory = JSON.parse(await readFile(new URL("../dist/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, contentType]) =>
        [path, { body: await readFile(new URL(`../dist/${file}`, import.meta.url)), contentType }])));
    const documents = new Documents(assets.get("/index.html").body.toString(), false, 128);
    /** @type {((url: URL) => Promise<Buffer>) | null} */
    let renderSearch = null;
    const requests = [];
    /** @type {{ path: string, search: string, authorization: string | null }[]} */
    const notificationRequests = [];
    /** @type {Set<import("node:http").ServerResponse>} */
    const sseStreams = new Set();
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, "http://fixture.invalid");
        const path = url.pathname;
        requests.push(path + url.search);
        if (path === "/auth/token" && request.method === "POST") {
            response.writeHead(200, { ...privateHeaders, "content-type": "application/json" });
            response.end(JSON.stringify({ access_token: "overview-token", token_type: "Bearer", expires_in: 300 }));
            return;
        }
        if ((path === "/notifications" || path.startsWith("/notifications/")) && request.method === "GET") {
            notificationRequests.push({
                path,
                search: url.search,
                authorization: request.headers.authorization ?? null,
            });
            response.writeHead(200, {
                ...privateHeaders,
                "content-type": "text/event-stream; charset=utf-8",
                connection: "keep-alive",
            });
            response.write(": heartbeat\n\n");
            sseStreams.add(response);
            request.on("close", () => sseStreams.delete(response));
            return;
        }
        const isDocument = ((path === "/" || path === "/search/") && renderSearch !== null) || path.startsWith("/~/");
        const docBody = isDocument && renderSearch ? await renderSearch(url) : null;
        const asset = docBody ? { body: docBody, contentType: "text/html" } : assets.get(path);
        const headers = docBody
            ? { ...privateHeaders, "content-type": asset?.contentType ?? "text/plain" }
            : { "content-type": asset?.contentType ?? "text/plain", ...(asset ? { "cache-control": "public, max-age=31536000, immutable" } : privateHeaders) };
        response.writeHead(asset ? 200 : 404, headers);
        response.end(asset?.body ?? "Not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const sessions = [
        { id: 1, name: "_plurnk", parentSessionId: null, origin: "_plurnk", kind: "root", lifecycle: "idle", archived_at: null },
        { id: 3, name: "child", parentSessionId: 2, origin: "model", kind: "work", lifecycle: "parked", archived_at: null },
        { id: 2, name: "parent", parentSessionId: null, origin: "model", kind: "root", lifecycle: "running", archived_at: null },
        { id: 4, name: "leaf", parentSessionId: 3, origin: "model", kind: "fork", lifecycle: "failed", archived_at: null },
        { id: 5, name: "background", parentSessionId: 1, origin: "model", kind: "work", lifecycle: "queued", archived_at: null },
        { id: 6, name: "done", parentSessionId: null, origin: "model", kind: "root", lifecycle: "completed", archived_at: null },
        { id: 7, name: "cancelled", parentSessionId: null, origin: "model", kind: "root", lifecycle: "cancelled", archived_at: null },
        { id: 8, name: "untouched-draft", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", archived_at: null },
        { id: 9, name: "planned", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", title: "Planned task", archived_at: null },
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
                        renderSearch = (url) => documents.search(false, {
                            listWorkspaces: async () => [{ id: 7, name, project_root, project_label: project_root, archived_at: null }],
                            listSessions: async () => sessions,
                        }, {
                            q: url.searchParams.get("q") ?? undefined,
                            status: url.searchParams.get("status") ?? undefined,
                        });
                        await page.goto(new URL("/search/", base).href);
                        if (!javaScriptEnabled) {
                            const boxes = await page.locator("main > dialog").evaluateAll((dialogs) => dialogs.map((dialog) => {
                                const box = dialog.getBoundingClientRect(), card = dialog.firstElementChild.getBoundingClientRect();
                                const main = dialog.parentElement.getBoundingClientRect();
                                return [dialog.id, Math.abs(box.height - card.height) < 1, box.left >= main.left && box.right <= main.right];
                            }));
                            assert.deepEqual(boxes, [["dialog-workspaces", true, true], ["dialog-workspace-create", true, true]]);
                        }
                        const wsArticle = page.locator('#search-workspaces > ul > li[data-directory-entry="workspace"][data-workspace-id="7"] > article');
                        assert.equal(await wsArticle.getAttribute("aria-label"), project_root === null ? "Folderless workspace" : "Project workspace");
                        assert.match(
                            await wsArticle.locator(":scope > header").evaluate((el) => getComputedStyle(el, "::before").content),
                            project_root === null ? /☁️/u : /🗂️/u,
                        );
                        assert.equal(await wsArticle.locator(':scope > header > a[data-text="name"]').textContent(), name);
                        assert.equal(await wsArticle.locator(':scope > header > a[data-text="name"]').getAttribute("href"), workspacePath);

                        const link = (sName) => wsArticle.locator(`a[data-session-link][aria-label=${JSON.stringify(sName)}]`);
                        const card = (sName) => link(sName).locator("xpath=ancestor::article[1]");
                        const parent = card("parent");
                        const summary = parent.locator(":scope > details > summary");
                        assert.equal(await summary.count(), 1, "the identity is the native disclosure for child subagents");
                        assert.equal(await link("_plurnk").count(), 0);
                        assert.equal(await link("untouched-draft").count(), 0, "untouched 0-loop draft stays hidden");
                        assert.equal(await wsArticle.locator("a[data-session-link]").count(), 7);
                        assert.equal(await link("child").isVisible(), false);
                        assert.equal(await card("done").locator(":scope > details").count(), 0, "a leaf has no empty or reply-fetch disclosure");
                        assert.equal(await card("done").locator(":scope > header").count(), 1);
                        await summary.focus();
                        await page.keyboard.press("Enter");
                        assert.equal(await link("child").isVisible(), true);
                        assert.equal(await link("leaf").isVisible(), false);
                        assert.equal(await card("child").locator(':scope > details > summary [data-session-parent] a').textContent(), "parent");
                        for (const [sessionName, glyph] of [["parent", "⌛"], ["child", "💤"], ["done", "✓"], ["cancelled", "🛑"], ["planned", "○"]]) {
                            const status = card(sessionName).locator(":scope > header, :scope > details > summary").locator("[data-lifecycle]");
                            const expected = sessions.find((s) => s.name === sessionName).lifecycle;
                            assert.equal(await status.getAttribute("aria-label"), expected);
                            assert.equal(await status.getAttribute("title"), expected);
                            assert.ok((await status.evaluate((element) => getComputedStyle(element, "::before").content)).includes(glyph));
                        }
                        for (const [colorScheme, width] of /** @type {const} */ ([["light", 320], ["dark", 1280]])) {
                            await page.emulateMedia({ colorScheme });
                            await page.setViewportSize({ width, height: 844 });
                            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth), true);
                        }
                        await summary.press("Space");
                        assert.equal(await link("child").isVisible(), false);
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
                        assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, sessionPath);
                        if (javaScriptEnabled) {
                            assert.equal(await page.evaluate(() => window.name), "true", "a real session link does not toggle its enclosing summary");
                        }
                        await page.goBack();
                        await wsArticle.locator(':scope > header > a[data-text="name"]').click();
                        assert.equal(new URL(page.url()).pathname, workspacePath);
                        assert.equal(await page.locator('main [data-connection-indicator], main [role="tree"], main [data-text="session-kind"]').count(), 0);
                        assert.equal(requests.some((reqPath) => reqPath.startsWith("/acp")), false, "directory browsing does not start conversation observation");
                    }
                    checkBrowser();
                } finally { await context.close(); }
            }
            const liveContext = await browser.newContext({ javaScriptEnabled: true, viewport: { width: 1024, height: 844 } });
            try {
                const checkLive = browserDiagnostics(liveContext);
                const page = await liveContext.newPage();
                const overviewData = {
                    workspaces: [{ id: 7, name: "work", project_root: null, project_label: null, projectRoot: null, archived_at: null }],
                    sessions: [
                        { id: 2, workspaceId: 7, name: "parent", parentSessionId: null, origin: "model", kind: "root", lifecycle: "running", gates: 1, title: "Root task", archived_at: null, reply: { id: 10, coordinate: "1/1/1/send:10", completion: /** @type {const} */ (200), at: Date.now() - 120_000, excerpt: "Parent preview line", continued: false } },
                        { id: 3, workspaceId: 7, name: "child", parentSessionId: 2, origin: "model", kind: "work", lifecycle: "parked", gates: 0, archived_at: null, reply: null },
                        { id: 6, workspaceId: 7, name: "done", parentSessionId: null, origin: "model", kind: "fork", lifecycle: "completed", gates: 0, archived_at: null, reply: { id: 20, coordinate: "1/2/1/done:20", completion: /** @type {const} */ (200), at: Date.now() - 30_000, excerpt: "Delivered reply preview", continued: true } },
                    ],
                };
                let nextEventId = 0;
                const emitNotification = (event, workspaceId, sessionId, data) => {
                    const id = ++nextEventId;
                    const payload = { id, event, timestamp: Date.now(), workspaceId, sessionId, data };
                    for (const stream of sseStreams) {
                        stream.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
                    }
                };
                notificationRequests.length = 0;
                renderSearch = (url) => documents.search(true, {
                    listWorkspaces: async () => overviewData.workspaces,
                    listSessions: async () => overviewData.sessions,
                    readSessionOverview: async () => overviewData,
                    listSessionLoops: async ({ sessionId }) => sessionId === 6
                        ? [{ prompt: "Compare fork benchmark latency" }, { prompt: "Inspect p99 tail spike in WebSocket pool" }]
                        : [],
                }, {
                    q: url.searchParams.get("q") ?? undefined,
                    status: url.searchParams.get("status") ?? undefined,
                });
                requests.length = 0;
                await page.goto(new URL("/search/", base).href);
                await page.locator('main[data-connection="connected"]').waitFor();
                assert.equal(notificationRequests.length, 1);
                assert.equal(notificationRequests[0].authorization, "Bearer overview-token");
                assert.equal(notificationRequests[0].path, "/notifications");
                assert.equal(notificationRequests[0].search, "");
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), false);

                const rootNames = () => page.locator("#search-workspaces ul[data-workspace-sessions] > li > article > header [data-session-link], #search-workspaces ul[data-workspace-sessions] > li > article > details > summary [data-session-link]")
                    .evaluateAll((links) => links.map((el) => el.getAttribute("aria-label")));
                assert.deepEqual(await rootNames(), ["done", "parent"]);

                const card = (sName) => page.locator(`#search-workspaces a[data-session-link][aria-label=${JSON.stringify(sName)}]`).locator("xpath=ancestor::article[1]");
                const cardHead = (sName) => card(sName).locator(":scope > header, :scope > details > summary");
                assert.equal(await card("done").locator(":scope > details").count(), 0, "completed leaf has no reply-fetch disclosure");
                assert.equal(await card("parent").locator(":scope > details").count(), 1, "parent with child subagent keeps disclosure");

                // Session kind glyphs, headlines, handle badges, relative timestamps, excerpts, and filter controls
                assert.match(await page.locator('#search-workspaces a[data-session-link][aria-label="parent"]').evaluate((el) => getComputedStyle(el, "::before").content), /💬/u);
                assert.match(await page.locator('#search-workspaces a[data-session-link][aria-label="child"]').evaluate((el) => getComputedStyle(el, "::before").content), /🐜/u);
                assert.match(await page.locator('#search-workspaces a[data-session-link][aria-label="done"]').evaluate((el) => getComputedStyle(el, "::before").content), /🔱/u);
                assert.equal(await cardHead("parent").locator("[data-session-headline]").textContent(), "Root task");
                assert.equal(await cardHead("parent").locator("[data-session-handle]").textContent(), "#parent");
                assert.equal(await cardHead("done").locator("[data-session-headline]").textContent(), "Compare fork benchmark latency");
                assert.equal(await cardHead("done").locator("[data-session-handle]").textContent(), "#done");
                assert.equal(await cardHead("parent").locator("[data-session-gates]").textContent(), "1");
                assert.equal(await cardHead("parent").locator("[data-session-children]").textContent(), "1");
                assert.equal(await cardHead("parent").locator("time[data-session-time]").textContent(), "2m ago");
                assert.equal(await cardHead("done").locator("time[data-session-time]").textContent(), "just now");
                assert.equal(await cardHead("done").locator("[data-session-excerpt]").textContent(), "Delivered reply preview…");

                // Filter controls: status + live server-backed loop-prompt search
                await page.locator('#search-controls select[data-overview-scope]').selectOption("active");
                assert.equal(await card("parent").isVisible(), true);
                assert.equal(await card("done").isVisible(), false);
                await page.locator('#search-controls select[data-overview-scope]').selectOption("all");
                assert.equal(await card("done").isVisible(), true);
                const searchBox = page.locator('#search-controls input[data-overview-search]');
                await searchBox.fill("p99 tail spike");
                await page.waitForFunction(() => {
                    const doneRow = document.querySelector('#search-workspaces a[data-session-link][aria-label="done"]')?.closest("li");
                    const excerpt = doneRow?.querySelector("[data-session-excerpt]")?.textContent ?? "";
                    return doneRow && !doneRow.hidden && excerpt.includes("p99 tail spike");
                });
                assert.equal(await card("parent").isVisible(), false);
                await searchBox.fill("");
                assert.equal(await card("parent").isVisible(), true);

                // Open parent child disclosure; verify live SSE updates preserve open disclosure & focus, and untouched draft stays hidden until promoted
                const parentSummary = card("parent").locator(":scope > details > summary");
                await parentSummary.press("Enter");
                assert.equal(await card("parent").locator(":scope > details").evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
                await parentSummary.focus();

                emitNotification("session/created", 7, 8, {
                    id: 8,
                    workspaceId: 7,
                    workspaceName: "work",
                    projectRoot: null,
                    projectLabel: null,
                    name: "fresh-draft",
                    parentSessionId: null,
                    origin: "model",
                    kind: "root",
                    lifecycle: "idle",
                });
                assert.equal(await page.locator('#search-workspaces a[data-session-link][aria-label="fresh-draft"]').count(), 0, "untouched SSE-created draft stays hidden");

                // Promoting fresh-draft via loop/started + log/entry materializes it live!
                emitNotification("loop/started", 7, 8, { sessionId: 8, prompt: "Investigate live draft promotion" });
                await page.locator('#search-workspaces a[data-session-link][aria-label="fresh-draft"]').waitFor();
                assert.equal(await card("fresh-draft").locator("[data-session-headline]").textContent(), "Investigate live draft promotion");

                // Push newer reply to parent (id: 40) + rename workspace to "renamed-work"
                emitNotification("log/entry", 7, 2, {
                    entry: {
                        id: 40,
                        session_id: 2,
                        loop_seq: 1,
                        turn_seq: 1,
                        sequence: 3,
                        coordinate: "1/1/3/send:40",
                        origin: "model",
                        op: "send",
                        state: "resolved",
                        status_rx: 200,
                        tx: { body: "Newest live reply excerpt" },
                        rx: { completion: 200 },
                    },
                });
                emitNotification("loop/terminated", 7, 2, {
                    sessionId: 2,
                    loopId: 1,
                    result: { status: 200 },
                });
                emitNotification("workspace/renamed", 7, null, { id: 7, name: "renamed-work" });
                await page.locator('#search-workspaces > ul > li[data-workspace-id="7"] > article > header > a[data-text="name"]', { hasText: "renamed-work" }).waitFor();
                assert.deepEqual(await rootNames(), ["parent", "done", "fresh-draft"], "live overview reorders cards by latest reply");
                assert.equal(await card("parent").locator(":scope > details").evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true, "open child disclosure state is preserved across reorder");
                assert.equal(await parentSummary.evaluate((el) => document.activeElement === el), true, "keyboard focus is preserved across live reconciliation");
                assert.equal(await cardHead("parent").locator("[data-session-excerpt]").textContent(), "Newest live reply excerpt");

                // Live gate open + loop/gate-settled + session/titled updates on the discrete stream
                emitNotification("loop/proposal", 7, 8, {
                    logEntryId: 91,
                    sessionId: 8,
                    loopId: 1,
                    disposition: { decision: "review" },
                });
                await card("fresh-draft").locator('[data-session-gates="1"]').waitFor();
                emitNotification("loop/gate-settled", 7, 8, {
                    kind: "proposal",
                    sessionId: 8,
                    loopId: 1,
                    logEntryId: 91,
                    decision: "reject",
                    outcome: "rejected",
                });
                emitNotification("session/titled", 7, 8, {
                    id: 8,
                    title: "Live titled draft",
                });
                await card("fresh-draft").locator("[data-session-headline]", { hasText: "Live titled draft" }).waitFor();
                assert.equal(await card("fresh-draft").locator("[data-session-gates]").count(), 0);

                // Ending SSE stream transitions #main[data-connection] to disconnected, then passive backoff and online events recover it
                for (const stream of sseStreams) stream.end();
                await page.locator('main[data-connection="disconnected"]').waitFor();
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), true);
                await page.locator('main[data-connection="connected"]').waitFor();
                assert.equal(notificationRequests.length, 2, "overview SSE stream automatically re-subscribes after transient closure");
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), false);

                for (const stream of sseStreams) stream.end();
                await page.locator('main[data-connection="disconnected"]').waitFor();
                await page.evaluate(() => window.dispatchEvent(new Event("online")));
                await page.locator('main[data-connection="connected"]').waitFor({ timeout: 1000 });
                assert.equal(notificationRequests.length, 3, "online event triggers immediate SSE recovery without waiting for backoff");
                emitNotification("loop/terminated", 7, 8, { sessionId: 8, loopId: 1, result: { status: 200 } });
                await page.waitForFunction(() => document.querySelector('main a[data-session-link][aria-label="fresh-draft"]')?.closest("[data-session-identity]")?.querySelector("[data-lifecycle]")?.getAttribute("aria-label") === "completed");

                checkLive();
            } finally { await liveContext.close(); }
        } finally { await browser.close(); }
    });
}
