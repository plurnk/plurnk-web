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
    const documents = new Documents(assets.get("/index.html").body.toString(), { overviewSessions: 128 });

    /** @type {Array<{ id: number, name: string, projectRoot: string | null, projectLabel: string | null, archivedAt: string | null }>} */
    let currentWorkspaces = [];
    /** @type {Array<Record<string, any>>} */
    let currentSessions = [];
    /** @type {((sessionId: string) => Array<{ opening: string }>) | null} */
    let loopProvider = null;
    /** @type {string | null} */
    let expectedAuth = null;

    const acpMethods = [];
    /** @type {{ path: string, search: string, authorization: string | null }[]} */
    const notificationRequests = [];
    /** @type {Set<import("node:http").ServerResponse>} */
    const sseStreams = new Set();
    /** @type {Map<string, { res: import("node:http").ServerResponse | null, queue: string[] }>} */
    const acpSse = new Map();
    let connSeq = 0;

    const getAcpStream = (key) => {
        let entry = acpSse.get(key);
        if (!entry) {
            entry = { res: null, queue: [] };
            acpSse.set(key, entry);
        }
        return entry;
    };

    const server = createServer(async (request, response) => {
        const url = new URL(request.url, "http://fixture.invalid");
        const path = url.pathname;
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
        if (path === "/acp") {
            if (expectedAuth !== null) {
                assert.equal(request.headers.authorization, expectedAuth);
            }
            if (request.method === "GET") {
                const connId = String(request.headers["acp-connection-id"] ?? "");
                const sessionId = String(request.headers["acp-session-id"] ?? "");
                const entry = getAcpStream(`${connId}:${sessionId}`);
                response.writeHead(200, {
                    ...privateHeaders,
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                });
                response.flushHeaders();
                response.write(":\n\n");
                entry.res = response;
                for (const frame of entry.queue.splice(0)) response.write(frame);
                request.on("close", () => {
                    if (entry.res === response) entry.res = null;
                });
                return;
            }
            if (request.method === "DELETE") {
                const connId = String(request.headers["acp-connection-id"] ?? "");
                for (const [key, entry] of acpSse) {
                    if (key.startsWith(`${connId}:`)) {
                        acpSse.delete(key);
                        if (entry.res && !entry.res.writableEnded) entry.res.end();
                    }
                }
                response.writeHead(202, privateHeaders);
                response.end();
                return;
            }
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (input.method === "initialize") {
                const connId = `cards-conn-${++connSeq}`;
                response.writeHead(200, {
                    ...privateHeaders,
                    "content-type": "application/json",
                    "acp-connection-id": connId,
                });
                response.end(JSON.stringify({
                    jsonrpc: "2.0",
                    id: input.id,
                    result: {
                        protocolVersion: 2,
                        capabilities: {},
                        info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
                    },
                }));
                return;
            }

            acpMethods.push(input.method === "_plurnk/action" ? input.params.kind : input.method);
            const connId = String(request.headers["acp-connection-id"] ?? "");
            const headerSess = String(request.headers["acp-session-id"] ?? "");
            const sessionId = headerSess || String(input.params?.sessionId ?? "");
            const candidateKey = `${connId}:${sessionId}`;
            const sessKey = headerSess === "" && acpSse.has(`${connId}:`) && !acpSse.has(candidateKey)
                ? `${connId}:`
                : candidateKey;
            response.writeHead(202, privateHeaders);
            response.end();

            let rpcResult = {};
            if (input.method === "session/list") {
                const archivedMode = input.params?.archived ?? "exclude";
                const wsById = new Map(currentWorkspaces.map((ws) => [ws.id, ws]));
                const sessById = new Map(currentSessions.map((s) => [s.id, s]));
                const filtered = currentSessions.filter((s) => {
                    if (s.origin !== "model") return false;
                    const ws = wsById.get(s.workspaceId ?? 7);
                    const isArch = Boolean(s.archivedAt || ws?.archivedAt);
                    if (archivedMode === "only") return isArch;
                    if (archivedMode === "exclude") return !isArch;
                    return true;
                });
                const unarchivedWorkspaces = currentWorkspaces
                    .filter((ws) => !ws.archivedAt)
                    .map(({ id, name, projectRoot, projectLabel }) => ({ id, name, projectRoot, projectLabel }));
                rpcResult = {
                    sessions: filtered.map((s) => {
                        const wsId = s.workspaceId ?? 7;
                        const ws = wsById.get(wsId);
                        const parentSessionId = s.parentSessionId ?? null;
                        const parentRow = parentSessionId !== null ? sessById.get(parentSessionId) : undefined;
                        const opening = s.opening ?? loopProvider?.(`${wsId}#${s.name}`)?.[0]?.opening;
                        return {
                            sessionId: `${wsId}#${s.name}`,
                            cwd: ws?.projectRoot ?? "/",
                            title: s.title ?? `${ws?.name ?? "work"}#${s.name}`,
                            archived: Boolean(s.archivedAt || ws?.archivedAt),
                            _meta: {
                                plurnk: {
                                    id: s.id,
                                    workspaceId: wsId,
                                    workspaceName: ws?.name ?? "work",
                                    projectRoot: ws?.projectRoot ?? null,
                                    projectLabel: ws?.projectLabel ?? null,
                                    name: s.name,
                                    parentSessionId,
                                    parentName: parentSessionId === null ? null : (parentRow?.name ?? "_plurnk"),
                                    parentOrigin: parentSessionId === null ? null : (parentRow?.origin ?? "_plurnk"),
                                    kind: s.kind ?? "root",
                                    lifecycle: s.lifecycle ?? "idle",
                                    gates: s.gates ?? 0,
                                    ...(s.title ? { title: s.title } : {}),
                                    ...(opening ? { opening } : {}),
                                    reply: s.reply ?? null,
                                },
                            },
                        };
                    }),
                    _meta: {
                        plurnk: {
                            scope: null,
                            workspaces: unarchivedWorkspaces,
                            proposals: [],
                            interactions: [],
                            omitted: 0,
                        },
                    },
                };
            } else if (input.method === "session/unarchive") {
                const targetName = String(input.params?.sessionId ?? "").split("#")[1] ?? "";
                currentSessions = currentSessions.map((s) => s.name === targetName ? { ...s, archivedAt: null } : s);
                rpcResult = {};
            } else if (input.method === "_plurnk/action") {
                const { kind, params } = input.params;
                if (kind === "workspace.list") {
                    rpcResult = { workspaces: currentWorkspaces };
                } else if (kind === "workspace.sessions") {
                    const wsId = params?.workspaceId ?? input.params.workspaceId;
                    rpcResult = {
                        sessions: currentSessions.filter((s) => (s.workspaceId ?? 7) === wsId),
                    };
                } else if (kind === "session.loops") {
                    rpcResult = {
                        items: loopProvider ? loopProvider(String(input.params.sessionId ?? "")) : [],
                    };
                } else if (kind === "workspace.archive") {
                    const wsId = params?.workspaceId ?? input.params.workspaceId;
                    currentWorkspaces = currentWorkspaces.map((ws) => ws.id === wsId ? { ...ws, archivedAt: params?.archived ? "2026-11-22T00:00:00Z" : null } : ws);
                    rpcResult = {};
                }
            }

            const stream = getAcpStream(sessKey);
            const data = `data: ${JSON.stringify({ jsonrpc: "2.0", id: input.id, result: rpcResult })}\n\n`;
            if (stream.res && !stream.res.writableEnded) stream.res.write(data);
            else stream.queue.push(data);
            return;
        }
        if (path === "/settings/search" || path === "/settings/search/" || path === "/settings/search/index.html") {
            const body = documents.settings("search", {
                workspace: url.searchParams.get("workspace") ?? undefined,
                session: url.searchParams.get("session") ?? undefined,
                q: url.searchParams.get("q") ?? undefined,
                filterWorkspace: url.searchParams.get("filterWorkspace") ?? undefined,
                status: url.searchParams.get("status") ?? undefined,
                kind: url.searchParams.get("kind") ?? undefined,
            });
            response.writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8" });
            response.end(body);
            return;
        }
        if (path.startsWith("/~/")) {
            // Serve a lightweight placeholder HTML page when testing navigation links off /settings/search
            response.writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8" });
            response.end("<!doctype html><html lang=\"en\"><head><title>Workspace</title></head><body><main></main></body></html>");
            return;
        }
        const asset = assets.get(path);
        const headers = {
            "content-type": asset?.contentType ?? "text/plain",
            ...(asset ? { "cache-control": "public, max-age=31536000, immutable" } : privateHeaders),
        };
        response.writeHead(asset ? 200 : 404, headers);
        response.end(asset?.body ?? "Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;

    const baseSessions = [
        { id: 1, workspaceId: 7, name: "_plurnk", parentSessionId: null, origin: "_plurnk", kind: "root", lifecycle: "idle", archivedAt: null },
        { id: 3, workspaceId: 7, name: "child", parentSessionId: 2, origin: "model", kind: "work", lifecycle: "parked", archivedAt: null },
        { id: 2, workspaceId: 7, name: "parent", parentSessionId: null, origin: "model", kind: "root", lifecycle: "running", archivedAt: null },
        { id: 4, workspaceId: 7, name: "leaf", parentSessionId: 3, origin: "model", kind: "fork", lifecycle: "failed", archivedAt: null },
        { id: 5, workspaceId: 7, name: "background", parentSessionId: 1, origin: "model", kind: "work", lifecycle: "queued", archivedAt: null },
        { id: 6, workspaceId: 7, name: "done", parentSessionId: null, origin: "model", kind: "root", lifecycle: "completed", archivedAt: null },
        { id: 7, workspaceId: 7, name: "cancelled", parentSessionId: null, origin: "model", kind: "root", lifecycle: "cancelled", archivedAt: null },
        { id: 8, workspaceId: 7, name: "untouched-draft", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", archivedAt: null },
        { id: 9, workspaceId: 7, name: "planned", parentSessionId: null, origin: "model", kind: "root", lifecycle: "idle", title: "Planned task", archivedAt: null },
    ];

    for (const engine of engines) await t.test(engine.name(), async () => {
        const browser = await engine.launch();
        try {
            // 1. Topology, folder markers, disclosures, lifecycles, and keyboard navigation over pure /acp
            const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
            try {
                const checkBrowser = browserDiagnostics(context);
                expectedAuth = null;
                loopProvider = null;
                const page = await context.newPage();
                for (const projectRoot of [null, "/srv/project"]) {
                    const name = `~/research/<script>&"${"long-".repeat(12)}`;
                    const workspacePath = directoryPath({ kind: "workspace", workspace: name });
                    currentWorkspaces = [{ id: 7, name, projectRoot, projectLabel: projectRoot, archivedAt: null }];
                    currentSessions = structuredClone(baseSessions);

                    await page.goto(new URL("/settings/search", base).href);
                    const wsArticle = page.locator('#search-workspaces > ul > li[data-directory-entry="workspace"][data-workspace-id="7"] > article');
                    await wsArticle.waitFor();
                    assert.equal(await wsArticle.getAttribute("aria-label"), projectRoot === null ? "Folderless workspace" : "Project workspace");
                    assert.match(
                        await wsArticle.locator(":scope > header").evaluate((el) => getComputedStyle(el, "::before").content),
                        projectRoot === null ? /☁️/u : /🗂️/u,
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
                    assert.equal(await card("child").locator(":scope > details > summary [data-session-parent] a").textContent(), "parent");
                    for (const [sessionName, glyph] of [["parent", "⌛"], ["child", "💤"], ["done", "✓"], ["cancelled", "🛑"], ["planned", "○"]]) {
                        const status = card(sessionName).locator(":scope > header, :scope > details > summary").locator("[data-lifecycle]");
                        const expected = baseSessions.find((s) => s.name === sessionName).lifecycle;
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
                    const beforeAcp = acpMethods.length;
                    await summary.press("Enter");
                    await card("child").locator(":scope > details > summary").press("Space");
                    assert.equal(await link("leaf").isVisible(), true);
                    assert.equal(acpMethods.length, beforeAcp, "native expansion makes no extra /acp requests");

                    const sessionPath = directoryPath({ kind: "session", workspace: name, session: "parent" });
                    await parent.locator(":scope > details").evaluate((details) => {
                        addEventListener("click", () => {
                            queueMicrotask(() => { window.name = String(details.open); });
                        }, { once: true });
                    });
                    await link("parent").click();
                    assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, sessionPath);
                    assert.equal(await page.evaluate(() => window.name), "true", "a real session link does not toggle its enclosing summary");
                    await page.goBack();
                    await wsArticle.waitFor();
                    await wsArticle.locator(':scope > header > a[data-text="name"]').click();
                    assert.equal(new URL(page.url()).pathname, workspacePath);
                    assert.equal(acpMethods.includes("session/resume"), false, "directory browsing never starts session/resume");
                }
                checkBrowser();
            } finally { await context.close(); }

            // 2. Live /acp + /notifications with OIDC Bearer grant, loop-prompt search, inline Unarchive, and SSE recovery
            const liveContext = await browser.newContext({ viewport: { width: 1024, height: 844 } });
            try {
                const checkLive = browserDiagnostics(liveContext);
                await liveContext.addInitScript((acpOrigin) => {
                    if (location.protocol === "about:") return;
                    localStorage.setItem("plurnk_oidc_grant", JSON.stringify({
                        acpOrigin,
                        issuer: "http://idp.test",
                        clientId: "plurnk-web",
                        tokenEndpoint: "http://idp.test/token",
                        accessToken: "overview-token",
                    }));
                }, base);
                expectedAuth = "Bearer overview-token";
                const page = await liveContext.newPage();
                currentWorkspaces = [
                    { id: 7, name: "work", projectRoot: null, projectLabel: null, archivedAt: null },
                    { id: 8, name: "shelved", projectRoot: null, projectLabel: null, archivedAt: "2026-11-20T00:00:00Z" },
                ];
                currentSessions = [
                    { id: 2, workspaceId: 7, name: "parent", parentSessionId: null, origin: "model", kind: "root", lifecycle: "running", gates: 1, title: "Root task", archivedAt: null, reply: { id: 10, coordinate: "1/1/1/send:10", completion: /** @type {const} */ (200), at: Date.now() - 120_000, excerpt: "Parent preview line", continued: false } },
                    { id: 3, workspaceId: 7, name: "child", parentSessionId: 2, origin: "model", kind: "work", lifecycle: "parked", gates: 0, archivedAt: null, reply: null },
                    { id: 6, workspaceId: 7, name: "done", parentSessionId: null, origin: "model", kind: "fork", lifecycle: "completed", gates: 0, archivedAt: null, reply: { id: 20, coordinate: "1/2/1/done:20", completion: /** @type {const} */ (200), at: Date.now() - 30_000, excerpt: "Delivered reply preview", continued: true } },
                    { id: 12, workspaceId: 7, name: "archived-sess", parentSessionId: null, origin: "model", kind: "root", lifecycle: "completed", gates: 0, archivedAt: "2026-11-20T00:00:00Z", reply: null },
                ];
                loopProvider = (sessionId) => sessionId === "7#done"
                    ? [{ opening: "Compare fork benchmark latency" }, { opening: "Inspect p99 tail spike in WebSocket pool" }]
                    : [];

                let nextEventId = 0;
                const emitNotification = (event, workspaceId, sessionId, data) => {
                    const id = ++nextEventId;
                    const payload = { id, event, timestamp: Date.now(), workspaceId, sessionId, data };
                    for (const stream of sseStreams) {
                        stream.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
                    }
                };
                notificationRequests.length = 0;
                await page.goto(new URL("/settings/search", base).href);
                await page.locator('main[data-connection="connected"]').waitFor();
                await page.locator('#search-workspaces a[data-session-link][aria-label="done"]').waitFor();
                assert.equal(notificationRequests.length, 1);
                assert.equal(notificationRequests[0].authorization, "Bearer overview-token");
                assert.equal(notificationRequests[0].path, "/notifications");
                assert.equal(notificationRequests[0].search, "");
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), false);
                assert.equal(await page.locator("header [data-oidc-sign-out]").isVisible(), true, "active OIDC grant renders Sign out button in header");

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

                // Filter controls: status + live /acp loop-prompt search + archived inline Unarchive
                await page.locator("#search-controls select[data-overview-scope]").selectOption("active");
                assert.equal(await card("parent").isVisible(), true);
                assert.equal(await card("done").isVisible(), false);
                await page.locator("#search-controls select[data-overview-scope]").selectOption("archived");
                await page.locator('#search-workspaces form[data-inline-unarchive="workspace"]').waitFor();
                assert.equal(await page.locator('#search-workspaces form[data-inline-unarchive="session"]').count(), 1);
                await page.locator("#search-controls select[data-overview-scope]").selectOption("all");
                await card("done").waitFor({ state: "visible" });

                const searchBox = page.locator("#search-controls input[data-overview-search]");
                await searchBox.fill("p99 tail spike");
                await page.waitForFunction(() => {
                    const doneRow = document.querySelector('#search-workspaces a[data-session-link][aria-label="done"]')?.closest("li");
                    const excerpt = doneRow?.querySelector("[data-session-excerpt]")?.textContent ?? "";
                    return doneRow && !doneRow.hidden && excerpt.includes("p99 tail spike");
                });
                assert.equal(await card("parent").isVisible(), false);
                await searchBox.fill("");
                await card("parent").waitFor({ state: "visible" });

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

                emitNotification("loop/started", 7, 8, {
                    sessionId: 8,
                    loopId: 1,
                    loopSeq: 1,
                    opening: "Investigate live draft promotion",
                });
                await page.locator('#search-workspaces a[data-session-link][aria-label="fresh-draft"]').waitFor();
                assert.equal(await card("fresh-draft").locator("[data-session-headline]").textContent(), "Investigate live draft promotion");

                emitNotification("session/replied", 7, 2, {
                    sessionId: 2,
                    loopId: 1,
                    loopSeq: 1,
                    reply: {
                        id: 40,
                        coordinate: "1/1/3",
                        completion: 200,
                        at: Date.now(),
                        excerpt: "Newest live reply excerpt",
                        continued: false,
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
                const prevNotifCount = notificationRequests.length;
                for (const stream of sseStreams) stream.end();
                await page.locator('main[data-connection="disconnected"]').waitFor();
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), true);
                await page.locator('main[data-connection="connected"]').waitFor();
                assert.equal(notificationRequests.length, prevNotifCount + 1, "overview SSE stream automatically re-subscribes after transient closure");
                assert.equal(await page.locator("header [data-connection-indicator]").isVisible(), false);

                for (const stream of sseStreams) stream.end();
                await page.locator('main[data-connection="disconnected"]').waitFor();
                await page.evaluate(() => window.dispatchEvent(new Event("online")));
                await page.locator('main[data-connection="connected"]').waitFor({ timeout: 1000 });
                assert.equal(notificationRequests.length, prevNotifCount + 2, "online event triggers immediate SSE recovery without waiting for backoff");
                emitNotification("loop/terminated", 7, 8, { sessionId: 8, loopId: 1, result: { status: 200 } });
                await page.waitForFunction(() => document.querySelector('main a[data-session-link][aria-label="fresh-draft"]')?.closest("[data-session-identity]")?.querySelector("[data-lifecycle]")?.getAttribute("aria-label") === "completed");

                checkLive();
            } finally { await liveContext.close(); }
        } finally { await browser.close(); }
    });
}
