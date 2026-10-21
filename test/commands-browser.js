import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

// {§web-worker-commands} Controlled protocol failures through the real SDK and native templates.
export default async function verifyCommands(t) {
    const fixture = await conversationFixture(new URL("./commands-entry.js", import.meta.url));
    try {
        for (const engine of [chromium, firefox, webkit]) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    let credentials = 0;
                    let credentialStatus = 200;
                    let result = { kind: "worker.model.get", ok: true, result: { model: null, spawnModel: null } };
                    let held = undefined;
                    let delayed = undefined;
                    let catalog = undefined;
                    await page.route("**/auth/token", (route) => {
                        credentials++;
                        return route.fulfill({ status: credentialStatus,
                            json: { token_type: "Bearer", access_token: "command-fixture-token" } });
                    });
                    await page.route("**/agui", async (route) => {
                        const input = route.request().postDataJSON();
                        requests.push(input);
                        assert.equal(route.request().headers().authorization, "Bearer command-fixture-token");
                        if (held) await held.promise;
                        const kind = input.forwardedProps.plurnk.action.kind;
                        const wait = kind === "models.list" && input.forwardedProps.plurnk.action.search === delayed?.search ? delayed : undefined;
                        if (wait) { wait.started.resolve(); await wait.release.promise; }
                        const outcome = catalog && kind === "providers.list" ? { kind, ok: true, result: { aliases: catalog.aliases } }
                            : catalog && kind === "models.list" ? { kind, ...(wait?.outcome ?? catalog.error ?? { ok: true, result: catalog.page }) } : result;
                        await route.fulfill({ contentType: "text/event-stream", body: [
                            { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
                            { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, result: outcome },
                        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
                        wait?.done.resolve();
                    });
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.command === "function");
                    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 1);
                    assert.equal(await page.locator('label[for="worker-message"]').count(), 0, "the textarea keeps its name without a visible title");
                    for (const [name, glyph] of [["Send", "▶️"], ["Stop", "⏹️"]]) {
                        const button = page.getByRole("button", { name, exact: true, includeHidden: true });
                        assert.equal(await button.getAttribute("title"), name);
                        assert.equal(await button.innerText(), "");
                        assert.ok((await button.evaluate((element) => getComputedStyle(element, "::before").content)).includes(glyph));
                    }
                    const send = page.getByRole("button", { name: "Send", exact: true });
                    const stop = page.getByRole("button", { name: "Stop", exact: true, includeHidden: true });
                    assert.equal(await stop.isVisible(), false, "no Stop is presented without known live work");
                    const actions = page.getByRole("group", { name: "Worker actions", exact: true });
                    assert.equal(await actions.locator("button").count(), 2);
                    assert.equal(await send.evaluate((button) => button.form.id), "worker-compose");
                    assert.equal(await stop.evaluate((button) => button.form.id), "worker-stop", "Stop has independent native submission, not reset semantics");
                    assert.equal(await stop.getAttribute("type"), "submit");
                    await page.locator('[aria-label="Worker controls"]').evaluate((element) => element.setAttribute("data-live-work", ""));
                    assert.equal(await stop.isVisible(), true, "known live work remains visible even while Stop is unavailable");
                    assert.equal(await stop.isDisabled(), true);
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        assert.equal(await stop.evaluate((button) => {
                            const style = getComputedStyle(button);
                            return ["background", "border", "hover-background", "hover-border", "inverse", "focus"]
                                .every((token) => style.getPropertyValue(`--pico-primary-${token}`) === style.getPropertyValue(`--pico-secondary-${token}`));
                        }), true, "Stop inherits Pico's secondary palette, including hover and focus");
                    }
                    for (const width of [320, 1280]) {
                        await page.setViewportSize({ width, height: 700 });
                        const sendBox = await send.boundingBox();
                        const stopBox = await stop.boundingBox();
                        assert.equal(sendBox.y, stopBox.y, "Pico groups both actions on the same row");
                        const draftBox = await page.getByRole("textbox", { name: "Message", exact: true }).boundingBox();
                        const margin = await send.evaluate((button) => parseFloat(getComputedStyle(button).marginInlineStart));
                        assert.ok(stopBox.x < draftBox.x && draftBox.x < sendBox.x);
                        assert.equal(Math.round(draftBox.x + draftBox.width + margin), Math.round(sendBox.x),
                            "Send joins the textarea with Pico's native group margin");
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    }
                    await page.setViewportSize({ width: 320, height: 700 });
                    const command = (text) => page.evaluate((text) => window.command(text), text);
                    const rows = page.locator("#worker-command-results > ul > li");
                    for (const text of ["/", "  /help /model \n", "/yolo"]) assert.equal(await command(text), true);
                    for (const text of ["/quit", "/help unknown", "/stop now", "/model a b c", "/effort a b", "/capabilities {"]) {
                        assert.equal(await command(text), false);
                    }
                    assert.equal(requests.length, 0);
                    assert.equal(credentials, 0);
                    assert.equal(await command("/model"), true);
                    assert.equal(await rows.last().locator("header code").textContent(), "/model");
                    assert.equal(await rows.last().getAttribute("data-command-input"), null, "the submitted command is content, not attribute state");
                    assert.match(await rows.last().textContent(), /Not selected/u);
                    const source = '<script>window.commandExecuted=true</script>';
                    result = { kind: "worker.model.get", ok: true, result: { model: { provider: "fixture", model: source }, spawnModel: null } };
                    assert.equal(await command("/model"), true);
                    assert.match(await rows.last().textContent(), /<script>/u);
                    assert.equal(await rows.locator("script").count(), 0, "daemon strings remain literal text");
                    catalog = {
                        aliases: [{ alias: "local", provider: "fixture", model: "small", active: true }],
                        page: { items: [{ selector: "fixture/small", provider: "fixture", providerName: "Fixture",
                            model: "small", modelName: source, limits: { contextTokens: 32768 },
                            capabilities: { attachment: false, reasoning: true, efforts: ["low", "high"],
                                toolCall: true, inputModalities: ["text"], outputModalities: ["text"] },
                            readiness: { ready: false, causes: [{ kind: "credential", alternatives: [["FIXTURE_KEY"]] }] },
                        }], offset: 0, total: 2, nextOffset: 1 },
                    };
                    assert.equal(await command("/models fixture"), true);
                    assert.equal(await rows.last().locator("[data-model-aliases] > li").count(), 1);
                    assert.equal(await rows.last().locator("tbody tr").count(), 1);
                    assert.equal(await rows.last().locator("[data-text=model-name]").textContent(), source);
                    assert.equal(await rows.last().locator("[data-text=model-readiness]").textContent(), "Not configured");
                    assert.equal(await rows.last().locator("[data-text=model-more]").isVisible(), true);
                    assert.equal(requests.at(-1).forwardedProps.plurnk.action.search, "fixture");
                    const modelButton = page.getByRole("button", { name: "Model", exact: true });
                    const modelPanel = page.locator("#worker-model-settings");
                    const selectModel = modelPanel.getByRole("combobox", { name: "Search Models", exact: true });
                    result = { kind: "worker.model.get", ok: true, result: { model: null } };
                    await modelButton.press("Enter");
                    await modelPanel.locator('datalist option[value="fixture/small"]').waitFor({ state: "attached" });
                    assert.equal(await modelButton.getAttribute("aria-expanded"), "true");
                    assert.equal(await selectModel.inputValue(), "");
                    assert.equal(await selectModel.getAttribute("placeholder"), "Search Models");
                    assert.equal(await modelPanel.locator('datalist option[value="fixture/small"]').textContent(), `${source} — Not configured`);
                    assert.equal(await modelPanel.locator("script").count(), 0);
                    assert.equal(await modelPanel.locator("header, footer, label, h2, select, [data-text=catalog-summary]").count(), 0);
                    assert.deepEqual(await modelPanel.getByRole("button").allTextContents(), ["Cancel", "Select Model"]);
                    assert.equal(await modelPanel.locator("p:visible").count(), 0, "no success or catalog-summary chatter");
                    assert.equal(await modelPanel.evaluate((panel) => Boolean(document.querySelector("#worker-conversation").compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
                    assert.equal(await page.locator("main").evaluate((main) => main.scrollWidth <= main.clientWidth), true, "native model choices fit the narrow main region");
                    delayed = { search: "stale", started: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers(),
                        outcome: { ok: false, problem: { type: "https://example.test/problems/catalog", title: "Stale search", status: 503, detail: "Stale failure." } } };
                    await selectModel.fill("stale");
                    await delayed.started.promise;
                    const beforeSearch = requests.length;
                    catalog.page = { items: [{ ...catalog.page.items[0], selector: "fixture/beyond-first-page", model: "beyond-first-page" }], offset: 0, total: 1 };
                    await selectModel.fill("beyond-first-page");
                    await modelPanel.locator('datalist option[value="fixture/beyond-first-page"]').waitFor({ state: "attached" });
                    assert.deepEqual(requests.slice(beforeSearch).map(({ forwardedProps }) => forwardedProps.plurnk.action.kind), ["providers.list", "models.list"]);
                    assert.equal(requests.at(-1).forwardedProps.plurnk.action.search, "beyond-first-page");
                    assert.equal(await modelPanel.locator('datalist option[value="local"]').count(), 0);
                    delayed.release.resolve();
                    await delayed.done.promise;
                    assert.equal(await modelPanel.locator("p:visible").count(), 0, "superseded catalog failure cannot overwrite current suggestions");
                    assert.equal(await modelPanel.locator('datalist option[value="fixture/beyond-first-page"]').count(), 1);
                    delayed = undefined;
                    catalog.error = { ok: false, problem: { type: "https://example.test/problems/catalog", title: "Catalog unavailable", status: 503, detail: "Catalog unavailable." } };
                    await selectModel.fill("unavailable");
                    await modelPanel.getByRole("status").filter({ hasText: "Catalog unavailable." }).waitFor();
                    assert.equal(await selectModel.inputValue(), "unavailable");
                    catalog.error = undefined;
                    await selectModel.fill("fixture/not-in-catalog");
                    result = { kind: "worker.model.set", ok: false, problem: { type: "https://example.test/problems/config", title: "Not configured", status: 422, detail: "Credential required.", recovery: "Configure this provider." } };
                    const historyCount = await rows.count();
                    await modelPanel.getByRole("button", { name: "Select Model", exact: true }).click();
                    await modelPanel.getByRole("status").filter({ hasText: "Credential required." }).waitFor();
                    assert.equal(await selectModel.inputValue(), "fixture/not-in-catalog", "suggestions are not an admission allowlist");
                    assert.equal(await modelPanel.locator("[data-text=settings-recovery]").textContent(), "Configure this provider.");
                    assert.equal(await rows.count(), historyCount, "native selection is not synthetic command history");
                    assert.equal(await modelPanel.isVisible(), true, "refusal retains the form");
                    result = { kind: "worker.model.set", ok: true, result: { provider: "fixture", model: "not-in-catalog" } };
                    await modelPanel.getByRole("button", { name: "Select Model", exact: true }).click();
                    await modelPanel.waitFor({ state: "hidden" });
                    assert.equal(await modelButton.getAttribute("aria-expanded"), "false");
                    assert.equal(await modelButton.evaluate((button) => document.activeElement === button), true);
                    const effortButton = page.getByRole("button", { name: "Effort", exact: true });
                    const effortPanel = page.locator("#worker-effort-settings");
                    result = { kind: "worker.effort.get", ok: true, result: { effort: null, source: "default", supportedEfforts: [] } };
                    await effortButton.click();
                    await effortPanel.getByRole("status").filter({ hasText: "No supported efforts." }).waitFor();
                    assert.equal(await modelPanel.isVisible(), false);
                    assert.equal(await effortPanel.getByRole("button", { name: "Select Effort", exact: true }).isDisabled(), true);
                    assert.deepEqual(await effortPanel.getByRole("button").allTextContents(), ["Cancel", "Select Effort"]);
                    assert.equal(await effortPanel.getByRole("combobox").locator('option[value=""]').textContent(), "Reasoning Effort");
                    await effortPanel.getByRole("button", { name: "Cancel", exact: true }).click();
                    assert.equal(await effortButton.evaluate((button) => document.activeElement === button), true);
                    catalog.page = { items: [], offset: 0, total: 0 };
                    assert.equal(await command("/models absent"), true);
                    assert.equal(await rows.last().locator("[data-no-aliases]").isVisible(), true);
                    catalog = undefined;
                    const problem = { type: "https://example.test/problems/busy", title: "Busy", status: 409, detail: "Worker still active.", recovery: "Wait for the work to settle." };
                    result = { kind: "worker.model.set", ok: false, problem };
                    assert.equal(await command("/model fixture"), false);
                    assert.equal(await rows.last().locator("[data-text=command-message]").textContent(), problem.detail);
                    assert.equal(await rows.last().locator("[data-text=command-recovery]").textContent(), problem.recovery);
                    assert.equal(await rows.last().locator("article").getAttribute("data-command-status"), "409");
                    assert.equal(await rows.last().locator("details, pre").count(), 0);
                    for (const invalid of [
                        { ok: true, result: null },
                        { kind: "worker.model.get", ok: true },
                        { kind: "worker.model.get", ok: true, result: { model: 42 } },
                    ]) {
                        result = invalid;
                        assert.equal(await command("/model"), false, "missing, mismatched and malformed results cannot claim success");
                    }
                    credentialStatus = 401;
                    const count = requests.length;
                    assert.equal(await command("/model"), false);
                    assert.equal(requests.length, count, "credential refusal prevents action delivery");
                    assert.match(await rows.last().textContent(), /401/u);
                    checkBrowser(engine === firefox ? [] : [httpFailure("/auth/token", 401)]);
                    credentialStatus = 200;
                    result = { kind: "worker.model.get", ok: true, result: { model: null, spawnModel: null } };
                    assert.equal(await command("/model"), true, "a later explicit command can recover");
                    for (const input of requests) {
                        assert.equal(input.threadId, "7#user");
                        assert.deepEqual(input.messages, []);
                        assert.deepEqual(input.tools, []);
                        assert.equal(input.forwardedProps.plurnk.interactive, undefined);
                    }
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    held = Promise.withResolvers();
                    const received = page.waitForRequest("**/agui");
                    const pending = command("/model");
                    await received;
                    await page.evaluate(() => window.depart());
                    held.resolve();
                    assert.equal(await pending, false, "departure cancels only delivery, with no successful result invented");
                    assert.equal(await rows.last().locator("[data-command-state=error]").count(), 1);
                    assert.equal(await rows.last().locator("[data-text=command-message]").textContent(), "Response not confirmed.");
                    assert.equal(requests.some((input) => input.forwardedProps.plurnk.action.kind === "loop.cancel"), false);
                    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
