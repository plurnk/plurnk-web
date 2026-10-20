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
                        const outcome = catalog && kind === "providers.list" ? { kind, ok: true, result: { aliases: catalog.aliases } }
                            : catalog && kind === "models.list" ? { kind, ok: true, result: catalog.page } : result;
                        await route.fulfill({ contentType: "text/event-stream", body: [
                            { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
                            { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, result: outcome },
                        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
                    });
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.command === "function");
                    const command = (text) => page.evaluate((text) => window.command(text), text);
                    const rows = page.locator("#worker-command-results > ol > li");
                    for (const text of ["/", "  /help /model \n", "/yolo"]) assert.equal(await command(text), true);
                    for (const text of ["/quit", "/help unknown", "/stop now", "/model a b c", "/effort a b", "/capabilities {"]) {
                        assert.equal(await command(text), false);
                    }
                    assert.equal(requests.length, 0);
                    assert.equal(credentials, 0);
                    assert.equal(await command("/model"), true);
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
                    catalog.page = { items: [], offset: 0, total: 0 };
                    assert.equal(await command("/models absent"), true);
                    assert.equal(await rows.last().locator("[data-no-aliases]").isVisible(), true);
                    catalog = undefined;
                    const problem = { type: "https://example.test/problems/busy", title: "Busy", status: 409, detail: "Worker still active.", recovery: "Wait for the work to settle." };
                    result = { kind: "worker.model.set", ok: false, problem };
                    assert.equal(await command("/model fixture"), false);
                    assert.deepEqual(JSON.parse(await rows.last().locator("[data-text=command-problem]").textContent()), problem);
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
