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

// {§web-workspace-tabs} {§web-session-archive} {§web-search} Browser-style session tabs across desktop and 320px mobile, active-tab /settings/sessions jump, inline + New session disclosure, simultaneous WebSocket /acp panes, live worker folding, and keyboard chords.
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
            const titler = createAgent(base, `${workspaceId}#${name}`);
            const titled = await titler.send({ action: { kind: "session/set_title", title: `Session ${name}` } });
            assert.equal(titled.result.ok, true, JSON.stringify(titled.result));
            titler.close();
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

    await t.test("{§web-workspace-tabs} {§web-session-archive} {§web-search} browser-style tab strip, /settings/sessions create & archive, Ctrl+K search, live child workers, chords, and 320px parity", { timeout: 60_000 }, async () => {
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

            // Single-session draft workspace renders visible bottom tab bar with leading + link preceding <ul>
            await page.goto(new URL(userPath, base).href);
            await waitConnectedSession(page, "user");
            const tabs = page.locator("#workspace-tabs");
            assert.equal(await tabs.getAttribute("data-tab-count"), "1");
            assert.equal(await tabs.isVisible(), true, "tab strip defends its bottom row even with 1 tab");
            const plusLink = tabs.locator("a[data-tab-new]");
            assert.equal(await plusLink.isVisible(), true);
            const barGeometry = await page.evaluate(() => {
                const statusBox = document.querySelector("#session-status")?.getBoundingClientRect();
                const barBox = document.querySelector("#workspace-tabs")?.getBoundingClientRect();
                const plusBox = document.querySelector("#workspace-tabs > a[data-tab-new]")?.getBoundingClientRect();
                const tabBox = document.querySelector("#workspace-tabs > ul > li")?.getBoundingClientRect();
                return statusBox && barBox && plusBox && tabBox
                    ? {
                        belowStatus: barBox.top >= statusBox.bottom - 1,
                        bottomGap: Math.abs(innerHeight - barBox.bottom),
                        leadingOrder: plusBox.right <= tabBox.left + 1,
                    }
                    : null;
            });
            assert.deepEqual(barGeometry && {
                belowStatus: barGeometry.belowStatus,
                atBottom: barGeometry.bottomGap <= 1,
                leadingOrder: barGeometry.leadingOrder,
            }, { belowStatus: true, atBottom: true, leadingOrder: true }, `Bottom tab bar geometry: ${JSON.stringify(barGeometry)}`);

            // Clicking the already-active tab navigates to /settings/sessions; saving a title updates the tab label on return
            await tabs.locator('a[data-tab-session="user"]').click();
            await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions");
            const sessionPanel = page.locator('#workspace-settings [data-settings-panel="sessions"]');
            await sessionPanel.waitFor({ state: "visible" });
            await sessionPanel.locator("[data-sessions-rows] tr").first().waitFor({ state: "visible" });
            await sessionPanel.locator('#session-title input[name="title"]').fill("Main chat");
            await sessionPanel.getByRole("button", { name: "Save title", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#workspace-settings > [data-text='ws-settings-message']")?.textContent === "Title: Main chat.");
            await page.locator("[data-settings-back]").click();
            await waitConnectedSession(page, "user");
            await page.waitForFunction(() => document.querySelector('#workspace-tabs a[data-tab-session="user"] [data-tab-label]')?.textContent === "Main chat");

            // Clicking + navigates to /settings/sessions?…&new=1 with + New session disclosure open & focused; confirming empty creates a sequential draft tab that folds out when leaving it untouched!
            await plusLink.click();
            await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions" && new URL(url).searchParams.get("new") === "1");
            const createDisclosure = page.locator('#workspace-settings details[data-family-disclosure="sessions"]');
            await createDisclosure.waitFor({ state: "visible" });
            await page.locator("#workspace-settings [data-sessions-rows] tr").first().waitFor({ state: "visible" });
            assert.equal(await createDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
            assert.equal(await createDisclosure.getByRole("textbox", { name: "Session name", exact: true }).inputValue(), "");
            assert.equal(await createDisclosure.getByRole("textbox", { name: "Session title", exact: true }).inputValue(), "");
            await createDisclosure.getByRole("button", { name: "Create session", exact: true }).click();
            await page.waitForURL((url) => new URL(url).pathname.startsWith("/~/"));
            await page.waitForFunction(() => {
                const active = document.querySelector('#workspace-tabs a[aria-current="true"]')?.getAttribute("data-tab-session");
                return typeof active === "string" && active !== "" && active !== "user";
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

            // Ctrl+K / Meta+K navigate to /settings/search preserving active workspace & session; Ctrl+K on /settings/search focuses the search field
            await page.keyboard.press("Control+KeyK");
            await page.waitForURL((url) => new URL(url).pathname === "/settings/search");
            await page.locator('main[data-connection="connected"]').waitFor();
            const searchInput = page.locator("#search-controls input[data-overview-search]");
            await searchInput.fill("worker");
            await page.locator('#search-workspaces a[data-session-link][aria-label="worker"]').waitFor({ state: "visible" });
            await searchInput.fill("");
            await page.locator("[data-settings-back]").focus();
            await page.keyboard.press("Control+KeyK");
            assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-overview-search")), true, "Ctrl+K focuses search input when already on /settings/search");
            await page.locator("[data-settings-back]").click();
            await waitConnectedSession(page, "user");

            await page.keyboard.press("Meta+KeyK");
            await page.waitForURL((url) => new URL(url).pathname === "/settings/search");
            await page.locator("[data-settings-back]").click();
            await waitConnectedSession(page, "user");

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
            await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions" && new URL(url).searchParams.get("new") === "1");
            await createDisclosure.waitFor({ state: "visible" });
            await page.locator("#workspace-settings [data-sessions-rows] tr").first().waitFor({ state: "visible" });
            assert.equal(await createDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
            await createDisclosure.getByRole("textbox", { name: "Session name", exact: true }).fill("chord-session");
            await createDisclosure.getByRole("textbox", { name: "Session title", exact: true }).fill("Chord title");
            await createDisclosure.getByRole("button", { name: "Create session", exact: true }).click();
            const chordPath = directoryPath({ kind: "session", workspace, session: "chord-session" });
            assert.ok(chordPath);
            await page.waitForURL(new URL(chordPath, base).href);
            await waitConnectedSession(page, "chord-session");
            assert.equal(await tabs.locator('a[data-tab-session="chord-session"]').getAttribute("aria-current"), "true");
            assert.equal(await tabs.locator('a[data-tab-session="chord-session"] [data-tab-label]').textContent(), "Chord title");

            // Clicking active chord-session tab opens /settings/sessions -> Archive redirects cleanly back to #user and surfaces #chord-session under Archived state filter!
            await tabs.locator('a[data-tab-session="chord-session"]').click();
            await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions");
            await page.locator("#workspace-settings [data-sessions-rows] tr").first().waitFor({ state: "visible" });
            await page.locator('#workspace-settings [data-settings-panel="sessions"] button[form="session-archive"]').click();
            await waitConnectedSession(page, "user");
            await page.waitForFunction(() => document.querySelector('#workspace-tabs a[data-tab-session="chord-session"]') === null);
            await page.locator("#header-session").click();
            await page.waitForURL((url) => new URL(url).pathname === "/settings/sessions");
            await page.locator("#workspace-settings [data-sessions-rows] tr").first().waitFor({ state: "visible" });
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            await page.locator('#workspace-settings [data-settings-panel="sessions"] [data-collection-filter-form] select[name="state"]').selectOption("archived");
            const archivedRow = page.locator('#workspace-settings [data-sessions-rows] tr', { hasText: "#chord-session" });
            await archivedRow.waitFor({ state: "visible" });
            assert.equal(await archivedRow.getByRole("button", { name: "Unarchive", exact: true }).isVisible(), true);

            checkBrowser();
            await context.close();

            // Below 768px (320px mobile), #workspace-tabs and #header-model hide, top bar collapses to [🔍] WSLabel#SessionLabel, and #header-session opens /settings/sessions without horizontal overflow!
            const mobileContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
            const checkMobile = browserDiagnostics(mobileContext);
            const mobilePage = await mobileContext.newPage();
            mobilePage.setDefaultTimeout(10_000);
            await mobilePage.goto(new URL(userPath, base).href);
            await waitConnectedSession(mobilePage, "user");
            const mobileTabs = mobilePage.locator("#workspace-tabs");
            assert.equal(await mobileTabs.isVisible(), false, "below 768px hides the bottom tab bar");
            assert.equal(await mobilePage.locator("#header-model").isVisible(), false, "below 768px hides #header-model in top bar");
            assert.equal(await mobilePage.locator("#session-model").isVisible(), true, "below 768px keeps #session-model in status strip");
            const mobileHeaderSession = mobilePage.locator("#header-session");
            assert.equal(await mobileHeaderSession.isVisible(), true, "below 768px keeps #header-session in top bar");
            assert.equal(await mobileHeaderSession.locator('[data-text="header-session-name"]').textContent(), "user");
            assert.ok((await mobilePage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "320px session view has no horizontal overflow");
            await mobileHeaderSession.click();
            await mobilePage.waitForURL((url) => new URL(url).pathname === "/settings/sessions");
            await mobilePage.locator('#workspace-settings [data-settings-panel="sessions"]').waitFor({ state: "visible" });
            await mobilePage.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            assert.ok((await mobilePage.evaluate(() => document.documentElement.scrollWidth)) <= 320, "320px /settings/sessions has no horizontal overflow");
            await mobilePage.locator('#workspace-settings [data-sessions-rows] a[data-session-link]', { hasText: "#branch" }).click();
            await waitConnectedSession(mobilePage, "branch");
            assert.equal(await mobileHeaderSession.locator('[data-text="header-session-name"]').textContent(), "branch");
            checkMobile();
            await mobileContext.close();
        } finally {
            await browser.close();
        }
    });
}
