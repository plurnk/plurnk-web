import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";
import browserDiagnostics, { httpFailure, networkFailure } from "./browser-diagnostics.js";
import verifyWebApp from "./web-app.js";
import verifyDocument from "./document.js";
import candidatePackages from "./candidate-packages.js";
import verifySessions from "./sessions-browser.js";
import verifySessionPage from "./session-browser.js";
import verifySessionCommands from "./session-commands.js";
import verifySessionInput, { closeSharedDaemons } from "./session-input.js";
import verifySessionHistory from "./session-history.js";
import verifySessionApproval from "./session-approval.js";
import verifySessionQuestions from "./session-questions.js";
import verifySharedReview from "./shared-review.js";
import verifyWorkspaceTabs from "./workspace-tabs-browser.js";
import verifyWorkspaceSettings from "./workspace-settings-browser.js";
import verifyStaticAssets from "./static-assets.js";
import verifyRouteSettlement from "./route-settlement.js";
import { closeSharedBrowsers, launchBrowser } from "./engines.js";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);

test("{§web-package} packed module on the candidate daemon", { timeout: 600_000 }, async (t) => {
    const packages = await candidatePackages();
    const directory = await mkdtemp(join(tmpdir(), "plurnk-web-install-"));
    /** @type {Set<{ stop(): Promise<unknown> }>} */
    const activeDaemons = new Set();
    t.after(async () => {
        await closeSharedDaemons();
        await Promise.allSettled([...activeDaemons].map((daemon) => daemon.stop()));
        activeDaemons.clear();
        await closeSharedBrowsers();
        await rm(directory, { recursive: true, force: true });
    });
    const consumer = join(directory, "consumer");
    const home = join(directory, "home");
    await mkdir(consumer);
    await mkdir(home);
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root });
    const archives = Object.values(JSON.parse(stdout));
    assert.equal(archives.length, 1);
    const [archive] = archives;
    assert.ok(archive.files.some(({ path }) => /^dist\/assets\/.+\.js$/u.test(path)));
    assert.ok(archive.files.some(({ path }) => /^dist\/assets\/.+\.css$/u.test(path)));
    assert.ok(archive.files.some(({ path }) => path === "dist/vendor/OTM-LICENSE.txt"));
    assert.ok(archive.files.some(({ path }) => path === "dist/vendor/DEPENDENCIES-LICENSE.txt"));
    assert.ok(archive.files.some(({ path }) => path === "dist/assets.json"));
    assert.ok(archive.files.some(({ path }) => path === ".env.defaults"));
    for (const name of ["brand.js", "module.js", "index-document.js", "directory-addresses.js", "documents.js", "http.js", "static-assets.js", "diagrams.js", "diagram-compiler.js"]) {
        assert.ok(archive.files.some(({ path }) => path === `src/${name}`), `expected src/${name} in packed package`);
    }
    for (const path of ["manifest.webmanifest", "icons/plurnk.svg", "icons/plurnk-maskable.svg", "icons/NOTO-NOTICE.txt", "icons/APACHE-2.0.txt"]) {
        assert.ok(archive.files.some((file) => file.path === `dist/${path}`), `expected dist/${path} in packed package`);
    }
    assert.ok(!archive.files.some(({ path }) => path.endsWith(".png")), "no unused raster fallback is packed");
    assert.ok(!archive.files.some(({ path }) => /^(test|scripts|node_modules|web|public)\/|vite\.config|\.map$/u.test(path)));
    await writeFile(join(consumer, "package.json"), JSON.stringify({
        name: "web-installation-test",
        private: true,
        type: "module",
        overrides: {
            "@plurnk/plurnk-web": "$@plurnk/plurnk-web",
        },
    }));
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund",
        ...packages, join(directory, archive.filename)],
    { cwd: consumer, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
    await run("npm", ["ls", "--all"], { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });

    const require = createRequire(join(consumer, "package.json"));
    const { default: Launch } = await import(pathToFileURL(require.resolve("@plurnk/plurnk-service/launch")).href);
    const daemonBin = join(consumer, "node_modules", ".bin", "plurnk-service");
    const webPackage = join(consumer, "node_modules", "@plurnk", "plurnk-web");
    await t.test("{§web-route-settlement} the packed module settles admitted requests", async (t) => {
        process.loadEnvFile(join(webPackage, ".env.defaults"));
        const { default: createModule } = await import(pathToFileURL(require.resolve("@plurnk/plurnk-web/module")).href);
        await verifyRouteSettlement(t, createModule);
    });
    await t.test("{§web-directory-addresses} the packed codec preserves exact names", async () => {
        const { directoryPath, parseDirectory } = await import(pathToFileURL(join(webPackage, "src", "directory-addresses.js")).href);
        const directory = { kind: "session", workspace: "~/project @%/index.html", session: "session1" };
        const path = directoryPath(directory);
        assert.equal(path, "/~/~/project%20%40%25/index.html#session1");
        const parsedUrl = new URL(path, "https://example.test");
        assert.deepEqual(parseDirectory(parsedUrl.pathname + parsedUrl.hash), directory);
    });
    const start = (overrides = {}, userHome = home) => Launch.start({
        command: [daemonBin, "start"],
        cwd: consumer,
        env: {
            PATH: process.env.PATH,
            HOME: userHome,
            XDG_CONFIG_HOME: join(userHome, ".config"),
            XDG_DATA_HOME: join(userHome, ".local", "share"),
            XDG_STATE_HOME: join(userHome, ".local", "state"),
            XDG_CACHE_HOME: join(userHome, ".cache"),
            XDG_RUNTIME_DIR: join(userHome, "run"),
            // {§web-session-approval} Journeys that are not about review settle proposals automatically on the daemon;
            // the shipped service default is explicit review, and each review journey sets PLURNK_SERVICE_PROPOSALS=review.
            PLURNK_SERVICE_PROPOSALS: "accept",
            ...overrides,
        },
        host: "127.0.0.1",
        port: 0,
        readyTimeoutMs: 30_000,
        stopGraceMs: 10_000,
    });
    const withDaemon = async (overrides, verify) => {
        const daemon = await start(overrides, await mkdtemp(join(directory, "scenario-")));
        activeDaemons.add(daemon);
        const failures = [];
        try {
            await verify(new URL("/", daemon.url).href, daemon);
        } catch (error) {
            failures.push(error);
        }
        try {
            activeDaemons.delete(daemon);
            assert.deepEqual(await daemon.stop(), { code: 0, signal: null }, daemon.stderr());
        } catch (error) {
            failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Verification and daemon cleanup failed", { cause: failures[0] });
    };

    await t.test("{§web-host} composition, default floor and route precedence", async (discovery) => {
        await withDaemon({}, async (base) => {
            await discovery.test("{§web-asset-encoding} packed assets negotiate exact compressed bytes", () =>
                verifyStaticAssets(base, pathToFileURL(`${webPackage}/`)));
            const arrival = await fetch(base, { redirect: "manual" });
            assert.equal(arrival.status, 200, "{§web-arrival} GET / serves the static arrival shell");
            assert.match(await arrival.text(), /<main\b[^>]*data-page="home"[^>]*>\s*<\/main>/u);
            const explicitIndex = await fetch(new URL("/index.html?q=one%2Ftwo", base));
            assert.equal(explicitIndex.status, 200, "{§web-index-documents} packed explicit index selects the static root document");
            assert.match(await explicitIndex.text(), /<main\b[^>]*data-page="home"[^>]*>\s*<\/main>/u);
            const acp = await fetch(new URL("/acp", base));
            assert.notEqual(acp.status, 200);
            assert.match(acp.headers.get("content-type"), /application\/problem\+json/u);
            assert.equal(typeof (await acp.json()).type, "string");
            for (const path of ["/not-a-page", "/~", "/account/"]) {
                const unknown = await fetch(new URL(path, base));
                assert.equal(unknown.status, 404, `${path}: no unimplemented resource is served`);
                assert.equal(unknown.headers.get("content-type"), "text/html; charset=utf-8");
                assert.match(await unknown.text(), /<h1 id="error-title">[\s\S]*<span data-text="error-title">404 Not Found<\/span><\/h1>/u);
            }

            const browser = await chromium.launch();
            try {
                await discovery.test("{§web-installation} browser recognizes app metadata and decodes every icon", () => verifyWebApp(browser, base));
                await discovery.test("{§web-language} source English remains intact without translation or persistence", () => verifyDocument(browser, base));
                await discovery.test("{§web-document} {§web-arrival} classless green follows color preference and arrives at starter workspace1#session1", async () => {
                    const context = await browser.newContext({ colorScheme: "light" });
                    const checkBrowser = browserDiagnostics(context);
                    try {
                        const tab = await context.newPage();
                        await tab.goto(base);
                        await tab.waitForURL((url) => new URL(url).pathname === "/~/workspace1");
                        await tab.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        assert.equal(await tab.locator("main").getAttribute("data-page"), "session");
                        assert.match(await tab.title(), /#session1 — Plurnk$/u);
                        for (const [colorScheme, primary] of /** @type {const} */ ([["light", "rgb(20, 136, 0)"], ["dark", "rgb(78, 179, 27)"]])) {
                            await tab.emulateMedia({ colorScheme });
                            const rendered = await tab.evaluate(() => {
                                const root = getComputedStyle(document.documentElement);
                                const probe = document.createElement("a");
                                document.body.append(probe);
                                const resolvedPrimary = getComputedStyle(probe).color;
                                probe.remove();
                                return {
                                    primary: resolvedPrimary,
                                    scheme: root.colorScheme,
                                    padding: parseFloat(getComputedStyle(document.querySelector("main")).paddingTop),
                                    font: getComputedStyle(document.querySelector("main")).fontFamily,
                                    monospace: root.getPropertyValue("--otm-font-family-monospace").trim(),
                                };
                            });
                            assert.equal(rendered.primary, primary);
                            assert.equal(rendered.scheme, "light dark");
                            assert.ok(rendered.padding > 0, "semantic main receives the substrate layout");
                            assert.deepEqual(rendered.font.split(",").map((name) => name.trim()),
                                rendered.monospace.split(",").map((name) => name.trim()),
                                "the document inherits the system monospace stack");
                        }
                        checkBrowser();
                    } finally {
                        await context.close();
                    }
                });
            } finally {
                await browser.close();
            }
        });
    });

    await verifySessions({ t, consumer, withDaemon, webPackage });
    await verifySessionPage({ t, withDaemon });
    await verifySessionCommands({ t, withDaemon });
    await verifySessionInput({ t, withDaemon });
    await verifySessionHistory({ t, withDaemon });
    await verifySessionApproval({ t, withDaemon });
    await verifySessionQuestions({ t, withDaemon });
    await verifySharedReview({ t, withDaemon, consumer });
    await verifyWorkspaceTabs({ t, withDaemon });
    await verifyWorkspaceSettings({ t, withDaemon });
    await closeSharedDaemons();

    await t.test("{§web-host} {§web-configuration} omitted package leaves root unclaimed; contained settings withhold only their part", async () => {
        const savedWeb = join(directory, "omitted-plurnk-web");
        await rename(webPackage, savedWeb);
        try {
            await withDaemon({}, async (base) => {
                const res = await fetch(base);
                assert.equal(res.status, 404);
                const problem = await res.json();
                assert.match(problem.type, /route-not-found/u);
            });
        } finally {
            await rename(savedWeb, webPackage);
        }
        await withDaemon({ PLURNK_WEB_DIAGRAM_THREADS: "0" }, async (base, daemon) => {
            assert.equal((await fetch(base)).status, 200);
            assert.equal((await fetch(new URL("/render/mermaid", base), {
                method: "POST",
                headers: { "content-type": "application/json", origin: new URL(base).origin },
                body: JSON.stringify({ source: "flowchart LR\n A-->B" }),
            })).status, 503);
            assert.match(daemon.stdout() + daemon.stderr(), /PLURNK_WEB_DIAGRAM_THREADS/u);
        });
    });

    await t.test("{§web-brand} {§web-assets} {§web-browser-security} custom brand CSS, icon, manifest, and About links render under strict CSP and fail hard on missing brand files", async () => {
        const brandTheme = join(directory, "acme-theme.css");
        const brandIcon = join(directory, "acme-icon.svg");
        await writeFile(brandTheme, "@layer scheme { :root { --acme-brand-probe: 23px; --otm-primary: #0055aa; } }\n");
        await writeFile(brandIcon, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0055aa"/></svg>\n');

        await withDaemon({
            PLURNK_WEB_APP_NAME: "Acme Studio",
            PLURNK_WEB_APP_DESCRIPTION: "Acme hosted agent workspace.",
            PLURNK_WEB_THEME_COLOR: "#0055aa",
            PLURNK_WEB_ABOUT_LINKS: JSON.stringify([
                { label: "Support", url: "https://support.acme.example" },
                { label: "Terms", url: "https://acme.example/terms" },
            ]),
            PLURNK_WEB_THEME_CSS_FILE: brandTheme,
            PLURNK_WEB_ICON_FILE: brandIcon,
        }, async (base) => {
            const manifest = await (await fetch(new URL("/manifest.webmanifest", base))).json();
            assert.equal(manifest.name, "Acme Studio");
            assert.equal(manifest.theme_color, "#0055aa");
            assert.deepEqual(manifest.icons, [
                { src: "/brand/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
            ]);

            const browser = await launchBrowser(chromium);
            try {
                const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                const checkBrowser = browserDiagnostics(context);
                try {
                    const page = await context.newPage();
                    await page.goto(new URL("/search/", base).href);
                    await page.locator('main[data-connection="connected"]').waitFor();
                    assert.equal(await page.title(), "Search — Acme Studio");
                    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#0055aa");
                    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/brand/icon.svg");
                    assert.equal(
                        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--acme-brand-probe").trim()),
                        "23px",
                        "startup-loaded /brand/theme.css applies under strict 'self' CSP",
                    );

                    await page.goto(new URL("/settings/#about", base).href);
                    const aboutPanel = page.locator('#workspace-settings [data-settings-panel="about"]');
                    await aboutPanel.waitFor({ state: "visible" });
                    assert.equal(await page.title(), "Settings — Acme Studio");
                    assert.equal(await aboutPanel.locator('a[href="https://support.acme.example/"]').count(), 1);
                    assert.equal(await aboutPanel.locator('a[href="https://acme.example/terms"]').count(), 1);
                    assert.match(await aboutPanel.textContent(), /MIT/u);
                    checkBrowser();
                } finally {
                    await context.close();
                }
            } finally {
                await browser.close();
            }
        });

        await assert.rejects(
            start({ PLURNK_WEB_THEME_CSS_FILE: join(directory, "does-not-exist.css") }),
            (/** @type {any} */ error) => {
                assert.equal(error.kind, "exited");
                assert.match(error.stdout + error.stderr, /ENOENT|does-not-exist\.css/u);
                return true;
            },
        );
    });

    await t.test("{§web-settings-extensions} {§web-workspace-settings} {§web-browser-security} host Settings extension tabs render under strict CSP, support zero workspaces, hydrate via plurnk:settings-section, and fail hard on unsafe HTML", async () => {
        const accountHtml = join(directory, "account-tab.html");
        const accountJs = join(directory, "account-tab.js");
        const billingHtml = join(directory, "billing-tab.html");
        const unsafeHtml = join(directory, "unsafe-tab.html");
        await writeFile(accountHtml, '<header data-panel-toolbar><h2>Account</h2></header><p data-ext-rendered>pending</p><p data-ext-count>0</p>\n');
        await writeFile(accountJs, [
            'const article = document.getElementById("workspace-settings");',
            'const output = article?.querySelector("[data-ext-rendered]");',
            'const counter = article?.querySelector("[data-ext-count]");',
            "let activations = 0;",
            "function handle(detail) {",
            '    if (!detail || detail.section !== "account") return;',
            "    activations += 1;",
            '    if (output) output.textContent = `${detail.section}|ws=${detail.workspaceName || ""}|sess=${detail.sessionName ?? "none"}`;',
            "    if (counter) counter.textContent = String(activations);",
            "}",
            "if (article) {",
            '    article.addEventListener("plurnk:settings-section", (event) => handle(event.detail));',
            '    if (article.dataset.activeSection === "account") {',
            '        const main = document.getElementById("main");',
            '        handle({ section: "account", workspaceName: main?.dataset.workspaceName ?? "", sessionName: main?.dataset.sessionName || null });',
            "    }",
            "}",
            "",
        ].join("\n"));
        await writeFile(billingHtml, '<header data-panel-toolbar><h2>Billing</h2></header><p data-billing-copy>Self-hosted plan</p>\n');
        await writeFile(unsafeHtml, '<p>Bad</p><script>window.__xss = 1;</script>\n');

        await withDaemon({
            PLURNK_WEB_SETTINGS_TABS: JSON.stringify([
                { id: "account", label: "Account", htmlFile: accountHtml, scriptFile: accountJs },
                { id: "billing", label: "Billing", htmlFile: billingHtml },
            ]),
        }, async (base) => {
            const settingsRes = await fetch(new URL("/settings/", base));
            assert.equal(settingsRes.status, 200);
            assert.equal(settingsRes.headers.get("x-frame-options"), "DENY");
            assert.match(settingsRes.headers.get("content-security-policy") ?? "", /script-src 'self'[\s\S]*frame-ancestors 'none'/u);
            const searchHtml = await (await fetch(new URL("/search/", base))).text();
            assert.doesNotMatch(searchHtml, /\/brand\/tabs\/account\.js/u, "non-settings pages never load extension scripts");

            const browser = await launchBrowser(chromium);
            try {
                const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                const checkBrowser = browserDiagnostics(context);
                try {
                    const page = await context.newPage();

                    // 1. Works cleanly with zero workspaces when deep-linked directly to an extension tab.
                    await page.goto(new URL("/settings/#account", base).href);
                    const accountPanel = page.locator('#workspace-settings [data-settings-panel="account"]');
                    await accountPanel.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("[data-ext-rendered]")?.textContent === "account|ws=|sess=none");
                    assert.equal(await page.locator('#workspace-settings [data-settings-section="account"]').getAttribute("aria-current"), "true");

                    const navOrder = await page.locator("#workspace-settings [data-settings-nav] a[data-settings-section]").evaluateAll(
                        (els) => els.map((el) => el.getAttribute("data-settings-section")),
                    );
                    assert.ok(navOrder.indexOf("env") < navOrder.indexOf("account"));
                    assert.ok(navOrder.indexOf("account") < navOrder.indexOf("billing"));
                    assert.ok(navOrder.indexOf("billing") < navOrder.indexOf("help"));
                    assert.ok(navOrder.indexOf("help") < navOrder.indexOf("about"));

                    // 2. HTML-only extension tab renders and updates hash without errors.
                    await page.locator('#workspace-settings [data-settings-section="billing"]').click();
                    const billingPanel = page.locator('#workspace-settings [data-settings-panel="billing"]');
                    await billingPanel.waitFor({ state: "visible" });
                    assert.equal(await billingPanel.locator("[data-billing-copy]").textContent(), "Self-hosted plan");
                    assert.equal(new URL(page.url()).hash, "#billing");

                    // 3. Create starter workspace1#session1 via arrival, then open /settings/?workspace=workspace1&session=session1#account.
                    await page.goto(base);
                    await page.waitForURL((url) => new URL(url).pathname === "/~/workspace1");
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");

                    await page.goto(new URL("/settings/?workspace=workspace1&session=session1#account", base).href);
                    await accountPanel.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("[data-ext-rendered]")?.textContent === "account|ws=workspace1|sess=session1");
                    assert.equal(await accountPanel.locator("[data-ext-count]").textContent(), "1");

                    // 4. Switch to native Workspace tab and back to Account without errors.
                    await page.locator('#workspace-settings [data-settings-section="workspace"]').click();
                    await page.locator('#workspace-settings [data-settings-panel="workspace"]').waitFor({ state: "visible" });
                    await page.locator('#workspace-settings [data-settings-section="account"]').click();
                    await accountPanel.waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("[data-ext-count]")?.textContent === "2");
                    assert.equal(new URL(page.url()).hash, "#account");

                    checkBrowser();
                } finally {
                    await context.close();
                }
            } finally {
                await browser.close();
            }
        });

        await assert.rejects(
            start({
                PLURNK_WEB_SETTINGS_TABS: JSON.stringify([
                    { id: "unsafe", label: "Unsafe", htmlFile: unsafeHtml },
                ]),
            }),
            (/** @type {any} */ error) => {
                assert.equal(error.kind, "exited");
                assert.match(error.stdout + error.stderr, /PLURNK_WEB_SETTINGS_TABS|<script>/u);
                return true;
            },
        );
    });

    await t.test("{§web-bff-auth} {§web-browser-security} BFF reverse-proxy cookie auth carries HttpOnly cookies across HTTP/WS/SSE, routes 401 to BFF login without OIDC discovery, preserves drafts, and POSTs logout", async () => {
        await withDaemon({
            PLURNK_WEB_AUTH_LOGIN_URL: "/bff/login?next={returnTo}",
            PLURNK_WEB_AUTH_LOGOUT_URL: "/bff/logout",
            PLURNK_WEB_AUTH_LOGOUT_METHOD: "POST",
        }, async (base) => {
            const daemonUrl = new URL(base);
            let sessionValid = false;
            let wellKnownHits = 0;
            let authenticatedAcpHttp = 0;
            let authenticatedAcpWs = 0;
            let authenticatedNotifications = 0;
            /** @type {string[]} */
            const loginCalls = [];
            /** @type {Array<{ method: string | undefined, hasCookie: boolean }>} */
            const logoutCalls = [];
            /** @type {Set<import("node:stream").Duplex>} */
            const wsSockets = new Set();
            /** @type {Set<import("node:net").Socket>} */
            const httpSockets = new Set();

            const hasValidCookie = (/** @type {import("node:http").IncomingMessage} */ req) =>
                sessionValid && typeof req.headers.cookie === "string" && req.headers.cookie.includes("bff_session=valid-token");

            const proxy = createHttpServer((req, res) => {
                const rawUrl = req.url ?? "/";
                const parsed = new URL(rawUrl, "http://bff.local");
                if (parsed.pathname.startsWith("/.well-known/")) {
                    wellKnownHits += 1;
                    res.writeHead(404, { "content-type": "text/plain" });
                    res.end("not found");
                    return;
                }
                if (parsed.pathname === "/bff/login" && req.method === "GET") {
                    loginCalls.push(rawUrl);
                    sessionValid = true;
                    const nextTarget = parsed.searchParams.get("next") || "/";
                    res.writeHead(303, {
                        "set-cookie": "bff_session=valid-token; HttpOnly; SameSite=Lax; Path=/",
                        location: nextTarget,
                    });
                    res.end();
                    return;
                }
                if (parsed.pathname === "/bff/logout") {
                    logoutCalls.push({ method: req.method, hasCookie: hasValidCookie(req) });
                    sessionValid = false;
                    res.writeHead(303, {
                        "set-cookie": "bff_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/",
                        location: "/bff/signed-out",
                    });
                    res.end();
                    return;
                }
                if (parsed.pathname === "/bff/signed-out") {
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                    res.end('<!doctype html><title>Signed out</title><p id="bff-signed-out">Signed out by BFF</p>');
                    return;
                }
                const isProtectedApi = parsed.pathname === "/acp"
                    || parsed.pathname.startsWith("/acp/")
                    || parsed.pathname === "/notifications"
                    || parsed.pathname.startsWith("/notifications/")
                    || parsed.pathname === "/render/mermaid";
                if (isProtectedApi) {
                    if (!hasValidCookie(req)) {
                        const body = Buffer.from(JSON.stringify({
                            type: "https://problems.plurnk.xyz/auth/unauthorized",
                            title: "Unauthorized",
                            status: 401,
                            detail: "BFF session expired.",
                        }));
                        res.writeHead(401, {
                            "content-type": "application/problem+json",
                            "content-length": body.byteLength,
                        });
                        res.end(body);
                        req.resume();
                        return;
                    }
                    if (parsed.pathname === "/acp") authenticatedAcpHttp += 1;
                    if (parsed.pathname.startsWith("/notifications")) authenticatedNotifications += 1;
                }
                const upstream = httpRequest({
                    hostname: daemonUrl.hostname,
                    port: Number(daemonUrl.port),
                    path: rawUrl,
                    method: req.method,
                    headers: req.headers,
                }, (upRes) => {
                    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
                    upRes.pipe(res);
                });
                upstream.on("error", () => {
                    if (!res.headersSent) res.writeHead(502);
                    res.end();
                });
                req.pipe(upstream);
            });
            proxy.on("connection", (socket) => {
                httpSockets.add(socket);
                socket.on("close", () => { httpSockets.delete(socket); });
            });
            proxy.on("upgrade", (req, socket, head) => {
                if (!hasValidCookie(req)) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
                    socket.destroy();
                    return;
                }
                authenticatedAcpWs += 1;
                wsSockets.add(socket);
                const upstream = netConnect(Number(daemonUrl.port), daemonUrl.hostname, () => {
                    let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
                    for (let i = 0; i < req.rawHeaders.length; i += 2) {
                        rawRequest += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
                    }
                    rawRequest += "\r\n";
                    upstream.write(rawRequest);
                    if (head.byteLength > 0) upstream.write(head);
                    socket.pipe(upstream);
                    upstream.pipe(socket);
                });
                wsSockets.add(upstream);
                const cleanup = () => {
                    wsSockets.delete(socket);
                    wsSockets.delete(upstream);
                    socket.destroy();
                    upstream.destroy();
                };
                socket.on("error", cleanup);
                upstream.on("error", cleanup);
                socket.on("close", cleanup);
                upstream.on("close", cleanup);
            });
            proxy.listen(0, "127.0.0.1");
            await once(proxy, "listening");
            const proxyBase = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (proxy.address()).port}`;

            const browser = await launchBrowser(chromium);
            try {
                const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                const checkBrowser = browserDiagnostics(context);
                try {
                    const page = await context.newPage();

                    // 1. Initial visit with no cookie -> 401 on /acp -> BFF login redirect -> HttpOnly cookie -> starter session connected.
                    await page.goto(`${proxyBase}/`);
                    await page.waitForURL((url) => new URL(url).pathname === "/~/workspace1");
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    assert.deepEqual(loginCalls, ["/bff/login?next=%2F"]);
                    assert.equal(wellKnownHits, 0, "BFF login handoff never probes /.well-known/oauth-protected-resource");
                    assert.ok(authenticatedAcpHttp >= 1, "HTTP /acp carries HttpOnly same-origin cookie");
                    assert.ok(authenticatedAcpWs >= 1, "WebSocket /acp carries HttpOnly same-origin cookie");
                    assert.ok(authenticatedNotifications >= 1, "SSE /notifications carries HttpOnly same-origin cookie");
                    assert.deepEqual(
                        await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]),
                        [[], []],
                        "BFF mode stores zero tokens in browser storage",
                    );
                    const signOutBtn = page.locator('header [data-oidc-sign-out] button[data-action="sign-out"]');
                    await signOutBtn.waitFor({ state: "visible" });

                    // 2. Mid-session cookie expiry preserves unsaved draft, enters signed-out, and Sign in restores session via BFF.
                    await page.locator("#session-message").fill("Keep this BFF draft.");
                    sessionValid = false;
                    for (const sock of [...wsSockets]) sock.destroy();
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "signed-out");
                    assert.equal(await page.locator("#session-message").inputValue(), "Keep this BFF draft.");
                    assert.equal(loginCalls.length, 1, "mid-session 401 does not auto-redirect over an active draft");

                    await page.locator('#session-connection [data-action="sign-in"]').click();
                    await page.waitForURL((url) => new URL(url).pathname === "/~/workspace1");
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    assert.equal(loginCalls.length, 2);
                    assert.equal(loginCalls[1], "/bff/login?next=%2F~%2Fworkspace1%23session1");
                    assert.equal(wellKnownHits, 0);

                    // 3. Header Sign out submits a CSRF-safe top-level POST to /bff/logout with the session cookie.
                    await signOutBtn.click();
                    await page.waitForURL((url) => new URL(url).pathname === "/bff/signed-out");
                    assert.equal(await page.locator("#bff-signed-out").textContent(), "Signed out by BFF");
                    assert.deepEqual(logoutCalls, [{ method: "POST", hasCookie: true }]);

                    checkBrowser([
                        Object.assign(httpFailure("/acp", 401), { optional: true }),
                        Object.assign(httpFailure("/notifications/1", 401), { optional: true }),
                        networkFailure("/acp"),
                        Object.assign(networkFailure("/notifications"), { optional: true }),
                    ]);
                } finally {
                    await context.close();
                }
            } finally {
                await browser.close();
                for (const sock of [...wsSockets, ...httpSockets]) sock.destroy();
                await new Promise((resolve) => proxy.close(resolve));
            }
        });
    });

    await t.test("{§web-assets} missing packaged bytes fail startup", async () => {
        const asset = join(webPackage, "dist", "index.html");
        const saved = join(directory, "index.html");
        await rename(asset, saved);
        try {
            await assert.rejects(start(), (/** @type {any} */ error) => {
                assert.equal(error.kind, "exited");
                assert.match(error.stdout + error.stderr, /ENOENT/u);
                assert.match(error.stdout + error.stderr, /index\.html/u);
                return true;
            });
        } finally {
            await rename(saved, asset);
        }
    });

    await t.test("{§web-host} duplicate root owner is rejected by the host", async () => {
        const conflictHook = join(directory, "conflict-hook.mjs");
        await writeFile(conflictHook, `import { registerHooks } from "node:module";
registerHooks({
    load(url, context, nextLoad) {
        if (!url.endsWith("/@plurnk/plurnk-acp/dist/daemon-module.js")) return nextLoad(url, context);
        return {
            format: "module",
            shortCircuit: true,
            source: \`import createAcp from \${JSON.stringify(\`\${url}?real\`)};
export default () => {
    const mod = createAcp();
    return { ...mod, mounts: [...(mod.mounts ?? []), "/"] };
};\`,
        };
    },
});\n`);
        try {
            await assert.rejects(start({ NODE_OPTIONS: `--import=${pathToFileURL(conflictHook).href}` }), (/** @type {any} */ error) => {
                assert.equal(error.kind, "exited");
                assert.match(error.stdout + error.stderr, /plurnk-web/u);
                assert.match(error.stdout + error.stderr, /plurnk-acp/u);
                return true;
            });
        } finally {
            await rm(conflictHook, { force: true });
        }
    });

    const installedManifest = JSON.parse(await readFile(join(webPackage, "package.json"), "utf8"));
    assert.equal(installedManifest.name, "@plurnk/plurnk-web");
    assert.deepEqual(installedManifest.exports["./module"], {
        types: "./types/module.d.ts",
        default: "./src/module.js",
    });
});
