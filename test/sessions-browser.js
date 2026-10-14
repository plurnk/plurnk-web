import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { directoryPath } from "../ai.plurnk/directory-addresses.js";
import verifyPageShell from "./page-shell.js";
import verifyAuthorizationPage from "./authorization-page.js";

export default async function verifySessions({ t, consumer, withDaemon }) {
    // {§web-directory-documents} Fixture seeding and censuses use the same public application port,
    // not the database. Only this isolated install contains the fixture module and its routes.
    const fixture = join(consumer, "node_modules", "@plurnk", "web-directory-fixture");
    const names = ['~/repo with space/@%2F/<script>&"', "folderless", "/root//project/", "分析", "%2E%2E", `~/project/${"long-name-".repeat(12)}`];
    await mkdir(fixture);
    await writeFile(join(fixture, "package.json"), JSON.stringify({
        name: "@plurnk/web-directory-fixture", version: "1.0.0", type: "module",
        exports: { "./module": "./module.js" }, plurnk: { kind: "module", module: "./module" },
    }));
    await writeFile(join(fixture, "module.js"), `export default { mounts: ["/__fixture"], async start(port) {
        for (const name of ${JSON.stringify(names)}) {
            const existing = (await port.listWorkspaces()).find((workspace) => workspace.name === name);
            const workspaceId = existing?.id ?? (await port.createWorkspace({ name, projectRoot: null })).workspaceId;
            await port.ensureModelWorker(workspaceId);
        }
        port.registerHttpRoute("/__fixture", async (req, res) => {
            if (req.url === "/__fixture/revoke" && req.method === "POST") {
                const token = req.headers.authorization?.slice(7);
                const claims = token ? port.credentials.verify(token) : null;
                if (claims) port.credentials.revokeFamily(claims.family);
                res.writeHead(204); res.end(); return;
            }
            const workspaces = await port.listWorkspaces();
            const snapshot = await Promise.all(workspaces.map(async (workspace) => ({ ...workspace,
                workers: await Promise.all((await port.listWorkers(workspace.id)).map(async (worker) => ({ ...worker,
                    loops: await port.listWorkerLoops({ workspaceId: workspace.id, workerId: worker.id }),
                }))),
            })));
            res.setHeader("content-type", "application/json"); res.end(JSON.stringify(snapshot));
        });
    } };\n`);
    try {
        await t.test("{§web-session} native sign-in, protected lists, logout and independent browsers", async () => {
            await withDaemon({ PLURNK_PASS: "browser-password" }, async (base) => {
                const initial = await (await fetch(new URL("/__fixture", base))).json();
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        const context = await browser.newContext({ javaScriptEnabled });
                        const other = await browser.newContext({ javaScriptEnabled });
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
                            const page = await signIn(context, "/~/");
                            const second = await signIn(other, "/~/");
                            await verifyPageShell(page, { title: "Workspaces — Plurnk", kind: "daemon" });
                            assert.deepEqual(await page.locator("main > ul > li > a").allTextContents(), initial.map(({ name }) => name));
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
                                assert.equal(await page.locator("main h1").innerText(), workspace.name);
                                await verifyPageShell(page, { title: `${workspace.name} — Plurnk`, kind: "workspace" });
                                assert.equal(await page.locator('[aria-current="page"]').innerText(), workspace.name);
                                assert.deepEqual(await page.locator("main > ul > li > a").allTextContents(), workspace.workers.map(({ name }) => name));
                                const worker = workspace.workers.find(({ origin }) => origin === "model");
                                assert.ok(worker);
                                await page.getByRole("link", { name: worker.name, exact: true }).click();
                                assert.equal(await page.locator("main h1").innerText(), `${workspace.name}@${worker.name}`);
                                await verifyPageShell(page, { title: `${workspace.name}@${worker.name} — Plurnk`, kind: "worker" });
                                assert.deepEqual(await page.locator('nav[aria-label="breadcrumb"] li').allTextContents(), ["Home", "Workspaces", workspace.name, worker.name]);
                                await page.reload();
                                await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: workspace.name, exact: true }).click();
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
                            await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Workspaces" }).click();
                            assert.equal(new URL(page.url()).pathname, "/~/");
                            await page.getByRole("button", { name: "Sign out" }).click();
                            await page.waitForURL(base);
                            assert.equal((await context.cookies()).some(({ name }) => name === "plurnk_web_session"), false);
                            const replay = await fetch(new URL("/~/", base), { headers: { cookie: `plurnk_web_session=${cookie.value}` }, redirect: "manual" });
                            assert.equal(replay.status, 303, "logout revokes the credential, not only the browser cookie");
                            await second.reload();
                            assert.equal(new URL(second.url()).pathname, "/~/", "another browser's grant survives");
                            const secondCookie = (await other.cookies()).find(({ name }) => name === "plurnk_web_session");
                            await fetch(new URL("/__fixture/revoke", base), { method: "POST", headers: { authorization: `Bearer ${secondCookie.value}` } });
                            const revoked = await other.request.get(new URL("/~/", base).href, { maxRedirects: 0 });
                            assert.equal(revoked.status(), 303, "authority revocation invalidates the web cookie immediately");
                        } finally { await context.close(); await other.close(); }
                    }
                    assert.deepEqual(await (await fetch(new URL("/__fixture", base))).json(), initial,
                        "navigation did not change identities, owners, project roots, workers or loops");
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-session} an empty password explains setup without admitting a localhost browser", async () => {
            await withDaemon({ PLURNK_AUTH: "1", PLURNK_PASS: "" }, async (base) => {
                const browser = await chromium.launch();
                try {
                    for (const javaScriptEnabled of [true, false]) {
                        const context = await browser.newContext({ javaScriptEnabled });
                        try {
                            const page = await context.newPage();
                            const response = await page.goto(new URL("/~/", base).href);
                            assert.equal(response.status(), 503, "unconfigured sign-in explains the missing configuration, never grants localhost access");
                            assert.match(await page.locator("body").innerText(), /PLURNK_PASS/u);
                            await verifyAuthorizationPage(page, response, { warning: true });
                            assert.equal((await context.cookies()).some(({ name }) => ["plurnk_session", "plurnk_web_session"].includes(name)), false,
                                "an empty password issued no sign-in");
                            assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
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
                        try {
                            const page = await context.newPage();
                            const response = await page.goto(new URL("/~/", base).href);
                            assert.equal(response.status(), 200);
                            assert.equal(await page.locator("main h1").innerText(), "Workspaces");
                            assert.equal(new URL(page.url()).pathname, "/~/");
                            assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
                            assert.equal(await page.getByRole("link", { name: "Account", exact: true }).count(), 0);
                            assert.deepEqual(await context.cookies(), []);
                            assert.equal((await context.request.get(new URL("/account/", base).href)).status(), 404);
                            assert.equal((await context.request.get(new URL("/account/sessions/", base).href)).status(), 404);
                            assert.equal((await context.request.get(new URL("/account/sessions/index.html", base).href)).status(), 404);
                            assert.equal((await context.request.post(new URL("/account/sessions/revoke-others", base).href)).status(), 404);
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
                            try {
                                const enter = async (ctx) => {
                                    const page = await ctx.newPage();
                                    await page.goto(new URL("/~/", base).href);
                                    await page.getByLabel("Password", { exact: true }).fill("browser-password");
                                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                                    await page.waitForURL(new URL("/~/", base).href);
                                    return page;
                                };
                                const page = await enter(context);
                                const second = await enter(other);
                                await page.getByRole("button", { name: "Sign out", exact: true }).click();
                                await page.waitForURL(base);
                                await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Workspaces", exact: true }).click();
                                await page.waitForLoadState("domcontentloaded");
                                assert.equal(new URL(page.url()).pathname, "/oauth/authorize", "revisiting Workspaces requires sign-in; revoking only the web cookie is insufficient");
                                assert.equal(await page.getByLabel("Password", { exact: true }).count(), 1);
                                await second.reload();
                                assert.equal(new URL(second.url()).pathname, "/~/", "another browser remains admitted");
                            } finally { await context.close(); await other.close(); }
                        });
                    }
                } finally { await browser.close(); }
            });
        });
        await t.test("{§web-session} browser-bound single-use callbacks, expiry, host and return validation", async () => {
            await withDaemon({ PLURNK_WEB_LOGIN_TTL_SEC: "1", PLURNK_WEB_LOGIN_PENDING: "2", PLURNK_PASS: "browser-password" }, async (base) => {
                const browser = await chromium.launch();
                try {
                    const context = await browser.newContext();
                    const other = await browser.newContext();
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
                    assert.equal((await hostRequest("elsewhere.example")).statusCode, 421);
                    const alias = await hostRequest(`localhost:${new URL(base).port}`);
                    assert.equal(alias.statusCode, 303);
                    assert.equal(alias.headers.location, new URL("/~/", base).href);
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
                    const pending = await other.request.get(new URL("/auth/login", base).href, { maxRedirects: 0 });
                    const again = await other.request.get(new URL("/auth/login", base).href, { maxRedirects: 0 });
                    assert.equal(pending.status(), 303);
                    assert.equal(again.status(), 303);
                    assert.equal((await other.request.get(new URL("/auth/login", base).href, { maxRedirects: 0 })).status(), 429);
                    const authorized = await authorize(other, pending.headers().location);
                    const page = await other.newPage();
                    await page.waitForTimeout(1100);
                    assert.equal((await other.request.get(authorized.headers().location, { maxRedirects: 0 })).status(), 400, "expired transactions cannot establish sessions");
                    assert.equal((await other.request.get(new URL("/auth/login", base).href, { maxRedirects: 0 })).status(), 303, "expired transactions free capacity");
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
                await withDaemon({ PLURNK_AGUI_ISSUER: issuer, PLURNK_PASS: "proxy-pass" }, async (base) => {
                    upstream = base;
                    const browser = await chromium.launch();
                    try {
                        const page = await browser.newPage();
                        await page.goto(`${issuer}/~/`);
                        assert.equal(new URL(page.url()).origin, issuer);
                        assert.equal(new URL(page.url()).pathname, "/oauth/authorize");
                        assert.equal(new URL(page.url()).searchParams.get("redirect_uri"), `${issuer}/auth/callback`);
                        await page.getByLabel("Password", { exact: true }).fill("proxy-pass");
                        await page.getByRole("button", { name: "Continue", exact: true }).click();
                        await page.waitForURL(`${issuer}/~/`);
                        assert.equal(await page.locator("main h1").innerText(), "Workspaces");
                        await page.getByRole("button", { name: "Sign out" }).click();
                        await page.waitForURL(`${issuer}/`);
                    } finally { await browser.close(); }
                });
                assert.deepEqual(errors, []);
            } finally {
                const closed = once(proxy, "close");
                proxy.close(); proxy.closeAllConnections(); await closed;
            }
        });
    } finally { await rm(fixture, { recursive: true }); }
}
