import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { WEB_VERSION } from "../src/documents.js";
import SessionAgent from "../web/session-agent.js";
import browserDiagnostics, { httpFailure, networkFailure } from "./browser-diagnostics.js";
import { launchBrowser } from "./engines.js";
import startMockOidcIdp from "./mock-oidc-idp.js";
import startModel from "./model-fixture.js";
import verifyPageShell from "./page-shell.js";
import verifySessionDirectory from "./session-directory-browser.js";

/**
 * @param {string} base
 * @param {string} [sessionId]
 * @param {Record<string, string>} [headers]
 */
function createAgent(base, sessionId = "", headers = {}) {
    return new SessionAgent({
        url: new URL("/acp", base).href,
        ...(sessionId ? { sessionId } : {}),
        headers,
    });
}

/**
 * Read daemon workspace & session census strictly over public `/acp`.
 * @param {string} base
 * @param {Record<string, string>} [headers]
 */
async function readAcpCensus(base, headers = {}) {
    const agent = createAgent(base, "", headers);
    try {
        const listed = await agent.send({ action: { kind: "workspace.list", includeArchived: true } });
        assert.equal(listed.result.ok, true, JSON.stringify(listed.result));
        const workspaces = /** @type {any[]} */ (listed.result.result.workspaces ?? []);
        const enriched = [];
        for (const ws of workspaces) {
            const sessAgent = createAgent(base, "", headers);
            const sessRes = await sessAgent.send({
                workspace: ws.name,
                action: { kind: "workspace.sessions", workspaceId: ws.id, includeArchived: true },
            });
            sessAgent.close();
            assert.equal(sessRes.result.ok, true, JSON.stringify(sessRes.result));
            const sessions = [];
            for (const s of sessRes.result.result.sessions ?? []) {
                let loops = [];
                if (s.origin === "model") {
                    const loopsAgent = createAgent(base, `${ws.id}#${s.name}`, headers);
                    const loopsRes = await loopsAgent.send({
                        action: { kind: "session.loops", workspaceId: ws.id, session: s.name },
                    });
                    loopsAgent.close();
                    if (loopsRes.result.ok) {
                        loops = loopsRes.result.result.items ?? [];
                    }
                }
                sessions.push({ ...s, loops });
            }
            enriched.push({ ...ws, sessions });
        }
        return enriched;
    } finally {
        agent.close();
    }
}

