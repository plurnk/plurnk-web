import assert from "node:assert/strict";
import { inputPage } from "./worker-input.js";

function composer(page) {
    page.setDefaultTimeout(5000);
    const field = page.getByRole("textbox", { name: "Message", exact: true });
    const rows = page.locator("#worker-command-results > ul > li");
    const send = async (text) => {
        await field.fill(text);
        await page.getByRole("button", { name: "Send", exact: true }).click();
    };
    return { field, rows, send, submit: async (text, expected = "done") => {
        const index = await rows.count();
        await send(text);
        const row = rows.nth(index);
        await row.locator(`[data-command-state="${expected}"]`).waitFor();
        return row;
    } };
}

const reasoning = {
    PLURNK_PROVIDERS_PROVIDER_BROWSER_FIXTURE_REASONING_EFFORT_PATH: "/reasoning_effort",
    PLURNK_PROVIDERS_PROVIDER_BROWSER_FIXTURE_REASONING_EFFORTS: "low,high",
};

// {§web-worker-commands} Real shipped composer and public daemon actions, never model-authored commands.
export default async function verifyWorkerCommands({ t, withDaemon }) {
    await t.test("{§web-worker-settings} native selectors read without inference, apply explicitly and preserve the draft", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            page.setDefaultTimeout(5000);
            const draft = page.getByRole("textbox", { name: "Message", exact: true });
            const statusLine = page.locator("#worker-status > [data-status-line]");
            assert.equal(await statusLine.isVisible(), false, "an idle attachment does not occupy status space");
            await draft.fill("Keep this unsent draft.");
            assert.equal(await statusLine.isVisible(), true);
            await page.getByRole("button", { name: "Model", exact: true }).click();
            const models = page.locator("#worker-model-settings");
            const selection = models.getByRole("combobox", { name: "Search Models", exact: true });
            assert.equal(await statusLine.isVisible(), true, "inline settings retain the status controls");
            await models.locator('datalist option[value="browser"]').waitFor({ state: "attached" });
            assert.equal(model.requests.length, 0);
            await selection.fill("browser");
            await models.getByRole("button", { name: "Select Model", exact: true }).click();
            await models.waitFor({ state: "hidden" });
            assert.equal(await draft.inputValue(), "Keep this unsent draft.");
            await page.getByRole("button", { name: "Effort", exact: true }).click();
            const effort = page.locator("#worker-effort-settings");
            assert.equal(await models.isVisible(), false);
            const choices = effort.getByRole("combobox", { name: "Reasoning Effort", exact: true });
            await choices.locator('option[value="low"]').waitFor({ state: "attached" });
            await choices.selectOption("low");
            await effort.getByRole("button", { name: "Select Effort", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#worker-status [data-text=effort]")?.textContent === "low");
            await effort.waitFor({ state: "hidden" });
            assert.equal(await effort.isVisible(), false);
            assert.equal(await page.getByRole("button", { name: "Effort", exact: true }).evaluate((button) => document.activeElement === button), true);
            assert.equal(await statusLine.isVisible(), true);
            await page.locator("body > header > a").focus();
            assert.equal(await statusLine.isVisible(), false, "leaving the controls releases idle status space");
            assert.equal(await draft.inputValue(), "Keep this unsent draft.");
            assert.equal(await page.locator("#worker-command-results > ul > li").count(), 0);
            assert.equal(model.requests.length, 0);
            checkBrowser();
        }, { env: reasoning }));

    await t.test("{§web-worker-settings} refused effort selection preserves the draft and active work", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { send, field } = composer(page);
            await send("Lifecycle fixture: held-settings.");
            await page.getByText("Considering held-settings.", { exact: true }).waitFor({ state: "attached" });
            await page.locator("body > header > a").focus();
            assert.equal(await page.locator("#worker-status > [data-status-line]").isVisible(), true, "live work remains observable without composer focus");
            await field.fill("An untouched next message.");
            await page.getByRole("button", { name: "Effort", exact: true }).click();
            const article = page.locator("#worker-effort-settings");
            const select = article.getByRole("combobox", { name: "Reasoning Effort", exact: true });
            await select.locator('option[value="low"]').waitFor({ state: "attached" });
            await select.selectOption("low");
            await article.getByRole("button", { name: "Select Effort", exact: true }).click();
            await article.getByRole("status").filter({ hasText: "unfinished tasks" }).waitFor();
            assert.match(await article.locator("[data-text=settings-recovery]").textContent(), /Conclude or cancel/u);
            assert.equal(await select.inputValue(), "low");
            assert.equal(await field.inputValue(), "An untouched next message.");
            assert.equal(await page.locator("#worker-status").getAttribute("data-lifecycle"), "running");
            assert.equal(model.requests.length, 1);
            await page.getByRole("button", { name: "Stop", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.lifecycle === "cancelled");
            checkBrowser();
        }, { env: reasoning }));
    await t.test("{§web-worker-approval} native status toggle shares /yolo without submitting a draft or inventing command history", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { field, rows, submit, send } = composer(page);
            const approval = page.getByRole("button", { name: "Automatic approval", exact: true });
            const sent = [];
            page.on("request", (request) => { if (new URL(request.url()).pathname === "/agui") sent.push(request.postDataJSON()); });
            await field.focus();
            assert.equal(await approval.getAttribute("aria-pressed"), "false");
            assert.equal(await approval.getAttribute("title"), "Manual Approval (/yolo)");
            await field.fill("Keep my unsent draft.");
            await approval.click();
            assert.equal(await approval.getAttribute("aria-pressed"), "true");
            assert.equal(await approval.getAttribute("title"), "Auto Approval (/yolo)");
            await approval.press("Space");
            assert.equal(await approval.getAttribute("aria-pressed"), "false");
            await approval.press("Enter");
            assert.equal(await approval.getAttribute("aria-pressed"), "true");
            assert.equal(await field.inputValue(), "Keep my unsent draft.");
            assert.equal(await rows.count(), 0, "a native control needs no synthetic slash-command entry");
            assert.equal(await page.locator("[data-messages] > li").count(), 0);
            assert.equal(sent.length, 0);
            assert.equal(model.requests.length, 0);
            await submit("/yolo");
            assert.equal(await approval.getAttribute("aria-pressed"), "false", "the command sees the same native toggle state");
            assert.equal(await approval.getAttribute("title"), "Manual Approval (/yolo)");
            await approval.click();
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
            await field.focus();
            assert.equal(await approval.getAttribute("aria-pressed"), "false", "reload restores configured policy");
            await send("Lifecycle fixture: approval-toggle.");
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "interrupted");
            await field.fill("Keep this draft during approval.");
            await approval.click();
            await page.getByText("Completed approval-toggle.", { exact: true }).waitFor();
            assert.equal(await field.inputValue(), "Keep this draft during approval.");
            assert.equal(await rows.count(), 0);
            assert.equal(sent.length, 2, "one authored prompt and its standard approval resume");
            assert.deepEqual(sent[1].resume.map(({ payload }) => payload), [{ decision: "accept", outcome: "client_yolo" }]);
            assert.equal(model.requests.length, 2);
            checkBrowser();
        }, { env: { PLURNK_WEB_YOLO: "0" } }));

    await t.test("{§web-worker-commands} slash commands remain outside model messages and preserve daemon truth", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser, setup, workspace }) => {
            const sent = [];
            page.on("request", (request) => {
                if (new URL(request.url()).pathname === "/agui") sent.push(request.postDataJSON());
            });
            const { field, submit } = composer(page);
            const help = await submit("/help");
            const names = await help.locator("[data-command-name]").evaluateAll((items) => items.map((item) => item.dataset.commandName));
            assert.deepEqual(names, ["help", "models", "model", "effort", "capabilities", "yolo", "stop"]);
            assert.equal(sent.length, 0);
            for (const text of ["/quit", "/import anything", "/model a b c", "/effort low high", "/yolo yes", "/capabilities {"]) {
                await submit(text, "error");
                assert.equal(await field.inputValue(), text);
            }
            assert.equal(sent.length, 0, "bad command syntax does not become a daemon action or prompt");
            const catalog = await submit("/models");
            assert.match(await catalog.textContent(), /browser-fixture/u);
            assert.ok(await catalog.locator("table").count());
            const current = await submit("/model");
            assert.match(await current.textContent(), /browser-fixture\/browser-fixture/u);
            const effort = await submit("/effort");
            assert.match(await effort.textContent(), /Supported/u);
            await submit("/effort low");
            assert.match(await (await submit("/effort")).textContent(), /low \(explicit\)/u);
            await submit("/effort invented", "error");
            const absent = await submit("/model nonexistent-web-route", "error");
            assert.match(await absent.locator("[data-text=command-message]").textContent(), /nonexistent-web-route/u);
            assert.equal(await absent.locator("details").count(), 0);
            const selected = await submit("/model browser high");
            assert.match(await selected.textContent(), /browser-fixture\/browser-fixture/u);
            assert.match(await (await submit("/effort")).textContent(), /high \(explicit\)/u);
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#worker-status [data-text=effort]")?.textContent === "high");
            assert.equal(await page.locator("#worker-command-results > ul > li").count(), 0, "command history is page-local");
            const capabilities = await submit("/capabilities");
            assert.deepEqual(await capabilities.locator("dt").allTextContents(), ["Service", "Workspace", "Effective"]);
            const policy = { deny: [{ runtime: "sh" }] };
            await submit(`/capabilities ${JSON.stringify(policy)}`);
            const { result } = await setup.runAgent({ forwardedProps: { plurnk: { workspace, action: { kind: "workspace.capabilities.get" } } } });
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.deepEqual(result.result.workspace, policy);
            await submit("/capabilities {}");
            await submit("/stop");
            assert.equal(model.requests.length, 0);
            assert.equal(await page.locator("[data-messages] > li").count(), 0);
            for (const input of sent) {
                assert.deepEqual(input.messages, []);
                assert.deepEqual(input.tools, []);
                assert.ok(input.forwardedProps.plurnk.action.kind);
                assert.equal(input.forwardedProps.plurnk.interactive, undefined);
            }
            await field.fill("Lifecycle fixture: command-followup.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed command-followup.", { exact: true }).waitFor();
            assert.equal(model.requests.length, 1);
            assert.doesNotMatch(JSON.stringify(sent.at(-1).messages), /nonexistent-web-route|\/capabilities|\/models/u);
            checkBrowser();
        }, { authenticated: true, env: reasoning }));

    await t.test("{§web-worker-commands} a modelless worker selects its route without inference", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { submit } = composer(page);
            const before = await submit("/model");
            assert.match(await before.textContent(), /Not selected/u);
            await submit("/model browser low");
            const after = await submit("/effort");
            assert.match(await after.textContent(), /low \(explicit\)/u);
            await page.waitForFunction(() => document.querySelector("#worker-status [data-text=model]")?.textContent === "browser"
                && document.querySelector("#worker-status [data-text=effort]")?.textContent === "low");
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#worker-status [data-text=model]")?.textContent === "browser");
            assert.equal(await page.locator("#worker-status [data-text=effort]").textContent(), "low");
            assert.match(await page.locator('#worker-status [data-status-field="model"]').getAttribute("aria-label"), /browser-fixture\/browser-fixture; effort: low \(explicit\)/u);
            assert.equal(model.requests.length, 0);
            checkBrowser();
        }, { selector: null, env: { ...reasoning, PLURNK_MODEL: "" } }));

    // https://repo.possumtech.com/plurnk/plurnk-service/issues/1194 owns authoritative idle updates.
    await t.test("{§web-worker-commands} live model controls agree with fresh observation in every open view", () =>
        inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
            const { submit } = composer(page);
            const other = await context.newPage();
            await other.goto(path);
            await other.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
            assert.equal(await other.locator("#worker-status [data-text=effort]").textContent(), "adaptive");
            await submit("/effort low");
            const fresh = await context.newPage();
            await fresh.goto(path);
            await fresh.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
            assert.equal(await fresh.locator("#worker-status [data-text=effort]").textContent(), "low",
                "a fresh authoritative snapshot confirms the mutation");
            await Promise.all([page, other].map((view) => view.waitForFunction(
                () => document.querySelector("#worker-status [data-text=effort]")?.textContent === "low", undefined, { timeout: 5000 })));
            await submit("/model browser high");
            await Promise.all([page, other, fresh].map((view) => view.waitForFunction(
                () => document.querySelector("#worker-status [data-text=effort]")?.textContent === "high", undefined, { timeout: 5000 })));
            assert.equal(model.requests.length, 0);
            checkBrowser();
        }, { env: reasoning }));

    await t.test("{§web-worker-commands} pending review accepts page-local YOLO and active work retains daemon restrictions", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const { submit, send, field, rows } = composer(page);
            await send("Lifecycle fixture: approval-command.");
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "interrupted");
            const form = page.getByRole("form", { name: "Review requests", exact: true });
            assert.equal(await form.isVisible(), true);
            await submit("/help stop");
            assert.equal(await form.isVisible(), true, "an informational command never settles review");
            await submit("/yolo");
            await page.getByText("Completed approval-command.", { exact: true }).waitFor();
            await field.focus();
            assert.equal(await page.getByRole("button", { name: "Automatic approval", exact: true }).getAttribute("aria-pressed"), "true");
            assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"));
            await page.reload();
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
            await field.focus();
            assert.equal(await page.getByRole("button", { name: "Automatic approval", exact: true }).getAttribute("aria-pressed"), "false", "reload restores configured client policy");
            await send("Lifecycle fixture: held-command.");
            await page.getByText("Considering held-command.", { exact: true }).waitFor({ state: "attached" });
            const failed = await submit("/effort low", "error");
            assert.equal(await failed.locator("article").getAttribute("data-command-status"), "409");
            assert.match(await failed.locator("[data-text=command-message]").textContent(), /unfinished tasks/u);
            await submit("/help");
            const delivery = Promise.withResolvers();
            const hold = async (route) => {
                if (route.request().postDataJSON().forwardedProps?.plurnk?.action?.kind === "worker.model.get") await delivery.promise;
                await route.continue();
            };
            await page.route("**/agui", hold);
            try {
                const receiving = page.waitForRequest((request) => new URL(request.url()).pathname === "/agui"
                    && request.postDataJSON().forwardedProps?.plurnk?.action?.kind === "worker.model.get");
                await send("/model");
                await receiving;
                await field.fill("/help effort");
                assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
                assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isEnabled(), true,
                    "explicit cancellation remains reachable while an inspection is pending");
                delivery.resolve();
                await rows.last().locator("[data-command-state=done]").waitFor();
                assert.equal(await field.inputValue(), "/help effort", "a delayed result cannot clear newer typing");
            } finally {
                delivery.resolve();
                await page.unroute("**/agui", hold);
            }
            const stopped = await submit("/stop");
            assert.match(await stopped.textContent(), /Stop requested/u);
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.lifecycle === "cancelled");
            assert.equal(model.requests.length, 3, "commands did not start another inference");
            checkBrowser();
        }, { env: { ...reasoning, PLURNK_WEB_YOLO: "0" } }));
}
