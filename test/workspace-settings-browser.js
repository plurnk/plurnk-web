import assert from "node:assert/strict";
import { chromium } from "playwright";
import { directoryPath } from "../src/directory-addresses.js";
import SessionAgent from "../web/session-agent.js";
import browserDiagnostics from "./browser-diagnostics.js";
import { launchBrowser } from "./engines.js";
import verifyPageShell from "./page-shell.js";
import { acquireSharedDaemon, onAcpSent } from "./session-input.js";

/**
 * @param {string} base
 * @param {string} [sessionId]
 */
function createAgent(base, sessionId) {
    return new SessionAgent({ url: new URL("/acp", base).href, ...(sessionId ? { sessionId } : {}), headers: {} });
}

// {§web-workspace-settings} End-to-end verification of workspace and session settings against a real packed daemon on zero-session workspace and live Session pages.
export default async function verifyWorkspaceSettings({ t, withDaemon }) {
    await t.test("{§web-workspace-settings} zero-session workspace and live Session tabs manage MCP, schedules, personas, session policies, and masked env without session/resume or stacked modals", { timeout: 60_000 }, async () => {
        const { model, base } = await acquireSharedDaemon(withDaemon, false);
        model.reset();
        const workspace = `ws-settings-${crypto.randomUUID()}`;

        // Create a zero-session workspace via workspace.env.list (creates workspace without creating a session)
        const wsCreator = createAgent(base);
        const createdWs = await wsCreator.send({
            workspace,
            action: { kind: "workspace.env.list", params: {} },
        });
        assert.equal(createdWs.result.ok, true, JSON.stringify(createdWs.result));
        wsCreator.close();

        const browser = await launchBrowser(chromium);
        try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const checkBrowser = browserDiagnostics(context);
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);

            /** @type {string[]} */
            const resumedSessions = [];
            onAcpSent(page, (body) => {
                if (body?.method === "session/resume") {
                    resumedSessions.push(String(body.params?.sessionId ?? ""));
                }
            });

            await page.goto(new URL(directoryPath({ kind: "workspace", workspace }), base).href);
            assert.equal(await page.locator("#workspace-empty").count(), 1, "zero-session workspace renders #workspace-empty");

            // Navigate to dedicated /settings/?workspace=... page from #session-workspace link in header on zero-session workspace
            await page.locator("#session-workspace").click();
            const settingsArticle = page.locator("#workspace-settings");
            await settingsArticle.waitFor({ state: "visible" });
            await verifyPageShell(page, { title: `${workspace} · Settings — Plurnk`, kind: "settings" });
            await page.setViewportSize({ width: 1280, height: 800 });

            // 1. Workspace is default tab; switch to MCP: inline disclosure keeps invalid alias draft + inline Problem visible
            assert.equal(await settingsArticle.getByRole("link", { name: "Workspace", exact: true }).getAttribute("aria-current"), "true");
            await settingsArticle.getByRole("link", { name: "MCP", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            assert.equal(await settingsArticle.getByRole("link", { name: "MCP", exact: true }).getAttribute("aria-current"), "true");
            const mcpPanel = settingsArticle.locator('[data-settings-panel="mcp"]');
            const mcpDisclosure = mcpPanel.locator('details[data-family-disclosure="mcp"]');
            assert.equal(await mcpPanel.isVisible(), true);
            await mcpDisclosure.locator("> summary").click();
            assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true);
            await mcpDisclosure.getByRole("textbox", { name: "Server alias", exact: true }).fill("123-invalid");
            await mcpDisclosure.getByRole("textbox", { name: "Server command", exact: true }).fill("echo");
            await mcpDisclosure.getByRole("button", { name: "Save server", exact: true }).click();
            await page.waitForFunction(() => (document.querySelector('#workspace-settings > [data-text="ws-settings-message"]')?.textContent ?? "").includes("123-invalid"));
            assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), true, "daemon Problem keeps MCP disclosure open");
            assert.equal(await mcpDisclosure.getByRole("textbox", { name: "Server command", exact: true }).inputValue(), "echo", "daemon Problem preserves MCP form draft");
            await mcpDisclosure.locator("> summary").click();
            assert.equal(await mcpDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false);

            // 2. Personas: add an inline persona via inline disclosure on 0-session workspace
            await settingsArticle.getByRole("link", { name: "Personas", exact: true }).click();
            const personasPanel = settingsArticle.locator('[data-settings-panel="personas"]');
            const personasDisclosure = personasPanel.locator('details[data-family-disclosure="personas"]');
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            await personasDisclosure.locator("> summary").click();
            await personasDisclosure.getByRole("textbox", { name: "Persona name", exact: true }).fill("reviewer");
            await personasDisclosure.getByRole("textbox", { name: "Persona description", exact: true }).fill("Strict code reviewer");
            await personasDisclosure.getByRole("textbox", { name: "Persona instructions", exact: true }).fill("Verify all edge cases before done.");
            await personasDisclosure.getByRole("combobox", { name: "Persona default effort", exact: true }).selectOption("high");
            await personasDisclosure.getByRole("button", { name: "Save persona", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="personas"] [data-family-rows] tr').length === 1);
            assert.equal(await personasDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false, "Save persona collapses disclosure");
            assert.match(await personasPanel.locator("[data-family-rows] tr").first().textContent(), /reviewer[\s\S]*Strict code reviewer \[high\]/u);

            // 3. Environment: set a masked workspace variable via inline disclosure on 0-session workspace
            await settingsArticle.getByRole("link", { name: "Environment", exact: true }).click();
            const envPanel = settingsArticle.locator('[data-settings-panel="env"]');
            const envDisclosure = envPanel.locator('details[data-family-disclosure="env"]');
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            await envDisclosure.locator("> summary").click();
            await envDisclosure.getByRole("textbox", { name: "Variable name", exact: true }).fill("WS_API_KEY");
            await envDisclosure.getByLabel("Variable value", { exact: true }).fill("ultra-secret-overview-token");
            await envDisclosure.getByRole("button", { name: "Set", exact: true }).click();
            await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="env"] tr[data-env-alias="WS_API_KEY"]') !== null);
            assert.equal(await envDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false, "Set variable collapses disclosure");
            assert.equal(
                await envPanel.locator('tr[data-env-alias="WS_API_KEY"] [data-text="env-origin"]').textContent(),
                "workspace",
            );
            assert.doesNotMatch(await envPanel.textContent(), /ultra-secret-overview-token/u);

            assert.equal(resumedSessions.length, 0, "0-session workspace mutations never attach or create a session");
            await page.locator("[data-settings-back]").click();
            await page.locator("#workspace-empty").waitFor({ state: "visible" });

            // 4. Create session "session1", jump to /settings/#personas from `/personas list`, then configure persona + approval mode on #session without session/resume!
            const setup = createAgent(base, "session1");
            const { result: modelRes } = await setup.send({
                workspace,
                action: { kind: "session/set_config_option", configId: "model", value: "browser" },
            });
            assert.equal(modelRes.ok, true);
            setup.close();

            await page.goto(new URL(directoryPath({ kind: "session", workspace, session: "session1" }), base).href);
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            resumedSessions.length = 0;

            const composer = page.getByRole("textbox", { name: "Message", exact: true });
            await composer.fill("/personas list");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#personas");

            await settingsArticle.waitFor({ state: "visible" });
            await settingsArticle.getByRole("link", { name: "Session", exact: true }).click();
            const sessionConfigForm = settingsArticle.locator('[data-settings-panel="session"] [data-session-config-form]');
            await sessionConfigForm.waitFor({ state: "visible" });
            assert.equal(resumedSessions.length, 0, "#session tab hydrates via session/options without calling session/resume");
            await sessionConfigForm.getByRole("combobox", { name: "Active session persona", exact: true }).selectOption("reviewer");
            await sessionConfigForm.getByRole("combobox", { name: "Approval policy", exact: true }).selectOption("review");
            await sessionConfigForm.getByRole("button", { name: "Apply to session", exact: true }).click();
            await page.waitForFunction(() => (document.querySelector("#workspace-settings > [data-text='ws-settings-message']")?.textContent ?? "").includes("Persona: reviewer"));
            assert.match(await settingsArticle.locator('> [data-text="ws-settings-message"]').textContent(), /Approval policy: review/u);

            // Schedule targeting #session1 via inline disclosure now that session exists
            await settingsArticle.getByRole("link", { name: "Schedule", exact: true }).click();
            const schedulePanel = settingsArticle.locator('[data-settings-panel="schedule"]');
            const scheduleDisclosure = schedulePanel.locator('details[data-family-disclosure="schedule"]');
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            await scheduleDisclosure.locator("> summary").click();
            assert.equal(await scheduleDisclosure.getByRole("textbox", { name: "Target session", exact: true }).inputValue(), "session1", "Target session defaults to active session");
            await scheduleDisclosure.getByRole("textbox", { name: "Schedule name", exact: true }).fill("hourly-ping");
            await scheduleDisclosure.getByRole("textbox", { name: "Schedule rule", exact: true }).fill("0 * * * *");
            await scheduleDisclosure.getByRole("textbox", { name: "Scheduled prompt", exact: true }).fill("Status check.");
            await scheduleDisclosure.getByRole("button", { name: "Save schedule", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 1);
            assert.equal(await scheduleDisclosure.evaluate((el) => /** @type {HTMLDetailsElement} */ (el).open), false, "Save schedule collapses disclosure");

            checkBrowser();
        } finally {
            await browser.close();
        }
    });
}