export default async function verifySessions({ t, consumer, withDaemon, webPackage }) {
    const projectRoot = join(consumer, "directory-project");
    await mkdir(projectRoot, { recursive: true });
    t.after(() => rm(projectRoot, { recursive: true, force: true }));

    await t.test("{§web-arrival} {§web-directory-documents} {§web-search} {§web-workspace-creation} {§web-session-creation} {§web-workspace-rename} {§web-workspace-settings} pure-ACP arrival, /settings/search directory, inline create disclosures, rename/archive, /settings/about, and 404 safety", { timeout: 120_000 }, async () => {
        await withDaemon({ PLURNK_WEB_OVERVIEW_SESSIONS: "6" }, async (base) => {
            const names = ['~/repo with space/@%2F/<script>&"', "folderless", "分析", `~/project/${"long-name-".repeat(8)}`];
            for (const name of names) {
                const wsRoot = name === names[0] ? projectRoot : null;
                const creator = createAgent(base);
                const createdWs = await creator.send({
                    action: { kind: "workspace.create", name, projectRoot: wsRoot },
                });
                assert.equal(createdWs.result.ok, true, JSON.stringify(createdWs.result));
                const wsId = createdWs.result.result.workspaceId;
                creator.close();

                const sUser = createAgent(base, "user");
                const initUser = await sUser.send({ workspace: name, action: { kind: "session/new" } });
                assert.equal(initUser.result.ok, true, JSON.stringify(initUser.result));
                sUser.close();

                if (name !== "folderless") {
                    const titler = createAgent(base, `${wsId}#user`);
                    const titled = await titler.send({ action: { kind: "session/set_title", title: "Workspace chat" } });
                    assert.equal(titled.result.ok, true, JSON.stringify(titled.result));
                    titler.close();
                }

                if (name === names[0]) {
                    const sPrimary = createAgent(base, "primary");
                    assert.equal((await sPrimary.send({ workspace: name, action: { kind: "session/new" } })).result.ok, true);
                    sPrimary.close();
                    const titlerPrimary = createAgent(base, `${wsId}#primary`);
                    assert.equal((await titlerPrimary.send({ action: { kind: "session/set_title", title: "Primary work" } })).result.ok, true);
                    titlerPrimary.close();

                    const fReview = createAgent(base, `${wsId}#primary`);
                    assert.equal((await fReview.send({ action: { kind: "session/fork", name: "review" } })).result.ok, true);
                    fReview.close();
                    const tReview = createAgent(base, `${wsId}#review`);
                    assert.equal((await tReview.send({ action: { kind: "session/set_title", title: "Review branch" } })).result.ok, true);
                    tReview.close();

                    const fEvidence = createAgent(base, `${wsId}#review`);
                    assert.equal((await fEvidence.send({ action: { kind: "session/fork", name: "evidence" } })).result.ok, true);
                    fEvidence.close();
                    const tEvidence = createAgent(base, `${wsId}#evidence`);
                    assert.equal((await tEvidence.send({ action: { kind: "session/set_title", title: "Evidence leaf" } })).result.ok, true);
                    tEvidence.close();

                    const sDraft = createAgent(base, "untouched-draft");
                    assert.equal((await sDraft.send({ workspace: name, action: { kind: "session/new" } })).result.ok, true);
                    sDraft.close();
                }
            }

            const initial = await readAcpCensus(base);
            const browser = await launchBrowser(chromium);
            try {
                const context = await browser.newContext({ userAgent: "Mozilla/5.0 plurnk-desktop/1.4.2" });
                const checkBrowser = browserDiagnostics(context);
                try {
                    const page = await context.newPage();
                    page.setDefaultTimeout(10_000);

                    // 1. GET / arrives over /acp; GET /~/ redirects 303 to /settings/search
                    await page.goto(base);
                    await page.waitForURL((url) => new URL(url).pathname.startsWith("/~/"));
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0, "loopback access renders no Sign out button");
                    assert.deepEqual(await context.cookies(), [], "pure-ACP web client sets zero cookies");

                    const tildeRes = await fetch(new URL("/~/", base), { redirect: "manual" });
                    assert.equal(tildeRes.status, 303);
                    assert.equal(tildeRes.headers.get("location"), "/settings/search");

                    // 2. /settings/search directory bounded overview, workspace markers, and tree verification
                    await page.getByRole("banner").getByRole("link", { name: "Search", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/search");
                    await page.locator('main[data-connection="connected"]').waitFor();
                    assert.ok(new URL(page.url()).searchParams.get("workspace"), "banner Search preserves active workspace return context");
                    await page.goto(new URL("/settings/search", base).href);
                    await page.locator('main[data-connection="connected"]').waitFor();
                    await verifyPageShell(page, { title: "Search — Plurnk", kind: "settings" });
                    assert.equal(await page.locator("main h1").count(), 1);

                    for (const ws of initial) {
                        const wsEntry = page.locator(`#search-workspaces > ul > li[data-workspace-id="${ws.id}"] > article`);
                        await wsEntry.waitFor();
                        assert.equal(
                            await wsEntry.locator(":scope > header").evaluate((el) => getComputedStyle(el, "::before").content.match(/☁️|🗂️/u)?.[0]),
                            ws.projectRoot === null ? "☁️" : "🗂️",
                        );
                        assert.equal(await wsEntry.getAttribute("aria-label"), ws.projectRoot === null ? "Folderless workspace" : "Project workspace");
                    }

                    const primaryWs = initial.find((ws) => ws.name === names[0]);
                    assert.ok(primaryWs);
                    await page.goto(new URL(`/settings/search?${new URLSearchParams({ filterWorkspace: primaryWs.name })}`, base).href);
                    await page.locator('main[data-connection="connected"]').waitFor();
                    await verifySessionDirectory(page, primaryWs);

                    // 3. Missing /~/missing/ renders in-page 404 without creating a workspace on the daemon
                    await page.goto(new URL("/~/missing", base).href);
                    await page.locator("#error-title").waitFor();
                    await verifyPageShell(page, { title: "404 Not Found — Plurnk", kind: "error" });
                    await page.setViewportSize({ width: 1280, height: 800 });
                    const afterMissing = await readAcpCensus(base);
                    assert.equal(afterMissing.some((ws) => ws.name === "missing"), false, "missing /~/<workspace> never allocates a workspace");

                    // 4. Archive & inline Unarchive over /acp on /settings/search?status=archived
                    const shelved = initial.find((ws) => ws.name === "folderless");
                    assert.ok(shelved);
                    const archiver = createAgent(base);
                    assert.equal((await archiver.send({ workspace: shelved.name, action: { kind: "workspace.archive", workspaceId: shelved.id, archived: true } })).result.ok, true);
                    archiver.close();

                    await page.goto(new URL("/settings/search", base).href);
                    await page.locator('main[data-connection="connected"]').waitFor();
                    const activeNames = await page.locator("#search-workspaces > ul > li > article > header > a[data-text='name']").allTextContents();
                    assert.equal(activeNames.includes("folderless"), false, "archived workspace leaves active /settings/search");

                    await page.goto(new URL("/settings/search?status=archived", base).href);
                    await page.locator('main[data-connection="connected"]').waitFor();
                    const unarchiveForm = page.locator('#search-workspaces form[data-inline-unarchive="workspace"]').filter({
                        has: page.locator('input[name="workspace"][value="folderless"]'),
                    });
                    await unarchiveForm.waitFor();
                    await unarchiveForm.getByRole("button", { name: "Unarchive", exact: true }).click();
                    await page.waitForFunction(() => document.querySelectorAll('#search-workspaces form[data-inline-unarchive="workspace"]').length === 0);

                    // 5. Inline + New workspace on /settings/workspaces, inline + New session on /settings/sessions, rename, 409 error recovery, and /settings/about
                    await page.goto(new URL("/settings/workspaces", base).href);
                    const settingsArticle = page.locator("#workspace-settings");
                    await settingsArticle.waitFor({ state: "visible" });
                    await settingsArticle.locator("[data-workspaces-rows] tr").first().waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    const wsCreateDisclosure = settingsArticle.locator('details[data-family-disclosure="workspaces"]');
                    await wsCreateDisclosure.locator("> summary").click();
                    assert.equal(await wsCreateDisclosure.locator("input[data-toggle-project-folder]").isChecked(), false);
                    assert.equal(await wsCreateDisclosure.locator("input[data-project-folder-input]").isVisible(), false);

                    // 409 duplicate workspace name keeps draft in disclosure and displays inline Problem
                    await wsCreateDisclosure.locator('input[name="name"]').fill("folderless");
                    await wsCreateDisclosure.getByRole("button", { name: "Create workspace", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-text="ws-settings-message"]')?.textContent ?? "").includes("already in use"));
                    assert.equal(await wsCreateDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
                    assert.equal(await wsCreateDisclosure.locator('input[name="name"]').inputValue(), "folderless");

                    // Clear name -> sequential workspace1 + #session1 over /acp
                    await wsCreateDisclosure.locator('input[name="name"]').fill("");
                    await wsCreateDisclosure.getByRole("button", { name: "Create workspace", exact: true }).click();
                    await page.waitForURL((url) => /^\/~\/workspace\d+$/u.test(new URL(url).pathname));
                    await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                    const createdWsName = new URL(page.url()).pathname.slice(3);
                    assert.match(createdWsName, /^workspace\d+$/u);

                    // + button -> /settings/sessions?…&new=1: 409 conflict recovery + added-session
                    await page.locator("#workspace-tabs a[data-tab-new]").click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions" && new URL(url).searchParams.get("new") === "1");
                    const sessCreateDisclosure = page.locator('#workspace-settings details[data-family-disclosure="sessions"]');
                    await sessCreateDisclosure.waitFor({ state: "visible" });
                    await page.locator("#workspace-settings [data-sessions-rows] tr").first().waitFor({ state: "visible" });
                    assert.equal(await sessCreateDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
                    await sessCreateDisclosure.locator('input[name="name"]').fill("session1");
                    await sessCreateDisclosure.getByRole("button", { name: "Create session", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-text="ws-settings-message"]')?.textContent ?? "").includes("already in use"));
                    await sessCreateDisclosure.locator('input[name="name"]').fill("added-session");
                    await sessCreateDisclosure.locator('input[name="title"]').fill("Added title");
                    await sessCreateDisclosure.getByRole("button", { name: "Create session", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === `/~/${createdWsName}` && new URL(url).hash === "#added-session");
                    await page.waitForFunction(() => document.querySelector('#workspace-tabs a[aria-current="true"]')?.getAttribute("data-tab-session") === "added-session");

                    // /settings/workspaces Rename + /settings/about (service version, package web version, desktop UA 1.4.2, MIT, issues link)
                    await page.locator("#session-workspace").click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/workspaces");
                    await settingsArticle.waitFor({ state: "visible" });

                    await settingsArticle.getByRole("link", { name: "About", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/about");
                    const aboutPanel = settingsArticle.locator('[data-settings-panel="about"]');
                    await aboutPanel.waitFor({ state: "visible" });
                    await page.waitForFunction(() => /^\d+\.\d+\.\d+/u.test(document.querySelector('#workspace-settings [data-text="about-service-version"]')?.textContent ?? ""));
                    assert.equal(await aboutPanel.locator('[data-text="about-web-version"]').textContent(), WEB_VERSION);
                    assert.match((await aboutPanel.locator('[data-text="about-service-version"]').textContent()) ?? "", /^\d+\.\d+\.\d+/u);
                    assert.equal(await aboutPanel.locator("[data-about-desktop-term]").isVisible(), true);
                    assert.equal(await aboutPanel.locator("[data-about-desktop-value]").isVisible(), true);
                    assert.equal(await aboutPanel.locator('[data-text="about-desktop-version"]').textContent(), "1.4.2");
                    assert.match(await aboutPanel.innerText(), /MIT/u);
                    assert.equal(
                        await aboutPanel.locator('a[href="https://github.com/plurnk/plurnk-service/issues"]').count(),
                        1,
                    );

                    await settingsArticle.getByRole("link", { name: "Workspaces", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/settings/workspaces");
                    await settingsArticle.locator("[data-workspaces-rows] tr").first().waitFor({ state: "visible" });
                    const renameForm = settingsArticle.locator("form#workspace-rename");
                    await renameForm.locator('input[name="name"]').fill("folderless");
                    await renameForm.getByRole("button", { name: "Rename", exact: true }).click();
                    await page.waitForFunction(() => (document.querySelector('#workspace-settings [data-text="ws-settings-message"]')?.textContent ?? "").includes("already in use"));
                    await renameForm.locator('input[name="name"]').fill("renamed-pure-acp");
                    await renameForm.getByRole("button", { name: "Rename", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/~/renamed-pure-acp");

                    checkBrowser();
                } finally {
                    await context.close();
                }
            } finally {
                await browser.close();
            }
        });

        await withDaemon({ PLURNK_SERVICE_PROJECT_ROOT_BASE: "none" }, async (base) => {
            const browser = await launchBrowser(chromium);
            try {
                const context = await browser.newContext();
                const checkBrowser = browserDiagnostics(context);
                try {
                    const page = await context.newPage();
                    await page.goto(new URL("/settings/workspaces", base).href);
                    await page.locator("#workspace-settings").waitFor({ state: "visible" });
                    await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
                    const wsCreateDisclosure = page.locator('#workspace-settings details[data-family-disclosure="workspaces"]');
                    await wsCreateDisclosure.locator("> summary").click();
                    assert.equal(await wsCreateDisclosure.locator("[data-project-folder-toggle]").isVisible(), false, "PLURNK_SERVICE_PROJECT_ROOT_BASE=none hides project folder toggle");
                    assert.equal(await wsCreateDisclosure.locator("[data-project-folder-input]").isVisible(), false, "PLURNK_SERVICE_PROJECT_ROOT_BASE=none hides project folder input");
                    checkBrowser();
                } finally {
                    await context.close();
                }
            } finally {
                await browser.close();
            }
        });
    });

    await t.test("{§web-host} {§web-configuration} {§web-browser-security} standalone 2-port cross-origin deployment connects /acp and /notifications to PLURNK_ACP_URL with zero ApplicationPort backdoors", { timeout: 90_000 }, async () => {
        const model = await startModel();
        const savedAcpUrl = process.env.PLURNK_ACP_URL;
        /** @type {import("node:http").Server | null} */
        let webServer = null;
        /** @type {Awaited<ReturnType<any>> | null} */
        let standaloneModule = null;
        try {
            webServer = createServer();
            await new Promise((resolve) => webServer.listen(0, "127.0.0.1", resolve));
            const webAddress = /** @type {import("node:net").AddressInfo} */ (webServer.address());
            const originA = `http://127.0.0.1:${webAddress.port}`;

            await withDaemon({
                ...model.env,
                PLURNK_ACP_ALLOW_ORIGIN: originA,
                PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN: originA,
            }, async (daemonBase) => {
                const acpEndpoint = new URL("/acp", daemonBase).href;
                const originB = new URL(daemonBase).origin;
                const wsOriginB = originB.replace(/^http:/u, "ws:");
                process.env.PLURNK_ACP_URL = acpEndpoint;

                const { default: createModule } = await import(`${pathToFileURL(join(webPackage, "src", "module.js")).href}?standalone=${Date.now()}`);
                let handler = null;
                standaloneModule = createModule();
                await standaloneModule.start({
                    registerHttpRoute(_mount, fn) {
                        handler = fn;
                    },
                });
                assert.equal(typeof handler, "function");
                webServer.on("request", (req, res) => handler(req, res));

                // Verify dynamic CSP headers on port A authorize HTTP + WS to port B while keeping script-src 'self'
                const shellRes = await fetch(originA);
                assert.equal(shellRes.status, 200);
                const csp = shellRes.headers.get("content-security-policy") ?? "";
                assert.match(csp, /script-src 'self'/u);
                assert.ok(csp.includes(`connect-src 'self' ${originB} ${wsOriginB}`), `expected cross-origin connect-src in CSP: ${csp}`);
                assert.ok(csp.includes(`img-src 'self' ${originB} data: blob:`), `expected cross-origin img-src in CSP: ${csp}`);
                const shellHtml = await shellRes.text();
                assert.ok(shellHtml.includes(`data-acp-url="${acpEndpoint}"`), "HTML stamps data-acp-url without inline script");

                // Seed model on starter workspace1#session1 via daemon port B
                const setup = createAgent(daemonBase, "session1");
                assert.equal((await setup.send({
                    workspace: "workspace1",
                    action: { kind: "session/set_config_option", configId: "model", value: "browser" },
                })).result.ok, true);
                setup.close();

                const browser = await launchBrowser(chromium);
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    try {
                        const page = await context.newPage();
                        page.setDefaultTimeout(10_000);
                        /** @type {string[]} */
                        const mermaidOrigins = [];
                        page.on("request", (req) => {
                            const u = new URL(req.url());
                            if (u.pathname === "/render/mermaid") mermaidOrigins.push(u.origin);
                        });

                        await page.goto(originA);
                        await page.waitForURL(`${originA}/~/workspace1#session1`);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        await page.waitForFunction(() => document.querySelector("#workspace-tabs")?.dataset.notifications === "connected");

                        const composer = page.getByRole("textbox", { name: "Message", exact: true });
                        await composer.fill("Lifecycle fixture: diagrams.");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        const figure = page.locator('[data-message-role="assistant"] [data-diagram]:not([hidden])');
                        await figure.waitFor();
                        assert.equal(
                            await figure.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0),
                            true,
                        );
                        assert.deepEqual(mermaidOrigins, [originA], "POST /render/mermaid stays same-origin on port A");

                        await page.getByRole("banner").getByRole("link", { name: "Search", exact: true }).click();
                        await page.waitForURL(`${originA}/settings/search?workspace=workspace1&session=session1`);
                        await page.locator('main[data-connection="connected"]').waitFor();
                        const session1Card = page.locator('#search-workspaces a[data-session-link][aria-label="session1"]');
                        await session1Card.waitFor();
                        assert.equal(await session1Card.count(), 1);

                        await page.goto(`${originA}/settings/about?workspace=workspace1&session=session1`);
                        const aboutPanel = page.locator('#workspace-settings [data-settings-panel="about"]');
                        await aboutPanel.waitFor({ state: "visible" });
                        await page.waitForFunction(() => /^\d+\.\d+\.\d+/u.test(document.querySelector('#workspace-settings [data-text="about-service-version"]')?.textContent ?? ""));
                        assert.equal(await aboutPanel.locator("[data-about-desktop-term]").isHidden(), true, "desktop row hidden on standard browser UA");
                        assert.equal(await aboutPanel.locator("[data-about-desktop-value]").isHidden(), true, "desktop value hidden on standard browser UA");
                        assert.match((await aboutPanel.locator('[data-text="about-service-version"]').textContent()) ?? "", /^\d+\.\d+\.\d+/u);

                        checkBrowser();
                    } finally {
                        await context.close();
                    }
                } finally {
                    await browser.close();
                }
            });
        } finally {
            if (savedAcpUrl === undefined) delete process.env.PLURNK_ACP_URL;
            else process.env.PLURNK_ACP_URL = savedAcpUrl;
            standaloneModule?.stop?.();
            await standaloneModule?.close?.().catch(() => {});
            if (webServer) {
                webServer.closeAllConnections();
                await new Promise((resolve) => webServer.close(resolve));
            }
            await model.close();
        }
    });

    await t.test("{§web-oidc} {§web-diagram-content} end-to-end OIDC Authorization Code + PKCE S256 with ES256 JWKS verification, Mermaid Bearer admission, and independent browser Sign out", { timeout: 90_000 }, async () => {
        const model = await startModel();
        const idp = await startMockOidcIdp({ clientId: "web-client", autoApprove: false });
        try {
            await withDaemon({
                ...model.env,
                PLURNK_AUTH_ISSUER: idp.issuer,
                PLURNK_AUTH_CLIENT_ID: "web-client",
            }, async (base) => {
                const driverToken = idp.mintToken();
                const setup = createAgent(base, "session1", { Authorization: `Bearer ${driverToken}` });
                assert.equal((await setup.send({
                    workspace: "workspace1",
                    action: { kind: "session/set_config_option", configId: "model", value: "browser" },
                })).result.ok, true);
                setup.close();

                const browser = await launchBrowser(chromium);
                try {
                    const context = await browser.newContext();
                    const other = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const checkOther = browserDiagnostics(other);
                    try {
                        // Browser 1: GET / -> 401 -> OIDC PKCE S256 redirect -> IdP Continue -> /auth/callback -> /~/workspace1#session1
                        const page = await context.newPage();
                        page.setDefaultTimeout(10_000);
                        await page.goto(base);
                        await page.waitForURL((url) => new URL(url).origin === idp.issuer && new URL(url).pathname === "/authorize");
                        const authUrl = new URL(page.url());
                        assert.equal(authUrl.searchParams.get("client_id"), "web-client");
                        assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
                        assert.equal(authUrl.searchParams.get("redirect_uri"), new URL("/auth/callback", base).href);

                        await page.getByRole("button", { name: "Continue", exact: true }).click();
                        await page.waitForURL(`${new URL("/~/workspace1", base).href}#session1`);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        checkBrowser([
                            Object.assign(httpFailure("/acp", 401), { optional: true }),
                            Object.assign(httpFailure("/notifications", 401), { optional: true }),
                            Object.assign(networkFailure("/acp"), { optional: true }),
                        ]);

                        const storageSnapshot = await page.evaluate(() => ({
                            localKeys: Object.keys(localStorage),
                            sessionKeys: Object.keys(sessionStorage),
                            grant: JSON.parse(localStorage.getItem("plurnk_oidc_grant") ?? "null"),
                        }));
                        assert.deepEqual(storageSnapshot.localKeys, ["plurnk_oidc_grant"]);
                        assert.deepEqual(storageSnapshot.sessionKeys, [], "ephemeral plurnk_oidc_pkce cleared after /auth/callback");
                        assert.equal(storageSnapshot.grant?.clientId, "web-client");
                        assert.equal(storageSnapshot.grant?.issuer, idp.issuer);

                        // Live prompt with Mermaid diagram rendering authenticated via Bearer JWT
                        const composer = page.getByRole("textbox", { name: "Message", exact: true });
                        await composer.fill("Lifecycle fixture: diagrams.");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        const figure = page.locator('[data-message-role="assistant"] [data-diagram]:not([hidden])');
                        await figure.waitFor();
                        assert.equal(await figure.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0), true);

                        // Browser 2 signs into /settings/search independently
                        const second = await other.newPage();
                        second.setDefaultTimeout(10_000);
                        await second.goto(new URL("/settings/search", base).href);
                        await second.waitForURL((url) => new URL(url).origin === idp.issuer && new URL(url).pathname === "/authorize");
                        await second.getByRole("button", { name: "Continue", exact: true }).click();
                        await second.waitForURL(new URL("/settings/search", base).href);
                        await second.locator('main[data-connection="connected"]').waitFor();
                        checkOther([
                            Object.assign(httpFailure("/acp", 401), { optional: true }),
                            Object.assign(httpFailure("/notifications", 401), { optional: true }),
                        ]);

                        // Browser 1 clicks header Sign out -> clears plurnk_oidc_grant and redirects to IdP; Browser 2 remains signed in
                        const signOutBtn = page.getByRole("banner").getByRole("button", { name: "Sign out", exact: true });
                        assert.equal(await signOutBtn.isVisible(), true);
                        await signOutBtn.click();
                        await page.waitForURL((url) => new URL(url).origin === idp.issuer && new URL(url).pathname === "/authorize");
                        checkBrowser([
                            Object.assign(httpFailure("/acp", 401), { optional: true }),
                            Object.assign(httpFailure("/notifications", 401), { optional: true }),
                        ]);

                        await second.reload();
                        await second.locator('main[data-connection="connected"]').waitFor();
                        assert.equal(new URL(second.url()).pathname, "/settings/search", "independent browser context retains its own OIDC grant");

                        checkBrowser();
                        checkOther();
                    } finally {
                        await context.close();
                        await other.close();
                    }
                } finally {
                    await browser.close();
                }
            });
        } finally {
            await Promise.allSettled([model.close(), idp.close()]);
        }
    });
}
