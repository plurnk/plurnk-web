import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { directoryPath } from "../src/directory-addresses.js";
import SessionAgent from "../web/session-agent.js";
import browserDiagnostics from "./browser-diagnostics.js";
import { launchBrowser } from "./engines.js";
import { acquireSharedDaemon, onAcpSent } from "./session-input.js";

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

// {§web-workspace-tabs} {§web-session-archive} Browser-style session tabs across desktop and 320px mobile, active-tab management dialog, inline × archive, trailing + draft hygiene, simultaneous WebSocket /acp panes, live worker folding, and keyboard chords.
export default async function verifyWorkspaceTabs({ t, withDaemon }) {
    await t.test("{§web-workspace-tabs} intra-workspace #session tabs keep all visited WebSocket /acp panes live without LRU eviction and preserve drafts and streams", { timeout: 60_000 }, async () => {
        const { model, base } = await acquireSharedDaemon(withDaemon, false);
        model.reset();
        const workspace = `tabs-ws-${crypto.randomUUID()}`;
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
            const titleRes = await fetch(new URL("/sessions/title", base), {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
                body: new URLSearchParams({ workspace, session: name, title: `Session ${name}` }),
                redirect: "manual",
            });
            assert.equal(titleRes.status, 303);
        }

        const browser = await launchBrowser(chromium);
        try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const checkBrowser = browserDiagnostics(context);
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);

            /** @type {Map<string, number>} */
            const resumes = new Map();
            onAcpSent(page, (body) => {
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
            assert.deepEqual(
                (await tabs.locator("a[data-tab-session]").evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-session")))).toSorted(),
                ["fourth", "peer", "third", "user"],
            );

            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, directoryPath({ kind: "session", workspace, session: "user" }));
            assert.equal(await page.title(), `${workspace}#user — Plurnk`);
            assert.equal(await tabs.locator('a[aria-current="true"]').getAttribute("data-tab-session"), "user");
            assert.equal(resumes.get(`${workspaceId}#user`), 1);

            const messageBox = page.getByRole("textbox", { name: "Message", exact: true });
            await messageBox.fill("Unsent draft in user");

            await tabs.locator('a[data-tab-session="peer"]').click();
            await waitConnectedSession(page, "peer");
            assert.equal(resumes.get(`${workspaceId}#peer`), 1);
            await messageBox.fill("Lifecycle fixture: held-workbench.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').waitFor({ state: "attached" });
            await messageBox.fill("Unsent draft in peer");

            await tabs.locator('a[data-tab-session="user"]').click();
            await waitConnectedSession(page, "user");
            assert.equal(await messageBox.inputValue(), "Unsent draft in user");
            assert.equal(resumes.get(`${workspaceId}#user`), 1, "resident #user swaps back with zero extra session/resume");

            await tabs.locator('a[data-tab-session="peer"]').click();
            await waitConnectedSession(page, "peer");
            assert.equal(await messageBox.inputValue(), "Unsent draft in peer");
            assert.equal(await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').count(), 1);
            assert.equal(resumes.get(`${workspaceId}#peer`), 1, "resident active #peer stream stays attached across tab switches");

            await tabs.locator('a[data-tab-session="third"]').click();
            await waitConnectedSession(page, "third");
            assert.equal(resumes.get(`${workspaceId}#third`), 1);

            await tabs.locator('a[data-tab-session="fourth"]').click();
            await waitConnectedSession(page, "fourth");
            assert.equal(resumes.get(`${workspaceId}#fourth`), 1);

            await tabs.locator('a[data-tab-session="peer"]').click();
            await waitConnectedSession(page, "peer");
            assert.equal(resumes.get(`${workspaceId}#peer`), 1, "running #peer stays live when 4th session opens");
            model.release("held-workbench");
            await page.getByText("Completed held-workbench.", { exact: true }).waitFor();

            await tabs.locator('a[data-tab-session="user"]').click();
            await waitConnectedSession(page, "user");
            assert.equal(resumes.get(`${workspaceId}#user`), 1, "all 4 sessions stay simultaneously live over WebSocket /acp without LRU eviction");
            assert.equal(await messageBox.inputValue(), "Unsent draft in user");

            checkBrowser();
            await context.close();
        } finally {
            await browser.close();
        }
    });

    await t.test("{§web-workspace-tabs} {§web-session-archive} browser-style tab strip, active-tab manage dialog, inline × archive, trailing + draft folding, live child workers, chords, and 320px/no-JS parity", { timeout: 60_000 }, async () => {
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

        const browser = await launchBrowser(chromium);
        try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const checkBrowser = browserDiagnostics(context);
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);

            const userPath = directoryPath({ kind: "session", workspace, session: "user" });
            const branchPath = directoryPath({ kind: "session", workspace, session: "branch" });
            assert.ok(userPath && branchPath);

            // Single-session draft workspace renders visible Google Sheets-style bottom tab bar with leading + and ☰ preceding <ul>
            await page.goto(new URL(userPath, base).href);
            await waitConnectedSession(page, "user");
            const tabs = page.locator("#workspace-tabs");
            assert.equal(await tabs.getAttribute("data-tab-count"), "1");
            assert.equal(await tabs.isVisible(), true, "tab strip defends its bottom row even with 1 tab");
            const plusBtn = tabs.locator('form[data-tab-new] > button');
            const archivesBtn = tabs.locator("button[data-open-sessions]");
            assert.equal(await plusBtn.isVisible(), true);
            assert.equal(await archivesBtn.isVisible(), true);
            const barGeometry = await page.evaluate(() => {
                const statusBox = document.querySelector("#session-status")?.getBoundingClientRect();
                const barBox = document.querySelector("#workspace-tabs")?.getBoundingClientRect();
                const plusBox = document.querySelector('#workspace-tabs > form[data-tab-new] > button')?.getBoundingClientRect();
                const archivesBox = document.querySelector("#workspace-tabs > button[data-open-sessions]")?.getBoundingClientRect();
                const tabBox = document.querySelector("#workspace-tabs > ul > li")?.getBoundingClientRect();
                return statusBox && barBox && plusBox && archivesBox && tabBox
                    ? {
                        belowStatus: barBox.top >= statusBox.bottom - 1,
                        bottomGap: Math.abs(innerHeight - barBox.bottom),
                        leadingOrder: plusBox.left < archivesBox.left && archivesBox.right <= tabBox.left + 1,
                    }
                    : null;
            });
            assert.deepEqual(barGeometry && {
                belowStatus: barGeometry.belowStatus,
                atBottom: barGeometry.bottomGap <= 1,
                leadingOrder: barGeometry.leadingOrder,
            }, { belowStatus: true, atBottom: true, leadingOrder: true }, `Google Sheets bottom tab bar geometry: ${JSON.stringify(barGeometry)}`);

            // Clicking the already-active tab opens #dialog-session-manage; saving a title updates the tab label via ACP session/set_title
            await tabs.locator('a[data-tab-session="user"]').click();
            const manageDialog = page.locator("#dialog-session-manage");
            await manageDialog.waitFor({ state: "visible" });
            await manageDialog.locator('#session-title input[name="title"]').fill("Main chat");
            await manageDialog.getByRole("button", { name: "Change title", exact: true }).click();
            await page.waitForFunction(() => !document.querySelector("#dialog-session-manage")?.hasAttribute("open"));
            await page.waitForFunction(() => document.querySelector('#workspace-tabs a[data-tab-session="user"] [data-tab-label]')?.textContent === "Main chat");

            // Clicking + creates an untouched draft tab and switches to it; switching back to Main chat folds the untouched draft out!
            await plusBtn.click();
            await page.waitForFunction(() => {
                const active = document.querySelector('#workspace-tabs a[aria-current="true"]')?.getAttribute("data-tab-session");
                return active !== null && active !== "user";
            });
            assert.equal(await tabs.locator("a[data-tab-session]").count(), 2, "selected draft tab appears while active");
            await tabs.locator('a[data-tab-session="user"]').click();
            await waitConnectedSession(page, "user");
            await page.waitForFunction(() => document.querySelectorAll("#workspace-tabs a[data-tab-session]").length === 1);

            // Forking a 2nd session reveals it in #workspace-tabs live via notifications!
            const forker = createAgent(base, `${workspaceId}#user`);
            const forked = await forker.send({ action: { kind: "session/fork", name: "branch" } });
            assert.equal(forked.result.ok, true, JSON.stringify(forked.result));
            forker.close();

            await tabs.locator('li[data-session-kind="fork"] a[data-tab-session="branch"]').waitFor({ state: "visible" });
            assert.equal(await tabs.locator('li[data-session-kind="root"] a[data-tab-session="user"]').getAttribute("aria-current"), "true");
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
            assert.equal(await switcher.getByRole("link", { name: "Search workspaces and sessions…", exact: true }).getAttribute("href"), "/search/");
            const search = switcher.getByRole("searchbox", { name: "Jump to session", exact: true });
            await search.fill("worker");
            const visibleItems = switcher.locator("ul > li:not([hidden]) a");
            assert.equal(await visibleItems.count(), 1);
            assert.match(await visibleItems.first().textContent(), /#worker/u, "settled worker remains reachable via quick switcher");

            await page.keyboard.press("Control+KeyK");
            assert.equal(await switcher.isVisible(), false, "Ctrl+K toggles quick switcher closed");

            await page.keyboard.press("Meta+KeyK");
            await switcher.waitFor({ state: "visible" });
            assert.equal(await search.inputValue(), "", "reopening switcher resets filter");
            await page.keyboard.press("ArrowDown");
            await page.keyboard.press("Enter");
            assert.equal(await switcher.isVisible(), false);

            await page.keyboard.press("Alt+Digit2");
            await waitConnectedSession(page, "branch");
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, branchPath);

            await page.keyboard.press("Alt+Digit1");
            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, userPath);

            await page.keyboard.press("Alt+BracketRight");
            await waitConnectedSession(page, "branch");
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, branchPath);

            await page.keyboard.press("Alt+BracketLeft");
            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, userPath);

            await page.goBack();
            await waitConnectedSession(page, "branch");
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, branchPath);
            await page.goForward();
            await waitConnectedSession(page, "user");
            assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, userPath);

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

            // Clicking active chord-session tab opens #dialog-session-manage -> Archive session over ACP, switches cleanly back to #user, and surfaces Archived sessions (1) in ☰!
            await tabs.locator('a[data-tab-session="chord-session"]').click();
            await manageDialog.waitFor({ state: "visible" });
            await manageDialog.locator('#session-archive button[type="submit"]').click();
            await waitConnectedSession(page, "user");
            await page.waitForFunction(() => document.querySelector('#workspace-tabs a[data-tab-session="chord-session"]') === null);
            await archivesBtn.click();
            await switcher.waitFor({ state: "visible" });
            assert.match(await switcher.locator("[data-switcher-archived] summary").innerText(), /Archived sessions \(1\)/u);
            await switcher.locator("button[data-dialog-close]").click();
            await switcher.waitFor({ state: "hidden" });

            checkBrowser();
            await context.close();

            // Below 768px (320px mobile), #workspace-tabs hides and #session-controls ☰ opens the session switcher without horizontal overflow!
            const mobileContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
            const checkMobile = browserDiagnostics(mobileContext);
            const mobilePage = await mobileContext.newPage();
            mobilePage.setDefaultTimeout(10_000);
            await mobilePage.goto(new URL(userPath, base).href);
            await waitConnectedSession(mobilePage, "user");
            const mobileTabs = mobilePage.locator("#workspace-tabs");
            assert.equal(await mobileTabs.isVisible(), false, "below 768px hides the bottom tab bar");
            const mobileMenuBtn = mobilePage.locator('[aria-label="Session controls"] button[data-open-sessions]');
            assert.equal(await mobileMenuBtn.isVisible(), true, "below 768px renders ☰ in #session-controls");
            assert.ok((await mobilePage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "320px session view has no horizontal overflow");
            await mobileMenuBtn.click();
            const mobileSwitcher = mobilePage.locator("#dialog-workspace-switcher");
            await mobileSwitcher.waitFor({ state: "visible" });
            await mobileSwitcher.locator('a[href="#branch"]').click();
            await waitConnectedSession(mobilePage, "branch");
            await mobileMenuBtn.click();
            await mobileSwitcher.waitFor({ state: "visible" });
            await mobileSwitcher.getByRole("button", { name: "Session options…", exact: true }).click();
            const mobileManage = mobilePage.locator("#dialog-session-manage");
            await mobileManage.waitFor({ state: "visible" });
            assert.ok((await mobilePage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "320px session manage dialog has no horizontal overflow");
            await mobileManage.locator("button[data-dialog-close]").click();
            checkMobile();
            await mobileContext.close();

            const noJsContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 640 } });
            const checkNoJs = browserDiagnostics(noJsContext);
            const noJsPage = await noJsContext.newPage();
            noJsPage.setDefaultTimeout(10_000);
            await noJsPage.goto(new URL(userPath, base).href);
            assert.equal(await noJsPage.locator("#workspace-tabs > ul").isVisible(), true, "no-JS retains native scrollable tab strip");
            assert.ok((await noJsPage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "no-JS 320px tab strip scrolls internally without page overflow");
            checkNoJs();
            await noJsContext.close();
        } finally {
            await browser.close();
        }
    });
}
