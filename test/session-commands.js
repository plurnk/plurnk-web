import assert from "node:assert/strict";
import { inputPage, onAcpSent } from "./session-input.js";
import { httpFailure } from "./browser-diagnostics.js";

function composer(page) {
    page.setDefaultTimeout(5000);
    const field = page.getByRole("textbox", { name: "Message", exact: true });
    const feedback = page.locator('[aria-label="Message feedback"]');
    const status = feedback.locator('[data-text="message-status"]');
    const error = feedback.locator('[data-text="command-error"]');
    const send = async (text) => {
        await field.fill(text);
        await page.getByRole("button", { name: "Send", exact: true }).click();
    };
    return {
        field,
        feedback,
        status,
        error,
        send,
        submit: async (text, expected = "done") => {
            await page.waitForFunction(() => !document.querySelector('[aria-label="Session controls"]')?.hasAttribute("data-command-pending"));
            await send(text);
            await page.waitForFunction(() => !document.querySelector('[aria-label="Session controls"]')?.hasAttribute("data-command-pending"));
            if (expected === "error") {
                await feedback.locator('[role="alert"]').waitFor({ state: "visible" });
                return error;
            }
            await status.waitFor({ state: "visible" });
            return status;
        },
    };
}

const reasoning = {
    PLURNK_PROVIDERS_PROVIDER_BROWSER_FIXTURE_REASONING_EFFORTS: "low,high",
};

