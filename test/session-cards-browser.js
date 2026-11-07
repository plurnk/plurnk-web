import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { engines } from "./engines.js";
import Documents from "../ai.plurnk/documents.js";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import { privateHeaders } from "../ai.plurnk/http.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

export default async function verifySessionCards(t) {
    const inventory = JSON.parse(await readFile(new URL("../ai.plurnk/assets.json", import.meta.url), "utf8"));
    const assets = new Map(await Promise.all(inventory.map(async ([path, file, contentType]) =>
        [path, { body: await readFile(new URL(`../ai.plurnk/dist/${file}`, import.meta.url)), contentType }])));
    const documents = new Documents(assets.get("/index.html").body.toString(), false, 128);
    let html;
    const requests = [];
    let currentOverview = { sessions: [], _meta: { plurnk: { workspaces: [] } } };
    const listRequests = [];
    /** @type {Set<import("node:http").ServerResponse>} */
    const sseStreams = new Set();
    /** @type {Map<string, (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void>} */
    const entryHandlers = new Map();
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, "http://fixture.invalid");
        const path = url.pathname;
        requests.push(path + url.search);
        if (path === "/auth/token" && request.method === "POST") {
            response.writeHead(200, { ...privateHeaders, "content-type": "application/json" });
            response.end(JSON.stringify({ access_token: "overview-token", token_type: "Bearer", expires_in: 300 }));
            return;
        }
        if (path === "/acp") {
            if (request.method === "DELETE") {
                response.writeHead(204, privateHeaders);
                response.end();
                return;
            }
            if (request.method === "GET") {
                response.writeHead(200, {
                    ...privateHeaders,
                    "content-type": "text/event-stream",
                    connection: "keep-alive",
                });
                response.write(": connected\n\n");
                sseStreams.add(response);
                request.on("close", () => sseStreams.delete(response));
                return;
            }
            if (request.method === "POST") {
                let raw = "";
                for await (const chunk of request) raw += chunk;
                const msg = JSON.parse(raw);
                if (msg.method === "initialize") {
                    response.writeHead(200, {
                        ...privateHeaders,
                        "content-type": "application/json",
                        "acp-connection-id": "overview-session",
                    });
                    response.end(JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: { protocolVersion: 2, capabilities: {}, info: { name: "@plurnk/plurnk-service", version: "1.0.0" } },
                    }));
                    return;
                }
                response.writeHead(202, privateHeaders);
                response.end();
                if (msg.id !== undefined) {
                    const result = msg.method === "session/list"
                        ? (listRequests.push(msg.params), currentOverview)
                        : {};
                    for (const stream of sseStreams) {
                        stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
                    }
                }
                return;
            }
        }
        if (path.startsWith("/acp/") && path.endsWith("/entry")) {
            const handler = entryHandlers.get(path + url.search);
            if (handler) {
                handler(request, response);
                return;
            }
        }
        const asset = (path === "/" && html ? { body: html, contentType: "text/html" } : assets.get(path))
            ?? (path.startsWith("/~/") ? { body: html, contentType: "text/html" } : null);
        response.writeHead(asset ? 200 : 404, { ...privateHeaders, "content-type": asset?.contentType ?? "text/plain" });
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
        { id: 8, name: "idle", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", archived_at: null },
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
                            listWorkspaces: async () => [{ id: 7, name, project_root, project_label: project_root, archived_at: null }],
                            listSessions: async () => sessions,
                        }, false);
                        await page.goto(new URL(workspacePath, base).href);
                        if (!javaScriptEnabled) {
                            // {§web-session-creation} {§web-workspace-rename} {§web-workspace-archive} Without scripting each form is a card in main:
                            // it takes only its own space, inside main's measure.
                            const boxes = await page.locator("main > dialog").evaluateAll((dialogs) => dialogs.map((dialog) => {
                                const box = dialog.getBoundingClientRect(), card = dialog.firstElementChild.getBoundingClientRect();
                                const main = dialog.parentElement.getBoundingClientRect();
                                return [dialog.id, Math.abs(box.height - card.height) < 1, box.left >= main.left && box.right <= main.right];
                            }));
                            assert.deepEqual(boxes, [["dialog-workspace-rename", true, true], ["dialog-workspace-archive", true, true], ["dialog-session-create", true, true]]);
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
            const liveContext = await browser.newContext({ javaScriptEnabled: true, viewport: { width: 1024, height: 844 } });
            try {
                const checkLive = browserDiagnostics(liveContext);
                const page = await liveContext.newPage();
                const overviewData = {
                    workspaces: [{ id: 7, name: "work", project_root: null, project_label: null, projectRoot: null, archived_at: null }],
                    sessions: [
                        { id: 2, workspaceId: 7, name: "parent", parentSessionId: null, origin: "model", kind: "root", lifecycle: "running", archived_at: null, reply: { id: 10, coordinate: "1/1/1/send:10", completion: /** @type {const} */ (200) } },
                        { id: 3, workspaceId: 7, name: "child", parentSessionId: 2, origin: "model", kind: "work", lifecycle: "parked", archived_at: null, reply: null },
                        { id: 6, workspaceId: 7, name: "done", parentSessionId: null, origin: "model", kind: "root", lifecycle: "completed", archived_at: null, reply: { id: 20, coordinate: "1/2/1/done:20", completion: /** @type {const} */ (200) } },
                        { id: 8, workspaceId: 7, name: "idle", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", archived_at: null, reply: null },
                    ],
                };
                const toAcpOverview = (wsName, items) => ({
                    sessions: items.map((s) => ({
                        sessionId: `${s.workspaceId}#${s.name}`,
                        cwd: "",
                        title: s.name,
                        _meta: {
                            plurnk: {
                                id: s.id,
                                workspaceId: s.workspaceId,
                                workspaceName: wsName,
                                projectRoot: null,
                                name: s.name,
                                parentSessionId: s.parentSessionId,
                                origin: s.origin,
                                lifecycle: s.lifecycle,
                                archived: false,
                                reply: s.reply,
                            },
                        },
                    })),
                    _meta: {
                        plurnk: {
                            workspaces: [{ id: 7, name: wsName, projectRoot: null, projectLabel: null }],
                        },
                    },
                });
                currentOverview = toAcpOverview("work", overviewData.sessions);
                listRequests.length = 0;
                entryHandlers.clear();
                let doneReads = 0;
                const doneTarget = "/acp/7/6/entry?target=log%3A%2F%2F%2F1%2F2%2F1%2Fdone%3A20";
                entryHandlers.set(doneTarget, (req, res) => {
                    doneReads++;
                    assert.equal(req.headers.authorization, "Bearer overview-token");
                    res.writeHead(200, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" });
                    res.end("**Delivered reply** <script>window.pwned = true</script>");
                });
                let parentFail = true;
                const parentTarget = "/acp/7/2/entry?target=log%3A%2F%2F%2F1%2F1%2F1%2Fsend%3A10";
                entryHandlers.set(parentTarget, (_req, res) => {
                    if (parentFail) {
                        res.writeHead(500, { ...privateHeaders, "content-type": "application/problem+json" });
                        res.end(JSON.stringify({
                            type: "https://problems.plurnk.xyz/acp/entry/storage-fault",
                            title: "Internal Server Error",
                            status: 500,
                            detail: "Temporary storage fault.",
                        }));
                        return;
                    }
                    res.writeHead(200, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" });
                    res.end("Parent initial reply");
                });
                html = await documents.read({ kind: "workspace", workspace: "work" }, {
                    listWorkspaces: async () => overviewData.workspaces,
                    listSessions: async () => overviewData.sessions,
                    readSessionOverview: async () => overviewData,
                }, true);
                requests.length = 0;
                await page.goto(new URL("/~/work/", base).href);
                await page.locator('main[data-connection="connected"]').waitFor();
                assert.equal(listRequests.length, 1);
                assert.deepEqual(listRequests[0], { _meta: { plurnk: { subscribe: true, workspaceId: 7 } } });
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), false);

                const rootNames = () => page.locator("main > ul > li > article > header [data-session-link], main > ul > li > article > details > summary [data-session-link]")
                    .evaluateAll((links) => links.map((el) => el.getAttribute("aria-label")));
                assert.deepEqual(await rootNames(), ["done", "parent", "idle"]);

                const card = (name) => page.locator(`main a[data-session-link][aria-label=${JSON.stringify(name)}]`).locator("xpath=ancestor::article[1]");
                assert.equal(await card("done").locator(":scope > details > [data-session-reply]").count(), 1, "completed leaf has reply disclosure");
                assert.equal(await card("idle").locator(":scope > details").count(), 0, "silent leaf has no disclosure");
                assert.equal(doneReads, 0, "closed reply disclosure does not fetch entry body at load");

                // Open "done" card: fetches once on demand and renders sanitized Markdown
                const doneSummary = card("done").locator(":scope > details > summary");
                await doneSummary.press("Enter");
                const doneOutlet = card("done").locator(":scope > details > [data-session-reply]");
                await doneOutlet.locator("strong", { hasText: "Delivered reply" }).waitFor();
                assert.equal(await page.evaluate(() => Boolean(window.pwned)), false);
                assert.equal(doneReads, 1);

                // Close and reopen "done": does not re-fetch
                await doneSummary.press("Enter");
                await doneSummary.press("Enter");
                assert.equal(doneReads, 1);

                // Open "parent" card: initial 500 error offers Retry form, which recovers
                const parentSummary = card("parent").locator(":scope > details > summary");
                await parentSummary.press("Enter");
                const parentOutlet = card("parent").locator(":scope > details > [data-session-reply]");
                await parentOutlet.locator('[role="alert"]', { hasText: "Temporary storage fault." }).waitFor();
                parentFail = false;
                await parentOutlet.getByRole("button", { name: "Retry", exact: true }).click();
                await parentOutlet.locator("p", { hasText: "Parent initial reply" }).waitFor();

                // Stale in-flight read protection + live _plurnk/overview reordering & workspace rename while preserving open state & focus
                const staleGate = Promise.withResolvers();
                const midTarget = "/acp/7/2/entry?target=log%3A%2F%2F%2F1%2F1%2F2%2Fsend%3A30";
                entryHandlers.set(midTarget, async (_req, res) => {
                    await staleGate.promise;
                    res.writeHead(200, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" });
                    res.end("Stale intermediate reply");
                });
                const newestTarget = "/acp/7/2/entry?target=log%3A%2F%2F%2F1%2F1%2F3%2Fsend%3A40";
                entryHandlers.set(newestTarget, (_req, res) => {
                    res.writeHead(200, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" });
                    res.end("Newest live reply");
                });

                await doneSummary.focus();
                for (const stream of sseStreams) {
                    stream.write(`data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "_plurnk/overview",
                        params: toAcpOverview("work", [
                            { ...overviewData.sessions[0], reply: { id: 30, coordinate: "1/1/2/send:30", completion: 200 } },
                            overviewData.sessions[1],
                            overviewData.sessions[2],
                            overviewData.sessions[3],
                        ]),
                    })}\n\n`);
                }
                await page.locator(`main [data-session-reply="${midTarget}"][aria-busy="true"]`).waitFor();

                // Before midTarget finishes, push a newer reply (id: 40) and rename workspace to "renamed-work"
                for (const stream of sseStreams) {
                    stream.write(`data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        method: "_plurnk/overview",
                        params: toAcpOverview("renamed-work", [
                            { ...overviewData.sessions[0], lifecycle: "completed", reply: { id: 40, coordinate: "1/1/3/send:40", completion: 200 } },
                            overviewData.sessions[1],
                            overviewData.sessions[2],
                            { ...overviewData.sessions[3], lifecycle: "running" },
                        ]),
                    })}\n\n`);
                }
                staleGate.resolve(undefined);
                await parentOutlet.locator("p", { hasText: "Newest live reply" }).waitFor();
                assert.equal((await parentOutlet.textContent())?.includes("Stale intermediate reply"), false, "stale in-flight reply read is ignored");
                assert.deepEqual(await rootNames(), ["parent", "done", "idle"], "live overview reorders cards by latest reply");
                assert.equal(await card("parent").locator(":scope > details").evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true, "open disclosure state is preserved across reorder");
                assert.equal(await card("done").locator(":scope > details").evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true, "done disclosure remains open");
                assert.equal(await doneOutlet.locator("strong").textContent(), "Delivered reply", "unchanged reply body remains rendered without refetch");
                assert.equal(doneReads, 1);
                assert.equal(await doneSummary.evaluate((el) => document.activeElement === el), true, "keyboard focus is preserved across live reconciliation");
                assert.equal(await page.title(), "renamed-work — Plurnk");
                assert.equal(await page.locator('header nav[aria-label="breadcrumb"] [aria-current="page"]').textContent(), "renamed-work");
                assert.equal(await card("idle").locator("[data-lifecycle]").getAttribute("aria-label"), "running");

                // Ending SSE stream transitions #main[data-connection] to disconnected and reveals header 🔌 indicator
                for (const stream of sseStreams) stream.end();
                await page.locator('main[data-connection="disconnected"]').waitFor();
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), true);

                checkLive([httpFailure("/acp/7/2/entry", 500)]);
            } finally { await liveContext.close(); }
        } finally { await browser.close(); }
    });
}
