import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { directoryPath } from "../src/directory-addresses.js";
import verifyPageShell from "./page-shell.js";
import verifyAuthorizationPage from "./authorization-page.js";
import verifySessionDirectory from "./session-directory-browser.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

export default async function verifySessions({ t, consumer, withDaemon: baseWithDaemon }) {
    // {§web-directory-documents} Fixture seeding and censuses use the same public application port,
    // not the database. Only this isolated daemon run loads the fixture hook and its routes.
    const fixture = join(consumer, "web-directory-fixture-hook.mjs");
    const names = ['~/repo with space/@%2F/<script>&"', "folderless", "/root//project/", "分析", "%2E%2E", `~/project/${"long-name-".repeat(12)}`];
    const projectRoot = join(consumer, "directory-project");
    const homeFolders = [
        ['project @<draft>&"', null],
        ["renamed-project", "renamed workspace"],
    ];
    await mkdir(projectRoot);
    await writeFile(fixture, `import { registerHooks } from "node:module";
registerHooks({
    load(url, context, nextLoad) {
        if (!url.endsWith("/@plurnk/plurnk-web/src/module.js")) return nextLoad(url, context);
        return {
            format: "module",
            shortCircuit: true,
            source: \`import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import createRealModule from \${JSON.stringify(\`\${url}?real\`)};
export default function createFixtureModule() {
    const web = createRealModule();
    if (!web.mounts) return web;
    return {
        ...web,
        mounts: [...web.mounts, "/__fixture"],
        async start(port) {
            for (const name of ${JSON.stringify(names)}) {
                const existing = (await port.listWorkspaces()).find((workspace) => workspace.name === name);
                const projectRoot = name === ${JSON.stringify(names[0])} ? ${JSON.stringify(projectRoot)} : null;
                const workspaceId = existing?.id ?? (await port.createWorkspace({ name, projectRoot })).workspaceId;
                if (!(await port.listSessions(workspaceId)).some((session) => session.name === "user")) {
                    await port.createSession({ workspaceId, name: "user" });
                }
                if (name === ${JSON.stringify(names[0])} && !(await port.listSessions(workspaceId)).some((session) => session.name === "primary")) {
                    const owner = "acp://fixture/threads/primary";
                    await port.registerSessionOwner(workspaceId, { address: owner, tools: [], interactive: false });
                    const parent = await port.createSession({ workspaceId, name: "primary", owner });
                    const review = await port.forkSession({ workspaceId, sessionId: parent.sessionId, name: "review" });
                    await port.createSession({ workspaceId, name: "research", parentSessionId: parent.sessionId });
                    await port.createSession({ workspaceId, name: "evidence", parentSessionId: review.sessionId });
                    await port.createSession({ workspaceId, name: "2bb6a400-7106-4299-ae47-66daea5d6077" });
                    const runtime = await port.ensureRuntimeSession(workspaceId);
                    const incoming = await port.createSession({ workspaceId, name: "incoming", parentSessionId: runtime });
                    await port.createSession({ workspaceId, name: "incoming-child", parentSessionId: incoming.sessionId });
                    await port.createSession({ workspaceId, name: "background-peer", parentSessionId: runtime });
                }
            }
            for (const [folder, name] of ${JSON.stringify(homeFolders)}) {
                const projectRoot = join(homedir(), folder);
                await mkdir(projectRoot, { recursive: true });
                const existing = (await port.listWorkspaces()).find((workspace) => workspace.project_root === projectRoot);
                const workspaceId = existing?.id ?? (await port.createWorkspace({ projectRoot })).workspaceId;
                if (name !== null && existing?.name !== name) await port.renameWorkspace(workspaceId, name);
                if (!(await port.listSessions(workspaceId)).some((session) => session.name === "user")) {
                    await port.createSession({ workspaceId, name: "user" });
                }
            }
            port.registerHttpRoute("/__fixture", async (req, res) => {
                if (req.url === "/__fixture/revoke" && req.method === "POST") {
                    const token = req.headers.authorization?.slice(7);
                    const claims = token ? port.credentials.verify(token) : null;
                    if (claims) port.credentials.revokeFamily(claims.family);
                    res.writeHead(204); res.end(); return;
                }
                if (req.url === "/__fixture/archive" && req.method === "POST") {
                    let body = "";
                    for await (const chunk of req) body += chunk;
                    const { workspaceId, sessionId, archived } = JSON.parse(body);
                    if (sessionId === undefined) await port.setWorkspaceArchived({ workspaceId, archived });
                    else await port.setSessionArchived({ workspaceId, sessionId, archived });
                    res.writeHead(204); res.end(); return;
                }
                const workspaces = await port.listWorkspaces();
                const snapshot = await Promise.all(workspaces.map(async (workspace) => ({ ...workspace,
                    sessions: await Promise.all((await port.listSessions(workspace.id)).map(async (session) => ({ ...session,
                        loops: await port.listSessionLoops({ workspaceId: workspace.id, sessionId: session.id }),
                    }))),
                })));
                res.setHeader("content-type", "application/json"); res.end(JSON.stringify(snapshot));
            });
            return await web.start?.(port);
        },
    };
}\`,
        };
    },
});\n`);
    const withDaemon = (overrides, verify) => baseWithDaemon({
        NODE_OPTIONS: `--import=${pathToFileURL(fixture).href}`,
        ...overrides,
    }, verify);
    try {
        await t.test("{§web-session} native sign-in, protected lists, logout and independent browsers", async () => {
            await withDaemon({ PLURNK_PASS: "browser-password" }, async (base) => {
                const initial = await (await fetch(new URL("/__fixture", base))).json();
                assert.equal(initial.find(({ name }) => name === '~/project @<draft>&"')?.project_label, '~/project @<draft>&"');
                assert.equal(initial.find(({ name }) => name === "renamed workspace")?.project_label, "~/renamed-project");
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        const context = await browser.newContext({ javaScriptEnabled });
                        const other = await browser.newContext({ javaScriptEnabled });
                        const checkBrowser = browserDiagnostics(context);
                        const checkOther = browserDiagnostics(other);
                        try {
                            const signIn = async (ctx, path) => {
                                const page = await ctx.newPage();
                                const response = await page.goto(new URL(path, base).href);
                                assert.equal(new URL(page.url()).pathname, "/oauth/authorize");
                                assert.match(await page.locator("h1").innerText(), /Sign in/u);
                                await verifyAuthorizationPage(page, response, { password: true });
                                await page.getByLabel("Password", { exact: true }).fill("wrong");
                                const failure = page.waitForResponse((reply) => reply.request().isNavigationRequest() && reply.request().method() === "POST");
                                await page.getByRole("button", { name: "Continue", exact: true }).click();
                                const failedResponse = await failure;
                                assert.equal(failedResponse.status(), 401);
                                assert.match(await page.getByRole("alert").innerText(), /password is wrong/u);
                                await verifyAuthorizationPage(page, failedResponse, { password: true, warning: true });
                                await page.getByLabel("Password", { exact: true }).fill("browser-password");
                                await page.getByRole("button", { name: "Continue", exact: true }).click();
                                await page.waitForURL(new URL(path, base).href);
                                return page;
                            };
                            const page = await signIn(context, "/");
                            const second = await signIn(other, "/~/");
                            await verifyPageShell(page, { title: "Plurnk", kind: "home" });
                            await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "Workspaces", exact: true }).click();
                            await verifyPageShell(page, { title: "Workspaces — Plurnk", kind: "daemon" });
                            assert.equal(await page.locator("main h1").count(), 0);
                            assert.deepEqual(await page.locator("main > ul > li > article > header > a").allTextContents(), initial.map(({ name }) => name));
                            const entries = page.locator('main > ul > li > article');
                            assert.deepEqual(await entries.locator("header").evaluateAll((elements) => elements.map((element) => getComputedStyle(element, "::before").content.match(/☁️|🗂️/u)?.[0])), initial.map(({ project_root }) => project_root === null ? "☁️" : "🗂️"));
                            assert.deepEqual(await entries.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label"))),
                                initial.map(({ project_root }) => project_root === null ? "Folderless workspace" : "Project workspace"));
                            const cookie = (await context.cookies()).find(({ name }) => name === "plurnk_web_session");
                            assert.ok(cookie);
                            assert.equal(cookie.httpOnly, true);
                            assert.equal(cookie.sameSite, "Lax");
                            assert.equal(cookie.path, "/");
                            const foreign = await fetch(new URL("/~/", base), { headers: { authorization: `Bearer ${cookie.value}` }, redirect: "manual" });
                            assert.equal(foreign.status, 303, "the session is not accepted through a bearer header");
                            assert.equal((await fetch(new URL("/auth/logout", base), { method: "POST", headers: { cookie: `plurnk_web_session=${cookie.value}`, origin: "https://elsewhere.example" }, redirect: "manual" })).status, 403);
                            assert.equal((await fetch(new URL("/auth/logout", base), { headers: { cookie: `plurnk_web_session=${cookie.value}` }, redirect: "manual" })).status, 405);
                            for (const workspace of initial) {
                                await page.getByRole("link", { name: workspace.name, exact: true }).click();
                                assert.equal(new URL(page.url()).pathname, directoryPath({ kind: "workspace", workspace: workspace.name }));
                                await verifyPageShell(page, { title: `${workspace.name} — Plurnk`, kind: "workspace" });
                                assert.equal(await page.locator('[aria-current="page"]').innerText(), workspace.name);
                                // {§web-workspace-folder} Render the daemon's label, including after a rename.
                                const sameFolder = workspace.name === workspace.project_label;
                                const marker = page.getByRole("navigation", { name: "breadcrumb" }).getByRole("img", {
                                    name: sameFolder ? "Project workspace" : workspace.project_root === null ? "Folderless workspace" : "Workspace", exact: true,
                                });
                                assert.equal(await marker.innerText(), sameFolder ? "🗂️" : "☁️");
                                const folder = page.locator('main [data-text="project-label"]');
                                if (workspace.project_label !== null && !sameFolder) {
                                    assert.equal(await folder.textContent(), workspace.project_label);
                                    assert.equal(await page.getByRole("main").getByRole("img", { name: "Project folder", exact: true }).innerText(), "🗂️");
                                    assert.equal(await folder.locator("a").count(), 0, "a filesystem label is not a web link");
                                } else {
                                    assert.equal(await folder.count(), 0, "equal labels and folderless workspaces need no folder row");
                                }
                                await verifySessionDirectory(page, workspace);
                                const session = workspace.sessions.find(({ origin, parentSessionId }) => origin === "model" && parentSessionId === null);
                                assert.ok(session);
                                await page.getByRole("link", { name: session.name, exact: true }).click();
                                assert.equal(await page.locator("main h1").count(), 0, "session identity belongs in the breadcrumb, not a duplicate heading");
                                await verifyPageShell(page, { title: `${workspace.name}@${session.name} — Plurnk`, kind: "session" });
                                assert.deepEqual((await page.locator('nav[aria-label="breadcrumb"] li').allTextContents()).map((item) => item.trim()), ["", `${sameFolder ? "🗂️" : "☁️"} ${workspace.name}`, session.name]);
                                assert.equal(await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("button", { name: "Archive session", exact: true }).locator("svg").count(), 1);
                                await page.reload();
                                await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: workspace.name, exact: true }).click();
                                assert.deepEqual((await page.locator('nav[aria-label="breadcrumb"] li').allTextContents()).map((item) => item.trim()), ["", `${sameFolder ? "🗂️" : "☁️"} ${workspace.name}`]);
                                for (const action of ["Rename workspace", "Archive workspace", "New session"]) {
                                    assert.equal(await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("button", { name: action, exact: true }).locator("svg").count(), 1);
                                }
                                await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "Workspaces", exact: true }).click();
                            }
                            const response = await context.request.get(new URL("/~/index.html?q=hello", base).href);
                            assert.equal(response.status(), 200);
                            assert.equal(response.headers()["cache-control"], "no-store");
                            assert.equal(response.headers()["referrer-policy"], "no-referrer");
                            const head = await context.request.head(new URL("/~/", base).href);
                            assert.equal(head.headers()["content-length"], response.headers()["content-length"]);
                            assert.equal((await head.body()).length, 0);
                            assert.equal((await context.request.get(new URL("/~/missing/", base).href)).status(), 404);
                            assert.equal((await context.request.get(new URL(`${directoryPath({ kind: "workspace", workspace: names[0] }).slice(0, -1)}@absent/`, base).href)).status(), 404);
                            const missing = await page.goto(new URL("/~/missing/", base).href);
                            assert.equal(missing.status(), 404);
                            await verifyPageShell(page, { title: "404 Not Found — Plurnk", kind: "error" });
                            await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "Workspaces" }).click();
                            assert.equal(new URL(page.url()).pathname, "/~/");
                            await page.getByRole("banner").getByRole("link", { name: "Plurnk", exact: true }).click();
                            assert.equal(new URL(page.url()).pathname, "/");
                            await verifyPageShell(page, { title: "Plurnk", kind: "home" });
                            const totalSessions = initial.reduce((sum, ws) => sum + ws.sessions.filter(({ origin }) => origin === "model").length, 0);
                            assert.equal(
                                await page.locator("main a[data-session-link]").count(),
                                Math.min(12, totalSessions),
                                "admitted home renders the bounded daemon-wide model session overview",
                            );
                            assert.equal(await page.locator('main [data-text="overview-omitted"]').innerText(), String(totalSessions - 12));
                            await page.getByRole("button", { name: "Sign out" }).click();
                            await page.waitForURL((url) => new URL(url).pathname === "/oauth/authorize");
                            assert.equal((await context.cookies()).some(({ name }) => name === "plurnk_web_session"), false);
                            const replay = await fetch(new URL("/~/", base), { headers: { cookie: `plurnk_web_session=${cookie.value}` }, redirect: "manual" });
                            assert.equal(replay.status, 303, "logout revokes the credential, not only the browser cookie");
                            await second.reload();
                            assert.equal(new URL(second.url()).pathname, "/~/", "another browser's grant survives");
                            const secondCookie = (await other.cookies()).find(({ name }) => name === "plurnk_web_session");
                            await fetch(new URL("/__fixture/revoke", base), { method: "POST", headers: { authorization: `Bearer ${secondCookie.value}` } });
                            const revoked = await other.request.get(new URL("/~/", base).href, { maxRedirects: 0 });
                            assert.equal(revoked.status(), 303, "authority revocation invalidates the web cookie immediately");
                            checkBrowser([httpFailure("/oauth/authorize", 401), httpFailure("/~/missing/", 404)]);
                            checkOther([httpFailure("/oauth/authorize", 401)]);
                        } finally { await context.close(); await other.close(); }
                    }
                    assert.deepEqual(await (await fetch(new URL("/__fixture", base))).json(), initial,
                        "navigation did not change identities, owners, project roots, sessions or loops");
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-directory-documents} archived places leave the directories, and their own pages still open", async () => {
            await withDaemon({ PLURNK_AUTH: "0", PLURNK_PASS: "" }, async (base) => {
                const census = await (await fetch(new URL("/__fixture", base))).json();
                const shelved = census.find(({ name }) => name === "folderless");
                const project = census.find(({ name }) => name === names[0]);
                const review = project.sessions.find(({ name }) => name === "review");
                const archive = async (place, archived) => assert.equal((await fetch(new URL("/__fixture/archive", base), {
                    method: "POST", body: JSON.stringify({ ...place, archived }) })).status, 204);
                await archive({ workspaceId: shelved.id }, true);
                await archive({ workspaceId: project.id, sessionId: review.id }, true);
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        const context = await browser.newContext({ javaScriptEnabled });
                        const checkBrowser = browserDiagnostics(context);
                        try {
                            const page = await context.newPage();
                            await page.goto(new URL("/~/", base).href);
                            assert.deepEqual(await page.locator("main > ul > li > article > header > a").allTextContents(),
                                census.filter(({ id }) => id !== shelved.id).map(({ name }) => name), "an archived workspace leaves the list");
                            await page.goto(new URL(directoryPath({ kind: "workspace", workspace: project.name }), base).href);
                            const tree = await page.locator("main a[data-session-link]").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")));
                            assert.ok(tree.includes("primary") && tree.includes("research"), "shown sessions stay in the tree");
                            assert.ok(!tree.includes("review") && !tree.includes("evidence"), "an archived session leaves the tree with the sessions beneath it");
                            const opened = await page.goto(new URL(directoryPath({ kind: "session", workspace: project.name, session: "review" }), base).href);
                            assert.equal(opened.status(), 200, "an archived session's page opens by its address");
                            assert.equal((await page.goto(new URL(directoryPath({ kind: "workspace", workspace: shelved.name }), base).href)).status(), 200,
                                "an archived workspace's page opens by its address");
                            checkBrowser();
                        } finally { await context.close(); }
                    }
                } finally { await browser.close(); }
                await archive({ workspaceId: shelved.id }, false);
                await archive({ workspaceId: project.id, sessionId: review.id }, false);
                const shown = await (await fetch(new URL("/~/", base))).text();
                assert.match(shown, new RegExp(`href="${directoryPath({ kind: "workspace", workspace: shelved.name })}"`, "u"), "a shown workspace returns to the list");
            });
        });
        await t.test("{§web-session} an empty password explains setup without admitting a localhost browser", async () => {
            await withDaemon({ PLURNK_AUTH: "1", PLURNK_PASS: "" }, async (base) => {
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        const context = await browser.newContext({ javaScriptEnabled });
                        const checkBrowser = browserDiagnostics(context);
                        try {
                            const page = await context.newPage();
                            const response = await page.goto(base);
                            assert.equal(response.status(), 503, "unconfigured sign-in explains the missing configuration, never grants localhost access");
                            assert.match(await page.locator("body").innerText(), /PLURNK_PASS/u);
                            await verifyAuthorizationPage(page, response, { warning: true });
                            assert.equal((await context.cookies()).some(({ name }) => ["plurnk_session", "plurnk_web_session"].includes(name)), false,
                                "an empty password issued no sign-in");
                            assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
                            checkBrowser([httpFailure("/oauth/authorize", 503)]);
                        } finally { await context.close(); }
                    }
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-workspace-creation} native folderless workspace creation journey", async () => {
            await withDaemon({ PLURNK_PASS: "browser-password" }, async (base) => {
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        const context = await browser.newContext({ javaScriptEnabled });
                        const checkBrowser = browserDiagnostics(context);
                        try {
                            const page = await context.newPage();
                            // Sign in first
                            await page.goto(new URL("/~/", base).href);
                            await page.getByLabel("Password", { exact: true }).fill("browser-password");
                            await page.getByRole("button", { name: "Continue", exact: true }).click();
                            await page.waitForURL(new URL("/~/", base).href);
                            // 1. Creation from the /~/ workspaces index
                            const initialCensus = await (await fetch(new URL("/__fixture", base))).json();
                            const form = page.locator("#workspace-create");
                            assert.equal(await form.count(), 1, "creation form is present");
                            if (javaScriptEnabled) {
                                const trigger = page.locator('header nav[aria-label="breadcrumb"] button[data-dialog-target="dialog-workspace-create"]');
                                assert.equal(await trigger.count(), 1);
                                await trigger.click();
                                assert.equal(await page.locator("#dialog-workspace-create[open]").count(), 1, "modal opened");
                            } else {
                                assert.ok(await form.isVisible() && await form.evaluate((element) => element.closest("main") !== null), "without JavaScript the creation form renders in the page content");
                            }
                            const confirmButton = form.getByRole("button", { name: "Confirm", exact: true });
                            const posted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/workspaces/new");
                            await confirmButton.click();
                            assert.equal(new URLSearchParams((await posted).postData() ?? "").get("name"), "", "the form names no workspace");
                            await page.waitForURL((url) => new URL(url).pathname.startsWith("/~/") && new URL(url).pathname !== "/~/");
                            const createdPath = new URL(page.url()).pathname;

                            // Verify workspace page itself carries NO workspace creation form
                            assert.equal(await page.locator("#workspace-create").count(), 0, "workspace page does not carry workspace creation form");
                            const fixtureAfter = await (await fetch(new URL("/__fixture", base))).json();
                            const newlyCreated = fixtureAfter.find((ws) => directoryPath({ kind: "workspace", workspace: ws.name }) === createdPath);
                            assert.ok(newlyCreated, "created workspace appears in daemon census");
                            assert.notEqual(newlyCreated.name, "", "{§web-workspace-creation} the daemon named the workspace");
                            assert.equal(newlyCreated.project_root, null, "project_root is strictly null");
                            assert.equal(newlyCreated.project_label, null, "project_label is strictly null");
                            assert.equal(newlyCreated.sessions.length, 0, "no session or loop started");

                            // Verify existing workspaces in census remain untouched
                            for (const ws of initialCensus) {
                                const found = fixtureAfter.find((after) => after.name === ws.name);
                                assert.equal(found?.project_root, ws.project_root, `${ws.name} project_root untouched`);
                            }

                            // 2. Verify representation in /~/ list has ☁️ and Folderless workspace label
                            await page.goto(new URL("/~/", base).href);
                            const createdEntry = page.locator(`main > ul > li > article:has(header a[href="${createdPath}"])`);
                            assert.equal(await createdEntry.count(), 1);
                            assert.equal(await createdEntry.getAttribute("aria-label"), "Folderless workspace");
                            assert.equal(await createdEntry.locator("header").evaluate((element) => getComputedStyle(element, "::before").content.match(/☁️|🗂️/u)?.[0]), "☁️");

                            // 3. Test creation from /~/ with keyboard submission (Enter)
                            await page.goto(new URL("/~/", base).href);
                            const secondForm = page.locator("#workspace-create");
                            const nameInput = secondForm.locator('input[name="name"]');
                            if (javaScriptEnabled) {
                                const secondTrigger = page.locator('header nav[aria-label="breadcrumb"] button[data-dialog-target="dialog-workspace-create"]');
                                assert.equal(await secondTrigger.count(), 1);
                                await secondTrigger.click();
                                assert.equal(await page.locator("#dialog-workspace-create[open]").count(), 1);
                            } else {
                                assert.ok(await secondForm.isVisible() && await secondForm.evaluate((element) => element.closest("main") !== null), "without JavaScript the creation form renders in the page content");
                            }
                            await nameInput.focus();
                            await page.keyboard.press("Enter");
                            await page.waitForURL((url) => new URL(url).pathname.startsWith("/~/") && new URL(url).pathname !== "/~/" && new URL(url).pathname !== createdPath);
                            const secondCreatedPath = new URL(page.url()).pathname;
                            assert.ok(secondCreatedPath.startsWith("/~/"));

                            // 4. {§web-workspace-rename} and {§web-session-creation} on the workspace page, through the daemon
                            const open = async (dialog, formId) => {
                                const target = page.locator(`#${formId}`);
                                if (javaScriptEnabled) {
                                    await page.locator(`header button[data-dialog-target="${dialog}"]`).click();
                                    assert.equal(await page.locator(`#${dialog}[open]`).count(), 1, `${dialog} opened`);
                                } else {
                                    assert.ok(await target.isVisible() && await target.evaluate((element) => element.closest("main") !== null), `without JavaScript ${formId} renders in the page content`);
                                }
                                return target;
                            };
                            await page.goto(new URL(createdPath, base).href);
                            const renamedName = `renamed-${javaScriptEnabled ? "scripted" : "unscripted"}`;
                            const renameForm = await open("dialog-workspace-rename", "workspace-rename");
                            await renameForm.locator('input[name="name"]').fill(renamedName);
                            await renameForm.getByRole("button", { name: "Confirm", exact: true }).click();
                            const renamedPath = directoryPath({ kind: "workspace", workspace: renamedName });
                            await page.waitForURL(new URL(renamedPath, base).href);
                            const sessionName = `added-${javaScriptEnabled ? "scripted" : "unscripted"}`;
                            const sessionForm = await open("dialog-session-create", "session-create");
                            await sessionForm.locator('input[name="name"]').fill(sessionName);
                            await sessionForm.getByRole("button", { name: "Confirm", exact: true }).click();
                            await page.waitForURL(new URL(directoryPath({ kind: "session", workspace: renamedName, session: sessionName }), base).href);
                            const renamed = (await (await fetch(new URL("/__fixture", base))).json()).find((ws) => ws.id === newlyCreated.id);
                            assert.equal(renamed?.name, renamedName, "the daemon holds the new name");
                            const added = renamed.sessions.find((session) => session.name === sessionName);
                            assert.ok(added, "the daemon holds the new session");
                            assert.deepEqual([added.parentSessionId, added.loops.length], [null, 0], "an independent session with no loop");
                            // {§web-session-creation} Left unnamed, the daemon names the session.
                            await page.goto(new URL(renamedPath, base).href);
                            const unnamedForm = await open("dialog-session-create", "session-create");
                            assert.equal(await unnamedForm.locator('input[name="name"]').inputValue(), "", "the form names no session");
                            await unnamedForm.getByRole("button", { name: "Confirm", exact: true }).click();
                            await page.waitForURL((url) => url.pathname.includes("@") && !url.pathname.endsWith(`@${sessionName}/`));
                            const named = (await (await fetch(new URL("/__fixture", base))).json()).find((ws) => ws.id === newlyCreated.id)
                                .sessions.filter(({ name, origin }) => origin === "model" && name !== sessionName);
                            assert.equal(named.length, 1, "one session the daemon named");
                            assert.equal(new URL(page.url()).pathname, directoryPath({ kind: "session", workspace: renamedName, session: named[0].name }));

                            // 5. A daemon refusal shows the daemon's own status and detail, and offers the draft again on a
                            // form whose corrected submission goes through.
                            const refusal = async (dialog, formId, name, detail) => {
                                const target = await open(dialog, formId);
                                await target.locator('input[name="name"]').fill(name);
                                await target.getByRole("button", { name: "Confirm", exact: true }).click();
                                await page.waitForLoadState("domcontentloaded");
                                assert.equal(await page.locator('[data-text="error-title"]').innerText(), "409 Conflict", `${formId} keeps the daemon's status`);
                                assert.match(await page.locator('[data-text="error-message"]').innerText(), detail, `${formId} shows the daemon's detail`);
                                const retry = page.locator(`main #${formId}`);
                                assert.equal(await retry.locator('input[name="name"]').inputValue(), name, `${formId} offers the draft again`);
                                return retry;
                            };
                            const correct = async (retry, name, path) => {
                                await retry.locator('input[name="name"]').fill(name);
                                await retry.getByRole("button", { name: "Confirm", exact: true }).click();
                                await page.waitForURL(new URL(path, base).href);
                            };
                            const suffix = javaScriptEnabled ? "scripted" : "unscripted";
                            await page.goto(new URL(renamedPath, base).href);
                            await correct(await refusal("dialog-session-create", "session-create", sessionName, /already in use/u),
                                `again-${suffix}`, directoryPath({ kind: "session", workspace: renamedName, session: `again-${suffix}` }));
                            await page.goto(new URL(renamedPath, base).href);
                            await correct(await refusal("dialog-workspace-rename", "workspace-rename", "folderless", /already in use/u),
                                `${renamedName}-final`, directoryPath({ kind: "workspace", workspace: `${renamedName}-final` }));
                            await page.goto(new URL("/~/", base).href);
                            await correct(await refusal("dialog-workspace-create", "workspace-create", "folderless", /already in use/u),
                                `corrected-${suffix}`, directoryPath({ kind: "workspace", workspace: `corrected-${suffix}` }));

                            checkBrowser([httpFailure("/sessions/new", 409), httpFailure("/workspaces/rename", 409), httpFailure("/workspaces/new", 409)]);
                        } finally { await context.close(); }
                    }
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-session} explicitly anonymous access offers no fictional account or sign-out", async () => {
            await withDaemon({ PLURNK_AUTH: "0", PLURNK_PASS: "" }, async (base) => {
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        const context = await browser.newContext({ javaScriptEnabled });
                        const checkBrowser = browserDiagnostics(context);
                        try {
                            const page = await context.newPage();
                            const response = await page.goto(new URL("/~/", base).href);
                            assert.equal(response.status(), 200);
                            assert.equal(await page.locator('[aria-current="page"]').getAttribute("aria-label"), "Workspaces");
                            assert.equal(await page.locator('[aria-current="page"] > svg').count(), 1);
                            assert.equal(new URL(page.url()).pathname, "/~/");
                            assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
                            assert.equal(await page.getByRole("link", { name: "Account", exact: true }).count(), 0);
                            assert.deepEqual(await context.cookies(), []);
                            assert.equal((await context.request.get(new URL("/account/", base).href)).status(), 404);
                            assert.equal((await context.request.get(new URL("/account/sessions/", base).href)).status(), 404);
                            assert.equal((await context.request.get(new URL("/account/sessions/index.html", base).href)).status(), 404);
                            assert.equal((await context.request.post(new URL("/account/sessions/revoke-others", base).href)).status(), 404);
                            checkBrowser();
                        } finally { await context.close(); }
                    }
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-session} sign-out stays signed out on a fresh visit, with another browser unaffected", async (journeys) => {
            await withDaemon({ PLURNK_PASS: "browser-password" }, async (base) => {
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        await journeys.test(`JavaScript ${javaScriptEnabled ? "on" : "off"}`, async () => {
                            const context = await browser.newContext({ javaScriptEnabled });
                            const other = await browser.newContext({ javaScriptEnabled });
                            const checkBrowser = browserDiagnostics(context);
                            const checkOther = browserDiagnostics(other);
                            try {
                                const enter = async (ctx) => {
                                    const page = await ctx.newPage();
                                    await page.goto(base);
                                    await page.getByLabel("Password", { exact: true }).fill("browser-password");
                                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                                    await page.waitForURL(base);
                                    return page;
                                };
                                const page = await enter(context);
                                const second = await enter(other);
                                await page.getByRole("button", { name: "Sign out", exact: true }).click();
                                await page.waitForURL((url) => new URL(url).pathname === "/oauth/authorize");
                                assert.equal(await page.getByLabel("Password", { exact: true }).count(), 1);
                                await page.goto(new URL("/~/", base).href);
                                assert.equal(new URL(page.url()).pathname, "/oauth/authorize", "revisiting Workspaces requires sign-in; revoking only the web cookie is insufficient");
                                assert.equal(await page.getByLabel("Password", { exact: true }).count(), 1);
                                await second.reload();
                                assert.equal(new URL(second.url()).pathname, "/", "another browser remains admitted");
                                checkBrowser();
                                checkOther();
                            } finally { await context.close(); await other.close(); }
                        });
                    }
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-session} browser-bound single-use callbacks, expiry, host and return validation", async () => {
            await withDaemon({ PLURNK_WEB_LOGIN_TTL_SEC: "1", PLURNK_PASS: "browser-password" }, async (base) => {
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const other = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const checkOther = browserDiagnostics(other);
                    const request = context.request;
                    const get = (path) => request.get(new URL(path, base).href, { maxRedirects: 0 });
                    const authorize = (ctx, url) => ctx.request.post(url, { maxRedirects: 0, headers: { origin: new URL(base).origin },
                        form: { ...Object.fromEntries(new URL(url).searchParams), password: "browser-password" },
                    });
                    for (const path of ["https://elsewhere.example/", "//elsewhere.example/", "/oauth/authorize", "/~/../bad/"]) {
                        assert.equal((await get(`/auth/login?${new URLSearchParams({ return: path })}`)).status(), 400);
                    }
                    // Fetch owns Host; use a raw HTTP request to exercise a different Host on the wire.
                    const hostRequest = (host) => new Promise((accept, reject) => {
                        httpRequest(new URL("/~/", base), { headers: { host } }, (response) => {
                            response.resume(); response.once("end", () => accept(response));
                        }).once("error", reject).end();
                    });
                    // {§web-session} A browser is answered at whatever address it reached the daemon by.
                    for (const host of ["elsewhere.example", `localhost:${new URL(base).port}`]) {
                        const answered = await hostRequest(host);
                        assert.equal(answered.statusCode, 303, host);
                        assert.equal(answered.headers.location, `/auth/login?${new URLSearchParams({ return: "/~/" })}`, host);
                    }
                    const first = await get("/auth/login?return=/~/");
                    assert.equal(first.status(), 303);
                    const authorizedFirst = await authorize(context, first.headers().location);
                    assert.equal(authorizedFirst.status(), 302);
                    const callback = authorizedFirst.headers().location;
                    assert.equal((await other.request.get(callback, { maxRedirects: 0 })).status(), 400, "a stolen callback is not a login");
                    const altered = new URL(callback);
                    altered.searchParams.set("state", "wrong");
                    assert.equal((await get(altered.href)).status(), 400);
                    const completed = await get(callback);
                    assert.equal(completed.status(), 303);
                    assert.equal(completed.headers().location, "/~/");
                    assert.equal((await get(callback)).status(), 400, "callback replay is not a second grant");
                    assert.equal((await get("/~/")).status(), 200);
                    // Unauthenticated starts leave no module state behind to fill.
                    for (let index = 0; index < 300; index++) {
                        assert.equal((await fetch(new URL("/auth/login", base), { redirect: "manual" })).status, 303);
                    }
                    const pending = await other.request.get(new URL("/auth/login", base).href, { maxRedirects: 0 });
                    const again = await other.request.get(new URL("/auth/login", base).href, { maxRedirects: 0 });
                    assert.equal(pending.status(), 303);
                    assert.equal(again.status(), 303);
                    const expiring = await authorize(other, pending.headers().location);
                    const signedIn = await other.request.get((await authorize(other, again.headers().location)).headers().location, { maxRedirects: 0 });
                    assert.equal(signedIn.status(), 303, "a real sign-in completes beside another tab's transaction");
                    assert.equal(signedIn.headers().location, "/");
                    const page = await other.newPage();
                    await page.waitForTimeout(1100);
                    assert.equal((await other.request.get(expiring.headers().location, { maxRedirects: 0 })).status(), 400, "expired transactions cannot establish sessions");
                    checkBrowser();
                    checkOther();
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-session} configured public issuer works through its real proxy", async () => {
            let upstream;
            const errors = [];
            const proxy = createServer((req, res) => {
                const forwarded = httpRequest(new URL(req.url, upstream), { method: req.method, headers: req.headers }, (reply) => {
                    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
                });
                forwarded.once("error", (error) => { errors.push(error); res.writeHead(502); res.end(); });
                req.pipe(forwarded);
            });
            proxy.listen(0, "127.0.0.1");
            await once(proxy, "listening");
            const issuer = `http://127.0.0.1:${proxy.address().port}`;
            try {
                await withDaemon({ PLURNK_AUTH_ISSUER: issuer, PLURNK_PASS: "proxy-pass" }, async (base) => {
                    upstream = base;
                    const browser = await chromium.launch();
                    try {
                        const page = await browser.newPage();
                        const checkBrowser = browserDiagnostics(page.context());
                        await page.goto(`${issuer}/`);
                        assert.equal(new URL(page.url()).origin, issuer);
                        assert.equal(new URL(page.url()).pathname, "/oauth/authorize");
                        assert.equal(new URL(page.url()).searchParams.get("redirect_uri"), `${issuer}/auth/callback`);
                        await page.getByLabel("Password", { exact: true }).fill("proxy-pass");
                        await page.getByRole("button", { name: "Continue", exact: true }).click();
                        await page.waitForURL(`${issuer}/`);
                        assert.equal(await page.locator("main h1").count(), 0);
                        await page.getByRole("button", { name: "Sign out" }).click();
                        await page.waitForURL((url) => new URL(url).origin === issuer && new URL(url).pathname === "/oauth/authorize");
                        checkBrowser();
                    } finally { await browser.close(); }
                });
                assert.deepEqual(errors, []);
            } finally {
                const closed = once(proxy, "close");
                proxy.close(); proxy.closeAllConnections(); await closed;
            }
        });
    } finally { await rm(fixture, { force: true }); }
}