// {§web-session-commands} {§web-workspace-settings} Real shipped composer, multi-token autocomplete, and unified Settings tabs.
export default async function verifySessionCommands({ t, withDaemon }) {
    await t.test("{§web-workspace-settings} {§web-session-commands} status model links open in-place combobox dialog without inference and composer autocomplete completes multi-token /model commands", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            page.setDefaultTimeout(5000);
            const draft = page.getByRole("textbox", { name: "Message", exact: true });
            const statusLine = page.locator("#session-status > [data-status-line]");
            assert.equal(await statusLine.isVisible(), true, "connected session exposes steady status bar without jump");
            const modelLink = page.getByRole("link", { name: "Model", exact: true });
            const effortLink = page.getByRole("link", { name: "Effort", exact: true });
            assert.match((await modelLink.getAttribute("href")) ?? "", /^\/settings\/\?workspace=.*#session$/u);
            assert.equal(await effortLink.getAttribute("href"), await modelLink.getAttribute("href"));

            // Clicking #session-model opens the in-place quick-picker dialog without navigating away
            const sessionUrlBefore = page.url();
            await modelLink.click();
            const quickDialog = page.locator("#dialog-session-model");
            await quickDialog.waitFor({ state: "visible" });
            assert.equal(page.url(), sessionUrlBefore, "quick model dialog opens in place without leaving the conversation");
            const quickCombo = quickDialog.getByRole("combobox", { name: "Session model", exact: true });
            const quickList = quickDialog.locator("[data-combobox-list]");
            await quickList.locator('[role="option"][data-combobox-option="browser"]').waitFor({ state: "visible" });
            await quickList.locator('[role="option"][data-combobox-option="browser"]').click();
            assert.equal(await quickCombo.inputValue(), "browser");
            await quickDialog.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("low");
            await quickDialog.getByRole("button", { name: "Apply", exact: true }).click();
            await quickDialog.waitFor({ state: "hidden" });
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=effort]")?.textContent === "low");
            assert.equal(model.requests.length, 0);

            // Opening the quick dialog again and clicking "Browse full catalog…" reaches /settings/#models
            await modelLink.click();
            await quickDialog.waitFor({ state: "visible" });
            await quickDialog.getByRole("link", { name: "Browse full catalog…", exact: true }).click();
            await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#models");
            await page.waitForFunction(() => document.querySelectorAll('#workspace-settings [data-settings-panel="models"] [data-models-alias-rows] tr').length >= 1);

            await page.locator("[data-settings-back]").click();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=effort]")?.textContent === "low");

            // Progressive multi-token autocomplete menu in the composer: `/model ` -> click `browser` -> click `high` -> Enter!
            await draft.focus();
            await draft.fill("/model ");
            await page.waitForFunction(() => document.querySelector("[data-compose-suggestions]")?.getAttribute("data-suggestions-mode") === "menu");
            const browserPill = page.locator('[data-compose-suggestions] button[data-accept-suggestion][data-suggestion-value="browser"]');
            await browserPill.waitFor({ state: "visible" });
            await browserPill.click();
            assert.equal(await draft.inputValue(), "/model browser ");
            const highPill = page.locator('[data-compose-suggestions] button[data-accept-suggestion][data-suggestion-value="high"]');
            await highPill.waitFor({ state: "visible" });
            await highPill.click();
            assert.equal(await draft.inputValue(), "/model browser high");
            await draft.press("Enter");
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=effort]")?.textContent === "high");
            assert.equal(model.requests.length, 0);
            checkBrowser();
        }, { env: { ...reasoning, PLURNK_SERVICE_PROPOSALS: "review" } }));

    await t.test("{§web-workspace-settings} {§web-session-commands} live effort selection applies during active work and refused model selection preserves the draft and active work", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { send, submit, field } = composer(page);
            await send("Lifecycle fixture: held-settings.");
            await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
            await page.locator("body > header a").first().focus();
            assert.equal(await page.locator("#session-status > [data-status-line]").isVisible(), true, "live work remains observable without composer focus");
            await submit("/effort low");
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=effort]")?.textContent === "low");
            assert.equal(await page.locator("#session-status").getAttribute("data-lifecycle"), "running");

            const err = await submit("/model nonexistent-web-route", "error");
            assert.match(await err.textContent(), /nonexistent-web-route/u);
            assert.equal(await field.inputValue(), "/model nonexistent-web-route", "refusal preserves unsent input");
            assert.equal(await page.locator("#session-status").getAttribute("data-lifecycle"), "running");
            assert.equal(model.requests.length, 1);

            await field.fill("An untouched next message.");
            await page.getByRole("button", { name: "Stop", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.lifecycle === "cancelled");
            assert.equal(await field.inputValue(), "An untouched next message.");
            checkBrowser();
        }, { env: reasoning }));

    await t.test("{§web-session-approval} {§web-session-commands} Send posture reflects Shift+Tab, /yolo, and durable session Approval policy across reloads and settles pending proposals", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { field, submit, send } = composer(page);
            const statusFooter = page.locator("#session-status");
            const sendBtn = page.getByRole("button", { name: "Send", exact: true });
            await field.focus();
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "review");
            assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🐹/u);
            await field.fill("Keep my unsent draft.");
            await field.press("Shift+Tab");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "accept");
            assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🔥/u);
            assert.equal(await field.inputValue(), "Keep my unsent draft.");
            assert.equal(await page.locator("[data-messages] > li").count(), 0);
            assert.equal(model.requests.length, 0);
            await field.fill("");
            await submit("/yolo");
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "review", "/yolo toggles durable session approval mode");
            assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🐹/u);
            await submit("/yolo");
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "accept");
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            await field.focus();
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "accept", "reload preserves durable session policy");
            assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🔥/u);
            await submit("/yolo");
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "review");
            await send("Lifecycle fixture: approval-toggle.");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
            await submit("/yolo");
            await page.getByText("Completed approval-toggle.", { exact: true }).waitFor();
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "accept");
            assert.equal(model.requests.length, 2);

            await submit("/yolo");
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "review");
            await field.focus();
            await field.fill("Idle Shift+Tab draft.");
            await field.press("Shift+Tab");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "accept");
            assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", "composer retains focus");
            assert.equal(await field.inputValue(), "Idle Shift+Tab draft.");
            await field.press("Escape");
            assert.notEqual(await page.evaluate(() => document.activeElement?.id), "session-message", "Escape leaves composer");
            assert.equal(await page.locator("#session-status > [data-status-line]").isVisible(), true);
            await field.focus();
            await field.press("Shift+Tab");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "review");
            await send("Lifecycle fixture: approval-shortcut.");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
            await field.fill("Keep this draft during Shift+Tab.");
            await field.press("Shift+Tab");
            await page.getByText("Completed approval-shortcut.", { exact: true }).waitFor();
            assert.equal(await statusFooter.getAttribute("data-approval-mode"), "accept");
            assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🔥/u);
            assert.equal(await field.inputValue(), "Keep this draft during Shift+Tab.");
            assert.equal(model.requests.length, 4);
            checkBrowser();
        }, { env: { PLURNK_SERVICE_PROPOSALS: "review" } }));

    await t.test("{§web-session-commands} {§web-workspace-settings} slash commands remain outside model messages, route inspections to Settings tabs, and preserve daemon truth", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const sent = [];
            onAcpSent(page, (body) => {
                if (
                    body !== null
                    && body.method !== "initialize"
                    && body.params?._meta?.plurnk?.control !== false
                ) {
                    sent.push(body);
                }
            });
            const { field, send, submit } = composer(page);

            // `/help` opens unified Settings #help tab with all 40 supported commands
            await send("/help");
            await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#help");
            const helpPanel = page.locator('#workspace-settings [data-settings-panel="help"]');
            await helpPanel.waitFor({ state: "visible" });
            const names = await helpPanel.locator("[data-command-name]").evaluateAll((items) => items.map((item) => item.dataset.commandName));
            assert.deepEqual(names, [
                "help", "models", "model", "effort", "persona", "child", "mode",
                "workspaces", "workspace", "rename", "sessions", "session", "fork", "parent",
                "enter", "older", "newer", "loops", "loop", "rollback", "share", "update",
                "review", "accept", "approve", "reject", "cancel", "edit", "answer",
                "mcp", "skills", "schedule", "personas", "members", "env", "learn", "yolo", "stop", "logout",
            ]);
            await page.locator("[data-settings-back]").click();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            sent.length = 0;

            for (const text of ["/quit", "/import anything", "/model a b c", "/effort low high", "/yolo yes"]) {
                await submit(text, "error");
                assert.equal(await field.inputValue(), text);
            }
            assert.equal(sent.length, 0, "bad command syntax does not become a daemon action or prompt");

            await submit("/effort low");
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=effort]")?.textContent === "low");
            await submit("/effort invented", "error");
            const absent = await submit("/model nonexistent-web-route", "error");
            assert.match(await absent.textContent(), /nonexistent-web-route/u);
            const selected = await submit("/model browser high");
            assert.match(await selected.textContent(), /browser-fixture\/browser-fixture/u);
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=effort]")?.textContent === "high");

            await submit("/env set MY_VAR top-secret-hello");
            await send("/env --scope session list");
            await page.waitForURL((url) => new URL(url).pathname === "/settings/" && new URL(url).hash === "#env");
            const envPanel = page.locator('#workspace-settings [data-settings-panel="env"]');
            await envPanel.waitFor({ state: "visible" });
            await page.waitForFunction(() => document.querySelector('#workspace-settings [data-settings-panel="env"] tr[data-env-alias="MY_VAR"]') !== null);
            const myVarRow = envPanel.locator('tbody tr[data-env-alias="MY_VAR"]');
            assert.equal(await myVarRow.locator('[data-text="env-origin"]').textContent(), "session");
            assert.equal(await myVarRow.locator('[data-text="env-status"]').textContent(), "active");
            assert.doesNotMatch(await envPanel.textContent(), /top-secret-hello/u);
            await myVarRow.getByRole("button", { name: "Disable", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#workspace-settings tr[data-env-alias='MY_VAR'] [data-text='env-status']")?.textContent === "disabled");
            await myVarRow.getByRole("button", { name: "Enable", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#workspace-settings tr[data-env-alias='MY_VAR'] [data-text='env-status']")?.textContent === "active");
            await page.locator("[data-settings-back]").click();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");

            await submit("/env unset MY_VAR");
            await submit("/stop");
            assert.equal(model.requests.length, 0);
            assert.equal(await page.locator("[data-messages] > li").count(), 0);
            for (const input of sent) {
                assert.ok(["_plurnk/action", "session/resume", "session/set_config_option", "session/options", "session/cancel", "providers/list"].includes(input.method));
            }
            await field.fill("Lifecycle fixture: command-followup.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed command-followup.", { exact: true }).waitFor();
            assert.equal(model.requests.length, 1);
            assert.doesNotMatch(JSON.stringify(sent.at(-1).params.prompt), /nonexistent-web-route|\/mcp|\/models/u);
            await field.fill("/learn Lifecycle fixture: learn-focus.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed learn-focus.", { exact: true }).waitFor();
            await page.waitForFunction(() => /** @type {HTMLTextAreaElement} */ (document.querySelector("#session-message"))?.value === "");
            assert.equal(model.requests.length, 2);
            assert.match(sent.at(-1).params.prompt[0].text, /SKILL\.md[\s\S]*mcp:\/\/\/plurnk\/skills\.json[\s\S]*Focus: Lifecycle fixture: learn-focus\./u);
            checkBrowser();
        }, { authenticated: true, env: reasoning }));

    await t.test("{§web-session-commands} a modelless session selects its route without inference", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { submit } = composer(page);
            assert.equal(await page.locator("#session-status [data-text=model]").textContent(), "No model");
            await submit("/model browser low");
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=model]")?.textContent === "browser"
                && document.querySelector("#session-status [data-text=effort]")?.textContent === "low");
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#session-status [data-text=model]")?.textContent === "browser");
            assert.equal(await page.locator("#session-status [data-text=effort]").textContent(), "low");
            assert.match(await page.locator('#session-status [data-status-field="model"]').getAttribute("aria-label"), /browser-fixture\/browser-fixture; effort: low \(explicit\)/u);
            assert.equal(model.requests.length, 0);
            checkBrowser();
        }, { selector: null, env: { ...reasoning, PLURNK_MODEL: "" } }));

    // https://repo.possumtech.com/plurnk/plurnk-service/issues/1194 owns authoritative idle updates.
    await t.test("{§web-session-commands} live model controls agree with fresh observation in every open view", () =>
        inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
            const { submit } = composer(page);
            const other = await context.newPage();
            await other.goto(path);
            await other.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            assert.equal(await other.locator("#session-status [data-text=effort]").textContent(), "adaptive");
            await submit("/effort low");
            const fresh = await context.newPage();
            await fresh.goto(path);
            await fresh.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            assert.equal(await fresh.locator("#session-status [data-text=effort]").textContent(), "low",
                "a fresh authoritative snapshot confirms the mutation");
            await Promise.all([page, other].map((view) => view.waitForFunction(
                () => document.querySelector("#session-status [data-text=effort]")?.textContent === "low", undefined, { timeout: 5000 })));
            await submit("/model browser high");
            await Promise.all([page, other, fresh].map((view) => view.waitForFunction(
                () => document.querySelector("#session-status [data-text=effort]")?.textContent === "high", undefined, { timeout: 5000 })));
            assert.equal(model.requests.length, 0);
            checkBrowser();
        }, { env: reasoning }));

    await t.test("{§web-session-commands} pending review settles via durable session /yolo and active work retains daemon restrictions", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { submit, send, field } = composer(page);
            await send("Lifecycle fixture: approval-command.");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
            const form = page.getByRole("form", { name: "Review requests", exact: true });
            assert.equal(await form.isVisible(), true);
            await send("/review");
            const outputDialog = page.locator("#dialog-command-output");
            await outputDialog.waitFor({ state: "visible" });
            await outputDialog.locator("button[data-dialog-close]").click();
            await outputDialog.waitFor({ state: "hidden" });
            assert.equal(await form.isVisible(), true, "an informational command never settles review");
            await submit("/yolo");
            await page.getByText("Completed approval-command.", { exact: true }).waitFor();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "accept");
            assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"));
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            assert.equal(await page.locator("#session-status").getAttribute("data-approval-mode"), "accept", "reload preserves durable session approval policy");
            await submit("/yolo");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "review");
            await send("Lifecycle fixture: held-command.");
            await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
            const applied = await submit("/effort low");
            assert.match(await applied.textContent(), /low/u);
            const failed = await submit("/effort medium", "error");
            assert.match(await failed.textContent(), /does not support effort 'medium'/u);

            const delivery = Promise.withResolvers();
            const hold = async (route) => {
                const body = route.request().postDataJSON();
                if (body?.method === "session/set_config_option") await delivery.promise;
                await route.continue();
            };
            await page.route("**/acp", hold);
            try {
                const receiving = page.waitForRequest((request) => new URL(request.url()).pathname === "/acp"
                    && request.postDataJSON()?.method === "session/set_config_option");
                await send("/effort high");
                await receiving;
                await field.fill("/yolo");
                assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
                assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isEnabled(), true,
                    "explicit cancellation remains reachable while a command is pending");
                delivery.resolve();
                await page.waitForFunction(() => document.querySelector("#session-status [data-text=effort]")?.textContent === "high"
                    && !document.querySelector('[aria-label="Session controls"]')?.hasAttribute("data-command-pending"));
                assert.equal(await field.inputValue(), "/yolo", "a delayed result cannot clear newer typing");
            } finally {
                delivery.resolve();
                await page.unroute("**/acp", hold);
            }
            const stopped = await submit("/stop");
            assert.match(await stopped.textContent(), /Stop requested/u);
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.lifecycle === "cancelled");
            assert.equal(model.requests.length, 3, "commands did not start another inference");
            checkBrowser();
        }, { env: { ...reasoning, PLURNK_SERVICE_PROPOSALS: "review" } }));

    await t.test("{§web-session-commands} {§web-workspace-settings} a refusal before the stream opens or as an ACP stream error shows the daemon's Problem and recovery", () =>
        inputPage(withDaemon, async ({ page, checkBrowser }) => {
            const { submit } = composer(page);
            const problem = { type: "https://problems.plurnk.xyz/fixture/action-refused", title: "Conflict", status: 409,
                detail: "The fixture refused the action.", recovery: "Follow the fixture's recovery." };
            const refusals = {
                "before the stream opens": (route) => route.fulfill({ status: 409, contentType: "application/problem+json", body: JSON.stringify(problem) }),
                "as an ACP stream error": (route) => {
                    const { id } = route.request().postDataJSON();
                    return route.fulfill({
                        headers: { "acp-connection-id": "refused" },
                        contentType: "application/json",
                        body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: problem.detail, data: { plurnk: { problem } } } }),
                    });
                },
            };
            for (const [refusal, reply] of Object.entries(refusals)) {
                for (const command of ["/effort low", "/stop"]) {
                    await page.route("**/acp", reply, { times: 1 });
                    const err = await submit(command, "error");
                    assert.equal(await err.textContent(), `${problem.detail} ${problem.recovery}`, `${command} ${refusal}`);
                }
                checkBrowser(refusal === "before the stream opens" ? Array.from({ length: 2 }, () => httpFailure("/acp", 409)) : []);
            }
        }));

    await t.test("{§web-session-input} {§web-session-commands} Escape escalation, / focus, ? help navigation, and proposal choice keys preserve drafts and typing", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { field, send } = composer(page);
            await send("Lifecycle fixture: held-escape.");
            await page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached" });
            await send("/loops");
            const outputDialog = page.locator("#dialog-command-output");
            await outputDialog.waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
            await outputDialog.waitFor({ state: "hidden" });
            assert.equal(await page.locator("#session-status").getAttribute("data-lifecycle"), "running", "Escape closes open command output modal before cancelling work");

            await field.fill("Draft preserved across Escape escalation.");
            await field.press("Escape");
            assert.notEqual(await page.evaluate(() => document.activeElement?.id), "session-message", "first Escape leaves composer");
            assert.equal(await page.locator("#session-status").getAttribute("data-lifecycle"), "running", "leaving composer does not cancel work");
            await page.keyboard.press("/");
            assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", "/ focuses composer");
            assert.equal(await field.inputValue(), "Draft preserved across Escape escalation.");
            await field.press("Escape");
            await page.keyboard.press("Escape");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.lifecycle === "cancelled");
            assert.equal(await field.inputValue(), "Draft preserved across Escape escalation.");

            await field.fill("Lifecycle fixture: approval-keys.");
            await page.waitForFunction(() => !document.querySelector('button[form="session-compose"]')?.hasAttribute("disabled"));
            await field.press("Enter");
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
            await field.fill("typing y and n inside composer stays literal");
            await field.pressSequentially("!");
            const form = page.getByRole("form", { name: "Review requests", exact: true });
            assert.equal(await form.locator('input[type="radio"]:checked').count(), 0, "typing inside composer never selects a proposal radio");
            await field.press("Escape");
            await page.keyboard.press("n");
            assert.equal(await form.locator('input[type="radio"][value="reject"]').isChecked(), true, "n selects Reject");
            await page.keyboard.press("y");
            assert.equal(await form.locator('input[type="radio"][value="accept"]').isChecked(), true, "y switches selection to Accept");
            await page.keyboard.press("Enter");
            await page.getByText("Completed approval-keys.", { exact: true }).waitFor();
            assert.equal(await field.inputValue(), "typing y and n inside composer stays literal!");
            assert.equal(model.requests.length, 3);
            checkBrowser();
        }, { env: { ...reasoning, PLURNK_SERVICE_PROPOSALS: "review" } }));
}
