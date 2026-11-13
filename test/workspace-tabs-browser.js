import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { directoryPath } from "../src/directory-addresses.js";
import SessionAgent from "../web/session-agent.js";
import browserDiagnostics from "./browser-diagnostics.js";
import { launchBrowser } from "./engines.js";
import { acquireSharedDaemon } from "./session-input.js";

/**
 * @param {string} base
 * @param {string} sessionId
 */
function createAgent(base, sessionId) {
    return new SessionAgent({ url: new URL("/acp", base).href, sessionId, headers: {} });
}

/**
 * @param {import("playwright").Page} page
 * @param {string} sessionName
 */
async function waitConnectedSession(page, sessionName) {
    await page.waitForFunction(
        (expected) => {
            const status = document.querySelector("#session-status");
            return status?.dataset.sessionName === expected && status.dataset.connection === "connected";
        },
        sessionName,
    );
}

// {§web-workspace-tabs} End-to-end workbench switching, LRU pane bound, live worker folding, keyboard chords, and 320px/no-JS behavior.
export default async function verifyWorkspaceTabs({ t, withDaemon }) {
    await t.test("{§web-workspace-tabs} intra-workspace tabs swap resident panes without reconnecting, preserve drafts and live streams, and bound connected panes at 3", { timeout: 60_000 }, async () => {
        const { model, base } = await acquireSharedDaemon(withDaemon, false);
        model.reset();
        const workspace = `tabs-lru-${crypto.randomUUID()}`;
        let workspaceId = 0;
        for (const name of ["user", "peer", "third", "fourth"]) {
            const setup = createAgent(base, name);
            const { result } = await setup.send({
                workspace,
                action: { kind: "session/set_config_option", configId: "model", value: "browser" },
            });
            assert.equal(result.ok, true, JSON.stringify(result));
            workspaceId = /** @type {any} */ (setup.state.plurnk).workspace.id;
            setup.close();
        }

        const browser = await launchBrowser(chromium);
        try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const checkBrowser = browserDiagnostics(context);
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);

            /** @type {Map<string, number>} */
            const resumes = new Map();
            page.on("request", (request) => {
                if (new URL(request.url()).pathname !== "/acp") return;
                const body = request.postDataJSON();
                if (body?.method === "session/resume" && body?.params?._meta?.plurnk?.control === false) {
                    const id = String(body.params.sessionId ?? "");
                    resumes.set(id, (resumes.get(id) ?? 0) + 1);
                }
            });

            const wsPath = directoryPath({ kind: "workspace", workspace });
            assert.ok(wsPath);
            await page.goto(new URL(wsPath, base).href);

            const tabs = page.locator("#workspace-tabs");
            await tabs.waitFor({ state: "visible" });
            assert.equal(await tabs.locator('a[data-workspace-route="overview"]').getAttribute("aria-current"), "true");
            assert.deepEqual(
                (await tabs.locator("a[data-tab-session]").evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-session")))).toSorted(),
                ["fourth", "peer", "third", "user"],
            );
            assert.equal(resumes.size, 0, "workspace overview opens zero SessionAgent streams");

            await tabs.locator('a[data-tab-session="user"]').click();
            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname, directoryPath({ kind: "session", workspace, session: "user" }));
            assert.equal(await page.title(), `${workspace}@user — Plurnk`);
            assert.equal(await page.locator('header nav[aria-label="breadcrumb"] [aria-current="page"]').textContent(), "user");
            assert.equal(resumes.get(`${workspaceId}#user`), 1);

            const messageBox = page.getByRole("textbox", { name: "Message", exact: true });
            await messageBox.fill("Unsent draft in user");

            await tabs.locator('a[data-tab-session="peer"]').click();
            await waitConnectedSession(page, "peer");
            assert.equal(resumes.get(`${workspaceId}#peer`), 1);
            await messageBox.fill("Lifecycle fixture: held-workbench.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Considering held-workbench.", { exact: true }).waitFor();
            await messageBox.fill("Unsent draft in peer");

            await tabs.locator('a[data-tab-session="user"]').click();
            await waitConnectedSession(page, "user");
            assert.equal(await messageBox.inputValue(), "Unsent draft in user");
            assert.equal(resumes.get(`${workspaceId}#user`), 1, "resident @user swaps back with zero extra session/resume");

            await tabs.locator('a[data-tab-session="peer"]').click();
            await waitConnectedSession(page, "peer");
            assert.equal(await messageBox.inputValue(), "Unsent draft in peer");
            assert.equal(await page.getByText("Considering held-workbench.", { exact: true }).isVisible(), true);
            assert.equal(resumes.get(`${workspaceId}#peer`), 1, "resident active @peer stream stays attached across tab switches");

            await tabs.locator('a[data-tab-session="third"]').click();
            await waitConnectedSession(page, "third");
            assert.equal(resumes.get(`${workspaceId}#third`), 1);

            await tabs.locator('a[data-tab-session="fourth"]').click();
            await waitConnectedSession(page, "fourth");
            assert.equal(resumes.get(`${workspaceId}#fourth`), 1);

            await tabs.locator('a[data-tab-session="peer"]').click();
            await waitConnectedSession(page, "peer");
            assert.equal(resumes.get(`${workspaceId}#peer`), 1, "running @peer is preserved when 4th session opens");
            model.release("held-workbench");
            await page.getByText("Completed held-workbench.", { exact: true }).waitFor();

            await tabs.locator('a[data-tab-session="user"]').click();
            await waitConnectedSession(page, "user");
            assert.equal(resumes.get(`${workspaceId}#user`), 2, "oldest idle @user was LRU-evicted at 4th pane and cleanly reconnected on revisit");
            assert.equal(await messageBox.inputValue(), "Unsent draft in user", "sessionStorage draft survives LRU pane eviction");

            checkBrowser();
            await context.close();
        } finally {
            await browser.close();
        }
    });

    await t.test("{§web-workspace-tabs} live child workers materialize on notifications, stay visible while selected, fold once settled, and respond to switcher chords and mobile/no-JS layouts", { timeout: 60_000 }, async () => {
        const { model, base } = await acquireSharedDaemon(withDaemon, false);
        model.reset();
        const workspace = `tabs-live-${crypto.randomUUID()}`;
        const setup = createAgent(base, "user");
        const init = await setup.send({
            workspace,
            action: { kind: "session/set_config_option", configId: "model", value: "browser" },
        });
        assert.equal(init.result.ok, true, JSON.stringify(init.result));
        const workspaceId = /** @type {any} */ (setup.state.plurnk).workspace.id;
        setup.close();

        const forker = createAgent(base, `${workspaceId}#user`);
        const forked = await forker.send({ action: { kind: "session/fork", name: "branch" } });
        assert.equal(forked.result.ok, true, JSON.stringify(forked.result));
        forker.close();

        const browser = await launchBrowser(chromium);
        try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const checkBrowser = browserDiagnostics(context);
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);

            const userPath = directoryPath({ kind: "session", workspace, session: "user" });
            const overviewPath = directoryPath({ kind: "workspace", workspace });
            const branchPath = directoryPath({ kind: "session", workspace, session: "branch" });
            assert.ok(userPath && overviewPath && branchPath);

            await page.goto(new URL(userPath, base).href);
            await waitConnectedSession(page, "user");

            const tabs = page.locator("#workspace-tabs");
            assert.equal(await tabs.locator('li[data-session-kind="root"] a[data-tab-session="user"]').getAttribute("aria-current"), "true");
            assert.equal(await tabs.locator('li[data-session-kind="fork"] a[data-tab-session="branch"]').count(), 1);
            assert.equal(await tabs.locator('a[data-tab-session="worker"]').count(), 0);

            const composer = page.getByRole("textbox", { name: "Message", exact: true });
            await composer.fill("Lifecycle fixture: spawn-worker.");
            await page.getByRole("button", { name: "Send", exact: true }).click();

            const workerTab = tabs.locator('li[data-session-kind="work"] a[data-tab-session="worker"]');
            await workerTab.waitFor({ state: "visible" });
            await workerTab.click();
            await waitConnectedSession(page, "worker");
            await page.getByText("Worker fixture: held-worker.", { exact: true }).waitFor();
            await page.waitForFunction(() => document.querySelector("#session-status")?.getAttribute("data-lifecycle") === "running");
            while (model.requests.length < 2) await setTimeout(10);
            assert.equal(await workerTab.getAttribute("aria-current"), "true");

            model.release("held-worker");
            await page.getByText("Completed held-worker.", { exact: true }).waitFor();
            await page.waitForFunction(() =>
                document.querySelector('#workspace-tabs a[data-tab-session="worker"] [data-lifecycle]')?.getAttribute("data-lifecycle") === "completed");
            assert.equal(await workerTab.count(), 1, "settled child worker stays visible while currently selected");

            await tabs.locator('a[data-tab-session="user"]').click();
            await waitConnectedSession(page, "user");
            await page.getByText("Completed spawn-worker.", { exact: true }).waitFor();
            await page.waitForFunction(() => document.querySelector('#workspace-tabs a[data-tab-session="worker"]') === null);
            assert.equal(await tabs.locator('li[data-session-kind="fork"] a[data-tab-session="branch"]').count(), 1, "settled fork remains in top-level tabs");

            await page.keyboard.press("Control+KeyK");
            const switcher = page.locator("#dialog-workspace-switcher");
            await switcher.waitFor({ state: "visible" });
            const search = switcher.getByRole("searchbox", { name: "Jump to session", exact: true });
            await search.fill("worker");
            const visibleItems = switcher.locator("ul > li:not([hidden]) a");
            assert.equal(await visibleItems.count(), 1);
            assert.match(await visibleItems.first().textContent(), /@worker/u, "settled worker remains reachable via quick switcher");

            await page.keyboard.press("Control+KeyK");
            assert.equal(await switcher.isVisible(), false, "Ctrl+K toggles quick switcher closed");

            await page.keyboard.press("Meta+KeyK");
            await switcher.waitFor({ state: "visible" });
            assert.equal(await search.inputValue(), "", "reopening switcher resets filter");
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("Enter");
            assert.equal(await switcher.isVisible(), false);

            await page.keyboard.press("Alt+Digit1");
            await page.waitForFunction(() => document.querySelector("#main")?.dataset.page === "workspace");
            assert.equal(new URL(page.url()).pathname, overviewPath);

            await page.keyboard.press("Alt+Digit2");
            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname, userPath);

            await page.keyboard.press("Alt+BracketRight");
            await waitConnectedSession(page, "branch");
            assert.equal(new URL(page.url()).pathname, branchPath);

            await page.keyboard.press("Alt+BracketLeft");
            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname, userPath);

            await page.goBack();
            await waitConnectedSession(page, "branch");
            assert.equal(new URL(page.url()).pathname, branchPath);
            await page.goForward();
            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname, userPath);

            await page.keyboard.press("Alt+KeyN");
            const createDialog = page.locator("#dialog-session-create");
            await createDialog.waitFor({ state: "visible" });
            await createDialog.getByRole("textbox", { name: "Session name", exact: true }).fill("chord-session");
            await createDialog.getByRole("button", { name: "Confirm", exact: true }).click();
            const chordPath = directoryPath({ kind: "session", workspace, session: "chord-session" });
            assert.ok(chordPath);
            await page.waitForURL(new URL(chordPath, base).href);
            await waitConnectedSession(page, "chord-session");
            assert.equal(await tabs.locator('a[data-tab-session="chord-session"]').getAttribute("aria-current"), "true");

            checkBrowser();
            await context.close();

            const mobileContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
            const checkMobile = browserDiagnostics(mobileContext);
            const mobilePage = await mobileContext.newPage();
            mobilePage.setDefaultTimeout(10_000);
            await mobilePage.goto(new URL(userPath, base).href);
            await waitConnectedSession(mobilePage, "user");
            assert.equal(await mobilePage.locator("#workspace-tabs > ul").isVisible(), false, "320px collapses desktop strip");
            const mobileSwitcherBtn = mobilePage.locator("#workspace-tabs > button[data-workspace-switcher]");
            assert.equal(await mobileSwitcherBtn.isVisible(), true, "320px reveals compact switcher button");
            assert.equal(await mobileSwitcherBtn.locator("[data-switcher-current]").textContent(), "@user");
            assert.ok((await mobilePage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "320px session view has no horizontal overflow");
            await mobileSwitcherBtn.click();
            const mobileDialog = mobilePage.locator("#dialog-workspace-switcher");
            await mobileDialog.waitFor({ state: "visible" });
            assert.ok((await mobilePage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "320px switcher dialog has no horizontal overflow");
            await mobileDialog.locator('a[data-workspace-route="overview"]').click();
            await mobilePage.waitForFunction(() => document.querySelector("#main")?.dataset.page === "workspace");
            assert.equal(await mobileSwitcherBtn.locator("[data-switcher-current]").textContent(), "Overview");
            checkMobile();
            await mobileContext.close();

            const noJsContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 640 } });
            const checkNoJs = browserDiagnostics(noJsContext);
            const noJsPage = await noJsContext.newPage();
            noJsPage.setDefaultTimeout(10_000);
            await noJsPage.goto(new URL(userPath, base).href);
            assert.equal(await noJsPage.locator("#workspace-tabs > button[data-workspace-switcher]").isVisible(), false, "no-JS hides scripted switcher button");
            assert.equal(await noJsPage.locator("#workspace-tabs > ul").isVisible(), true, "no-JS retains native scrollable tab strip");
            assert.ok((await noJsPage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "no-JS 320px tab strip scrolls internally without page overflow");
            await noJsPage.locator('#workspace-tabs a[data-workspace-route="overview"]').click();
            assert.equal(new URL(noJsPage.url()).pathname, overviewPath);
            checkNoJs();
            await noJsContext.close();
        } finally {
            await browser.close();
        }
    });
}
