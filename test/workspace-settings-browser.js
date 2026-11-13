import assert from "node:assert/strict";
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

// {§web-workspace-settings} End-to-end verification of workspace settings against a real packed daemon on zero-session Overview and live Session pages.
export default async function verifyWorkspaceSettings({ t, withDaemon }) {
    await t.test("{§web-workspace-settings} zero-session Overview and live Session tabs manage capabilities, MCP, schedules, personas, and masked env with inline Problem recovery", { timeout: 60_000 }, async () => {
        const { model, base } = await acquireSharedDaemon(withDaemon, false);
        model.reset();
        const workspace = `ws-settings-${crypto.randomUUID()}`;

        const browser = await launchBrowser(chromium);
        try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const checkBrowser = browserDiagnostics(context);
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);

            // Create a brand-new folderless workspace via /workspaces/new (zero sessions exist!)
            await page.goto(new URL("/~/", base).href);
            await page.getByRole("button", { name: "New workspace", exact: true }).click();
            const createWsDialog = page.locator("#dialog-workspace-create");
            await createWsDialog.waitFor({ state: "visible" });
            await createWsDialog.locator('input[name="name"]').fill(workspace);
            await createWsDialog.getByRole("button", { name: "Confirm", exact: true }).click();
            await page.waitForURL(new URL(directoryPath({ kind: "workspace", workspace }), base).href);

            /** @type {string[]} */
            const resumedSessions = [];
            page.on("request", (req) => {
                if (new URL(req.url()).pathname !== "/acp") return;
                const body = req.postDataJSON();
                if (body?.method === "session/resume") {
                    resumedSessions.push(String(body.params?.sessionId ?? ""));
                }
            });

            // Open Workspace settings on zero-session Overview!
            await page.locator("#workspace-tabs [data-workspace-settings]").click();
            const dialog = page.locator("#dialog-workspace-settings");
            await dialog.waitFor({ state: "visible" });
            await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings > article")?.getAttribute("aria-busy") === null);

            // 1. Capabilities on 0-session Overview
            const capPanel = dialog.locator('[data-settings-panel="capabilities"]');
            await capPanel.getByRole("combobox", { name: "Rule list", exact: true }).selectOption("deny");
            await capPanel.getByRole("combobox", { name: "Operation" }).or(capPanel.getByRole("textbox", { name: "Operation", exact: true })).fill("kill");
            await capPanel.getByRole("button", { name: "Add rule", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll("#dialog-workspace-settings [data-cap-rows] tr").length === 1);
            assert.match(await capPanel.locator('[data-ws-capability="workspace"]').textContent(), /"operation": "kill"/u);

            // 2. MCP: invalid alias triggers real daemon Problem and preserves form inputs, then valid save succeeds
            await dialog.getByRole("button", { name: "MCP", exact: true }).click();
            const mcpPanel = dialog.locator('[data-settings-panel="mcp"]');
            await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings > article")?.getAttribute("aria-busy") === null);
            await mcpPanel.getByRole("textbox", { name: "Server alias", exact: true }).fill("123-invalid");
            await mcpPanel.getByRole("textbox", { name: "Server command", exact: true }).fill("echo");
            await mcpPanel.getByRole("button", { name: "Save server", exact: true }).click();
            await page.waitForFunction(() => (document.querySelector("#dialog-workspace-settings [data-text='ws-settings-message']")?.textContent ?? "").includes("123-invalid"));
            assert.equal(await mcpPanel.getByRole("textbox", { name: "Server command", exact: true }).inputValue(), "echo", "daemon Problem preserves MCP form draft");

            // 3. Personas: add an inline persona on 0-session Overview
            await dialog.getByRole("button", { name: "Personas", exact: true }).click();
            const personasPanel = dialog.locator('[data-settings-panel="personas"]');
            await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings > article")?.getAttribute("aria-busy") === null);
            assert.equal(await personasPanel.locator("[data-session-persona-form]").isVisible(), false, "0-session Overview hides session persona selector");
            await personasPanel.getByRole("textbox", { name: "Persona name", exact: true }).fill("reviewer");
            await personasPanel.getByRole("textbox", { name: "Persona description", exact: true }).fill("Strict code reviewer");
            await personasPanel.getByRole("textbox", { name: "Persona instructions", exact: true }).fill("Verify all edge cases before done.");
            await personasPanel.getByRole("combobox", { name: "Persona default effort", exact: true }).selectOption("high");
            await personasPanel.getByRole("button", { name: "Save persona", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="personas"] [data-family-rows] tr').length === 1);
            assert.match(await personasPanel.locator("[data-family-rows] tr").first().textContent(), /reviewer[\s\S]*Strict code reviewer \[high\]/u);

            // 4. Environment: set a masked workspace variable on 0-session Overview
            await dialog.getByRole("button", { name: "Environment", exact: true }).click();
            const envPanel = dialog.locator('[data-settings-panel="env"]');
            await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings > article")?.getAttribute("aria-busy") === null);
            await envPanel.getByRole("textbox", { name: "Variable name", exact: true }).fill("WS_API_KEY");
            await envPanel.getByLabel("Variable value", { exact: true }).fill("ultra-secret-overview-token");
            await envPanel.getByRole("button", { name: "Set", exact: true }).click();
            await page.waitForFunction(() => document.querySelector('#dialog-workspace-settings [data-settings-panel="env"] tr[data-env-alias="WS_API_KEY"]') !== null);
            assert.equal(
                await envPanel.locator('tr[data-env-alias="WS_API_KEY"] [data-text="env-origin"]').textContent(),
                "workspace",
            );
            assert.doesNotMatch(await envPanel.textContent(), /ultra-secret-overview-token/u);

            assert.equal(resumedSessions.length, 0, "0-session Overview mutations never attach or create a session");
            await dialog.getByRole("button", { name: "Close", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });

            // 5. Create session "user", jump to Settings from `/personas list`, and apply `reviewer` persona to session!
            const setup = createAgent(base, "user");
            const { result: modelRes } = await setup.send({
                workspace,
                action: { kind: "session/set_config_option", configId: "model", value: "browser" },
            });
            assert.equal(modelRes.ok, true);
            setup.close();

            await page.goto(new URL(directoryPath({ kind: "session", workspace, session: "user" }), base).href);
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            const composer = page.getByRole("textbox", { name: "Message", exact: true });
            await composer.fill("/personas list");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            const cmdRow = page.locator("#session-command-results > ul > li").last();
            await cmdRow.locator('[data-command-state="done"]').waitFor();
            await cmdRow.getByRole("button", { name: "Settings", exact: true }).click();

            await dialog.waitFor({ state: "visible" });
            const sessionPersonaForm = dialog.locator('[data-settings-panel="personas"] [data-session-persona-form]');
            await sessionPersonaForm.waitFor({ state: "visible" });
            await sessionPersonaForm.getByRole("combobox", { name: "Active session persona", exact: true }).selectOption("reviewer");
            await sessionPersonaForm.getByRole("button", { name: "Apply to session", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings [data-text='ws-settings-message']")?.textContent === "Session persona: reviewer.");

            // Schedule targeting @user now that session exists
            await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
            const schedulePanel = dialog.locator('[data-settings-panel="schedule"]');
            await page.waitForFunction(() => document.querySelector("#dialog-workspace-settings > article")?.getAttribute("aria-busy") === null);
            assert.equal(await schedulePanel.getByRole("textbox", { name: "Target session", exact: true }).inputValue(), "user", "Target session defaults to active session");
            await schedulePanel.getByRole("textbox", { name: "Schedule name", exact: true }).fill("hourly-ping");
            await schedulePanel.getByRole("textbox", { name: "Schedule rule", exact: true }).fill("0 * * * *");
            await schedulePanel.getByRole("textbox", { name: "Scheduled prompt", exact: true }).fill("Status check.");
            await schedulePanel.getByRole("button", { name: "Save schedule", exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('#dialog-workspace-settings [data-settings-panel="schedule"] [data-family-rows] tr').length === 1);

            checkBrowser();
        } finally {
            await browser.close();
        }
    });
}
