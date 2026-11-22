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

// {§web-workspace-settings} End-to-end verification of workspace settings against a real packed daemon on zero-session workspace and live Session pages.
export default async function verifyWorkspaceSettings({ t, withDaemon }) {
    await t.test("{§web-workspace-settings} zero-session workspace and live Session tabs manage MCP, schedules, personas, and masked env with inline Problem recovery", { timeout: 60_000 }, async () => {
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

            // Navigate to dedicated /settings/?workspace=... page from #session-workspace link in header on zero-session workspace!
            await page.locator("#session-workspace").click();
            const settingsArticle = page.locator("#workspace-settings");
            await settingsArticle.waitFor({ state: "visible" });
            await verifyPageShell(page, { title: `${workspace} · Settings — Plurnk`, kind: "settings" });
            await page.setViewportSize({ width: 1280, height: 800 });

            // 1. General is default tab; switch to MCP: + Add server modal keeps invalid alias draft + inline Problem visible
            assert.equal(await settingsArticle.getByRole("link", { name: "General", exact: true }).getAttribute("aria-current"), "true");
            await settingsArticle.getByRole("link", { name: "MCP", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            assert.equal(await settingsArticle.getByRole("link", { name: "MCP", exact: true }).getAttribute("aria-current"), "true");
            const mcpPanel = settingsArticle.locator('[data-settings-panel="mcp"]');
            const mcpDialog = page.locator("#dialog-settings-mcp");
            assert.equal(await mcpPanel.isVisible(), true);
            await mcpPanel.getByRole("button", { name: "+ Add server", exact: true }).click();
            await mcpDialog.waitFor({ state: "visible" });
            await mcpDialog.getByRole("textbox", { name: "Server alias", exact: true }).fill("123-invalid");
            await mcpDialog.getByRole("textbox", { name: "Server command", exact: true }).fill("echo");
            await mcpDialog.getByRole("button", { name: "Save server", exact: true }).click();
            await page.waitForFunction(() => (document.querySelector('#dialog-settings-mcp [data-text="ws-settings-message"]')?.textContent ?? "").includes("123-invalid"));
            assert.equal(await mcpDialog.isVisible(), true, "daemon Problem keeps MCP dialog open");
            assert.equal(await mcpDialog.getByRole("textbox", { name: "Server command", exact: true }).inputValue(), "echo", "daemon Problem preserves MCP form draft");
            await mcpDialog.getByRole("button", { name: "Cancel", exact: true }).click();
            assert.equal(await mcpDialog.isVisible(), false);

            // 2. Personas: add an inline persona via + Add persona modal on 0-session workspace
            await settingsArticle.getByRole("link", { name: "Personas", exact: true }).click();
            const personasPanel = settingsArticle.locator('[data-settings-panel="personas"]');
            const personasDialog = page.locator("#dialog-settings-personas");
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            assert.equal(await personasPanel.locator("[data-session-persona-form]").isVisible(), false, "0-session workspace hides session persona selector");
            await personasPanel.getByRole("button", { name: "+ Add persona", exact: true }).click();
            await personasDialog.waitFor({ state: "visible" });
            await personasDialog.getByRole("textbox", { name: "Persona name", exact: true }).fill("reviewer");
            await personasDialog.getByRole("textbox", { name: "Persona description", exact: true }).fill("Strict code reviewer");
            await personasDialog.getByRole("textbox", { name: "Persona instructions", exact: true }).fill("Verify all edge cases before done.");
            await personasDialog.getByRole("combobox", { name: "Persona default effort", exact: true }).selectOption("high");
            await personasDialog.getByRole("button", { name: "Save persona", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="personas"] [data-family-rows] tr').length === 1);
            assert.equal(await personasDialog.isVisible(), false, "Save persona closes dialog");
            assert.match(await personasPanel.locator("[data-family-rows] tr").first().textContent(), /reviewer[\s\S]*Strict code reviewer \[high\]/u);

            // 3. Environment: set a masked workspace variable via + Set variable modal on 0-session workspace
            await settingsArticle.getByRole("link", { name: "Environment", exact: true }).click();
            const envPanel = settingsArticle.locator('[data-settings-panel="env"]');
            const envDialog = page.locator("#dialog-settings-env");
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            await envPanel.getByRole("button", { name: "+ Set variable", exact: true }).click();
            await envDialog.waitFor({ state: "visible" });
            await envDialog.getByRole("textbox", { name: "Variable name", exact: true }).fill("WS_API_KEY");
            await envDialog.getByLabel("Variable value", { exact: true }).fill("ultra-secret-overview-token");
            await envDialog.getByRole("button", { name: "Set", exact: true }).click();
            await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="env"] tr[data-env-alias="WS_API_KEY"]') !== null);
            assert.equal(await envDialog.isVisible(), false, "Set variable closes dialog");
            assert.equal(
                await envPanel.locator('tr[data-env-alias="WS_API_KEY"] [data-text="env-origin"]').textContent(),
                "workspace",
            );
            assert.doesNotMatch(await envPanel.textContent(), /ultra-secret-overview-token/u);

            assert.equal(resumedSessions.length, 0, "0-session workspace mutations never attach or create a session");
            await page.locator("[data-settings-back]").click();
            await page.locator("#workspace-empty").waitFor({ state: "visible" });

            // 4. Create session "session1", jump to /settings/#personas from `/personas list`, and apply `reviewer` persona to session!
            const setup = createAgent(base, "session1");
            const { result: modelRes } = await setup.send({
                workspace,
                action: { kind: "session/set_config_option", configId: "model", value: "browser" },
            });
            assert.equal(modelRes.ok, true);
            setup.close();

            await page.goto(new URL(directoryPath({ kind: "session", workspace, session: "session1" }), base).href);
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            const composer = page.getByRole("textbox", { name: "Message", exact: true });
            await composer.fill("/personas list");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#personas");

            await settingsArticle.waitFor({ state: "visible" });
            const sessionPersonaForm = settingsArticle.locator('[data-settings-panel="personas"] [data-session-persona-form]');
            await sessionPersonaForm.waitFor({ state: "visible" });
            await sessionPersonaForm.getByRole("combobox", { name: "Active session persona", exact: true }).selectOption("reviewer");
            await sessionPersonaForm.getByRole("button", { name: "Apply to session", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#workspace-settings [data-text='ws-settings-message']")?.textContent === "Session persona: reviewer.");

            // Schedule targeting #session1 via + Add schedule modal now that session exists
            await settingsArticle.getByRole("link", { name: "Schedule", exact: true }).click();
            const schedulePanel = settingsArticle.locator('[data-settings-panel="schedule"]');
            const scheduleDialog = page.locator("#dialog-settings-schedule");
            await page.waitForFunction(() => document.querySelector("#workspace-settings")?.getAttribute("aria-busy") === null);
            await schedulePanel.getByRole("button", { name: "+ Add schedule", exact: true }).click();
            await scheduleDialog.waitFor({ state: "visible" });
            assert.equal(await scheduleDialog.getByRole("textbox", { name: "Target session", exact: true }).inputValue(), "session1", "Target session defaults to active session");
            await scheduleDialog.getByRole("textbox", { name: "Schedule name", exact: true }).fill("hourly-ping");
            await scheduleDialog.getByRole("textbox", { name: "Schedule rule", exact: true }).fill("0 * * * *");
            await scheduleDialog.getByRole("textbox", { name: "Scheduled prompt", exact: true }).fill("Status check.");
            await scheduleDialog.getByRole("button", { name: "Save schedule", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 1);
            assert.equal(await scheduleDialog.isVisible(), false, "Save schedule closes dialog");

            checkBrowser();
        } finally {
            await browser.close();
        }
    });
}
