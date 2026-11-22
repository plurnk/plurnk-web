import assert from "node:assert/strict";
import { firefox } from "playwright";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

// {§web-session-commands} Controlled protocol failures through the real SDK and native templates.
export default async function verifyCommands(t) {
    const fixture = await conversationFixture(new URL("./commands-entry.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    let credentials = 0;
                    let credentialStatus = 200;
                    const modelResponse = (model) => ({ configOptions: [], availableCommands: [], _meta: { plurnk: { status: { model, spawnModel: null } } } });
                    /** @type {any} */
                    let result = modelResponse(null);
                    let held = undefined;
                    await page.route("**/auth/token", (route) => {
                        credentials++;
                        return route.fulfill({ status: credentialStatus,
                            json: { token_type: "Bearer", access_token: "command-fixture-token" } });
                    });
                    fixture.onAcp(async (input, headers) => {
                        assert.equal(headers.authorization, "Bearer command-fixture-token");
                        requests.push(input);
                        if (held) await held.promise;
                        const errorProblem = result?.problem;
                        return errorProblem
                            ? { error: { code: -32000, message: errorProblem.detail, data: errorProblem } }
                            : { result };
                    });
                    await page.goto(fixture.url);
                    await page.waitForFunction(() => typeof window.command === "function");
                    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 1);
                    assert.equal(await page.locator('label[for="session-message"]').count(), 0, "the textarea keeps its name without a visible title");
                    for (const [name, glyph, expectedTitle] of [
                        ["Send", "▶️", "Send (Enter · Ctrl+Enter)"],
                        ["Stop", "⏹️", "Stop"],
                        ["Attach image", "📎", "Attach image"],
                        ["Commands and skills", "/", "Commands and skills (/)"],
                        ["Sessions", "☰", "Sessions"],
                    ]) {
                        const button = page.getByRole("button", { name, exact: true, includeHidden: true });
                        assert.equal(await button.getAttribute("title"), expectedTitle);
                        assert.equal(await button.innerText(), "");
                        assert.ok((await button.evaluate((element) => getComputedStyle(element, "::before").content)).includes(glyph));
                    }
                    const send = page.getByRole("button", { name: "Send", exact: true });
                    const stop = page.getByRole("button", { name: "Stop", exact: true, includeHidden: true });
                    const attach = page.getByRole("button", { name: "Attach image", exact: true, includeHidden: true });
                    const insertCmd = page.getByRole("button", { name: "Commands and skills", exact: true });
                    assert.equal(await stop.isVisible(), false, "no Stop is presented without known live work");
                    assert.equal(await attach.isVisible(), false, "no Attach image is presented without prompt.image capability");
                    assert.equal(await insertCmd.isVisible(), true);
                    const actions = page.getByRole("group", { name: "Session actions", exact: true });
                    assert.equal(await actions.locator("button").count(), 5);
                    assert.equal(await send.evaluate((button) => button.form.id), "session-compose");
                    assert.equal(await stop.evaluate((button) => button.form.id), "session-stop", "Stop has independent native submission, not reset semantics");
                    assert.equal(await stop.getAttribute("type"), "submit");
                    await page.locator('[aria-label="Session controls"]').evaluate((element) => {
                        element.setAttribute("data-live-work", "");
                        element.setAttribute("data-prompt-image", "true");
                    });
                    assert.equal(await stop.isVisible(), true, "known live work remains visible even while Stop is unavailable");
                    assert.equal(await attach.isVisible(), true, "advertised prompt.image capability presents Attach image");
                    assert.equal(await stop.isDisabled(), true);
                    for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
                        await page.emulateMedia({ colorScheme });
                        assert.equal(await stop.evaluate((button) => {
                            const style = getComputedStyle(button);
                            return ["background", "hover-background", "inverse", "focus"]
                                .every((token) => style.getPropertyValue(`--otm-primary-${token}`).trim() === style.getPropertyValue(`--otm-secondary-${token}`).trim());
                        }), true, "Stop inherits the secondary control palette, including hover and focus");
                    }
                    for (const width of [320, 1280]) {
                        await page.setViewportSize({ width, height: 700 });
                        const sendBox = await send.boundingBox();
                        const stopBox = await stop.boundingBox();
                        assert.equal(sendBox.y, stopBox.y, "role=group aligns actions on the same row");
                        const attachBox = await attach.boundingBox();
                        const insertBox = await insertCmd.boundingBox();
                        const draftBox = page.getByRole("textbox", { name: "Message", exact: true });
                        const draftRect = await draftBox.boundingBox();
                        const margin = await send.evaluate((button) => parseFloat(getComputedStyle(button).marginInlineStart));
                        assert.ok(stopBox.x < attachBox.x && attachBox.x < insertBox.x && insertBox.x < draftRect.x && draftRect.x < sendBox.x);
                        assert.equal(Math.round(draftRect.x + draftRect.width + margin), Math.round(sendBox.x),
                            "Send joins the textarea with the native group margin");
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    }
                    for (const colorScheme of /** @type {const} */ (["light", "dark"])) {
                        await page.emulateMedia({ colorScheme });
                        const field = page.getByRole("textbox", { name: "Message", exact: true });
                        for (const draft of ["One line", "First line\nSecond line\nThird line"]) {
                            await field.fill(draft);
                            await field.focus();
                            const focusShadow = await field.evaluate(async (element) => {
                                await Promise.all(element.getAnimations().map((animation) => animation.finished));
                                return getComputedStyle(element).boxShadow;
                            });
                            assert.ok(focusShadow.includes("inset"), `${colorScheme}: textarea focus stays within its control`);
                            const geometry = await actions.evaluate((group) => [...group.children]
                                .filter((element) => getComputedStyle(element).display !== "none")
                                .map((element) => {
                                    const rect = element.getBoundingClientRect();
                                    const style = getComputedStyle(element);
                                    return { top: rect.top, bottom: rect.bottom, lineHeight: parseFloat(style.lineHeight), fontSize: parseFloat(style.fontSize) };
                                }));
                            assert.ok(geometry.every(({ top, bottom }) => top === geometry[0].top && bottom === geometry[0].bottom),
                                "focus and multiline growth keep every composer control aligned");
                            assert.ok(geometry.every(({ lineHeight, fontSize }) => lineHeight / fontSize === 1.25),
                                "the single substrate line-height token consistently sizes the composer");
                            assert.equal(await field.evaluate((element) => getComputedStyle(element).boxShadow.includes("inset")), true,
                                `${colorScheme}: textarea focus remains visible without projecting beyond the control`);
                        }
                        await field.fill("");
                    }
                    await page.setViewportSize({ width: 320, height: 700 });
                    const command = (text) => page.evaluate((text) => window.command(text), text);
                    const isCommand = (text, available = []) => page.evaluate(({ text, available }) => window.isCommand(text, available), { text, available });
                    assert.equal(await isCommand("/skill run", [{ name: "skill" }]), false, "advertised non-skill availableCommands pass through to session/prompt");
                    assert.equal(await isCommand("/github:review pr", [{ type: "command", name: "github:review" }]), false, "advertised MCP prompt command entries pass through to session/prompt");
                    assert.equal(await isCommand("/personas list", [{ type: "command", name: "personas" }]), true, "built-in client commands remain intercepted even when advertised in availableCommands");
                    assert.equal(await isCommand("/triage", [{ type: "skill", name: "triage" }]), true, "advertised skill entries do not match as slash commands");
                    assert.equal(await isCommand("/learn distill this", []), false, "/learn expands into a session prompt instead of running locally");
                    const expandedLearn = await page.evaluate(() => window.expandPromptCommand("/learn focus on tests"));
                    assert.match(expandedLearn, /SKILL\.md[\s\S]*mcp:\/\/\/plurnk\/skills\.json[\s\S]*Focus: focus on tests/u);
                    assert.doesNotMatch(expandedLearn, /recipes\.md/u);
                    assert.equal(await isCommand("/model", [{ name: "skill" }]), true, "local slash commands remain intercepted");
                    assert.equal(await isCommand("/quit", [{ name: "skill" }]), true, "unadvertised unknown slash commands remain intercepted locally");
                    assert.equal(await isCommand(": /model", []), false, "leading ': ' escapes slash commands");
                    assert.equal(await page.evaluate(() => window.isLocalExec("! git status")), true);
                    assert.equal(await page.evaluate(() => window.isLocalExec("await plurnk.note({ body: 'ok' })")), true);
                    assert.equal(await page.evaluate(() => window.isLocalExec(": ! git status")), false, "leading ': ' escapes local exec");
                    assert.deepEqual(
                        await page.evaluate(() => window.extractOpenPaths("Inspect @src/index.ts and @README.md, ignore user@example.com, @alice, and @../secret.env.", "/workspace")),
                        ["src/index.ts", "README.md"],
                    );
                    assert.deepEqual(
                        await page.evaluate(() => window.extractOpenPaths("Inspect @src/index.ts", null)),
                        [],
                        "folderless workspaces emit no openPaths",
                    );
                    assert.deepEqual(
                        await page.evaluate(() => window.prepareComposerPrompt("? Check @src/app.js", { projectRoot: "/workspace" })),
                        { ok: true, prompt: "Check @src/app.js", forceReview: true, openPaths: ["src/app.js"] },
                    );
                    assert.deepEqual(
                        await page.evaluate(() => window.prepareComposerPrompt(": /model literal", { projectRoot: "/workspace" })),
                        { ok: true, prompt: "/model literal", forceReview: false, openPaths: [] },
                    );
                    assert.deepEqual(
                        await page.evaluate(() => window.prepareComposerPrompt("... follow up", { projectRoot: null })),
                        { ok: true, prompt: "follow up", forceReview: false, openPaths: [] },
                    );
                    // {§web-session-commands} Progressive multi-token autocomplete across command names and subsequent argument tokens.
                    const autocompleteSources = {
                        models: ["local", "fast"],
                        efforts: ["low", "high"],
                        personas: ["none", "reviewer"],
                        modes: ["default", "architect"],
                        workspaces: ["conversation", "ops"],
                        sessions: ["session1", "user"],
                        gateIds: ["@gate-42"],
                        familyAliases: {
                            mcp: ["svc-git", "remote-docs"],
                            skills: ["triage"],
                            schedule: ["nightly"],
                            personas: ["reviewer"],
                            members: ["src/**"],
                            env: ["API_TOKEN"],
                        },
                    };
                    const suggest = (draft, availableCommands = []) =>
                        page.evaluate(({ draft, sources }) => window.computeCommandSuggestions(draft, sources), {
                            draft,
                            sources: { ...autocompleteSources, availableCommands },
                        });
                    const accept = (draft, suggestion) =>
                        page.evaluate(({ draft, suggestion, sources }) => window.acceptCommandSuggestion(draft, suggestion, sources), {
                            draft,
                            suggestion,
                            sources: autocompleteSources,
                        });

                    const allSlash = await suggest("/");
                    assert.ok(allSlash.items.length > 25, "bare '/' surfaces all command candidates without an 8-item cap");
                    assert.deepEqual((await suggest("/mo")).items, ["/model", "/models", "/mode"]);
                    const modelArgs = await suggest("/model ");
                    assert.deepEqual(modelArgs.items, ["local", "fast"]);
                    assert.equal(await accept("/model ", modelArgs.items[0]), "/model local ");
                    const modelEfforts = await suggest("/model local ");
                    assert.deepEqual(modelEfforts.items, ["low", "high"]);
                    assert.equal(await accept("/model local ", modelEfforts.items[1]), "/model local high");
                    assert.deepEqual((await suggest("/effort ")).items, ["low", "high"]);
                    assert.deepEqual((await suggest("/persona r")).items, ["reviewer"]);
                    assert.equal((await suggest("/mcp e")).items[0], "enable", "prefix match orders ahead of substring matches");
                    assert.deepEqual((await suggest("/mcp en")).items, ["enable"]);
                    assert.equal(await accept("/mcp en", "enable"), "/mcp enable ");
                    assert.deepEqual((await suggest("/mcp enable ")).items, ["svc-git", "remote-docs"]);
                    assert.deepEqual((await suggest("/env --scope ")).items, ["session", "workspace"]);
                    assert.equal(await accept("/env --scope ", "session"), "/env --scope session ");
                    assert.deepEqual((await suggest("/env unset ")).items, ["API_TOKEN"]);
                    assert.deepEqual((await suggest("/accept ")).items, ["@gate-42"]);
                    assert.deepEqual((await suggest("/learn ")).items, ["--scope"]);
                    assert.deepEqual((await suggest("/learn --scope ")).items, ["project", "plurnk"]);

                    // {§web-session-commands} {§web-workspace-settings} Inspection and list commands route directly to unified /settings/ tabs.
                    const feedback = page.locator('[aria-label="Message feedback"]');
                    const statusText = feedback.locator('[data-text="message-status"]');
                    const errorText = feedback.locator('[data-text="command-error"]');
                    const outputDialog = page.locator("#dialog-command-output");

                    for (const [cmd, expectedTarget] of [
                        ["/", "/settings/?workspace=conversation&session=session1#help"],
                        ["  /help /model \n", "/settings/?workspace=conversation&session=session1&cmd=model#help"],
                        ["/help learn", "/settings/?workspace=conversation&session=session1&cmd=learn#help"],
                        ["/onboard", "/settings/?workspace=conversation&session=session1&setup=1#models"],
                        ["/models", "/settings/?workspace=conversation&session=session1#models"],
                        ["/models fixture", "/settings/?workspace=conversation&session=session1&q=fixture#models"],
                        ["/model", "/settings/?workspace=conversation&session=session1#models"],
                        ["/effort", "/settings/?workspace=conversation&session=session1#models"],
                        ["/child", "/settings/?workspace=conversation&session=session1#models"],
                        ["/persona", "/settings/?workspace=conversation&session=session1#personas"],
                        ["/mode", "/settings/?workspace=conversation&session=session1#general"],
                        ["/mcp", "/settings/?workspace=conversation&session=session1#mcp"],
                        ["/mcp list", "/settings/?workspace=conversation&session=session1#mcp"],
                        ["/skills list", "/settings/?workspace=conversation&session=session1#skills"],
                        ["/schedule list", "/settings/?workspace=conversation&session=session1#schedule"],
                        ["/personas list", "/settings/?workspace=conversation&session=session1#personas"],
                        ["/members list", "/settings/?workspace=conversation&session=session1#members"],
                        ["/env list", "/settings/?workspace=conversation&session=session1&envScope=session#env"],
                        ["/env --scope workspace list", "/settings/?workspace=conversation&session=session1#env"],
                    ]) {
                        await page.evaluate(() => { window.lastNavigated = null; });
                        assert.equal(await command(cmd), true, cmd);
                        assert.equal(await page.evaluate(() => window.lastNavigated), expectedTarget, cmd);
                    }

                    assert.equal(await command("/yolo"), true);
                    assert.equal(await statusText.textContent(), "Approvals: Automatic.");

                    for (const text of ["/quit", "/help unknown", "/stop now", "/model a b c", "/effort a b"]) {
                        assert.equal(await command(text), false, text);
                        assert.equal(await feedback.locator('[role="alert"]').isVisible(), true, text);
                    }
                    assert.equal(requests.length, 0);
                    assert.equal(credentials, 0);

                    // Multi-line CLI output opens in #dialog-command-output without injecting DOM scripts or waterfall cards.
                    const source = '<script>window.commandExecuted=true</script>';
                    result = { results: [{ status: 200, content: `shell-ok ${source}` }] };
                    assert.equal(await command("! echo shell-ok"), true);
                    assert.equal(requests.at(-1).params.kind, "op.exec");
                    assert.match(requests.at(-1).params.params.text, /plurnk\.sh\(/u);
                    await outputDialog.waitFor({ state: "visible" });
                    assert.equal(await outputDialog.locator('[data-text="command-title"]').textContent(), "! echo shell-ok");
                    assert.equal(await outputDialog.locator('[data-text="command-literal"]').textContent(), `shell-ok ${source}`);
                    assert.equal(await outputDialog.locator("script").count(), 0, "daemon strings remain literal text");
                    await outputDialog.locator("button[data-dialog-close]").click();
                    await outputDialog.waitFor({ state: "hidden" });

                    result = { results: [{ status: 200, content: "note-ok" }] };
                    assert.equal(await command('plurnk.note({ body: "note-ok" })'), true);
                    assert.equal(requests.at(-1).params.kind, "op.exec");
                    await outputDialog.waitFor({ state: "visible" });
                    assert.equal(await outputDialog.locator('[data-text="command-literal"]').textContent(), "note-ok");
                    await outputDialog.press("Escape");
                    await outputDialog.waitFor({ state: "hidden" });

                    result = { family: "mcp", candidates: [{ alias: "sqlite-mcp", summary: "SQLite inspector" }] };
                    assert.equal(await command("/mcp discover sqlite"), true);
                    assert.equal(requests.at(-1).params.kind, "workspace.mcp.discover");
                    await outputDialog.waitFor({ state: "visible" });
                    assert.match(await outputDialog.locator('[data-text="command-literal"]').textContent(), /sqlite-mcp {2}SQLite inspector/u);
                    await outputDialog.locator("button[data-dialog-close]").click();
                    await outputDialog.waitFor({ state: "hidden" });

                    // Direct mutations confirm in #session-feedback without opening dialogs or leaking secrets.
                    result = { configOptions: [{ configId: "persona", name: "Persona", type: "select", currentValue: "reviewer", options: [{ value: "none", name: "none" }, { value: "reviewer", name: "reviewer" }] }] };
                    assert.equal(await command("/persona reviewer"), true);
                    assert.equal(requests.at(-1).method, "session/set_config_option");
                    assert.equal(requests.at(-1).params.configId, "persona");
                    assert.equal(await statusText.textContent(), "Persona: reviewer. Supported: none, reviewer.");

                    result = { configOptions: [{ configId: "spawn_model", name: "Child Session Model", type: "select", currentValue: "inherit", options: [{ value: "inherit", name: "inherit" }] }] };
                    assert.equal(await command("/child inherit"), true);
                    assert.equal(requests.at(-1).params.configId, "spawn_model");
                    assert.equal(await statusText.textContent(), "Child model: inherit.");

                    result = { to: "1/1/2", restored: ["a.ts"], skipped: [] };
                    assert.equal(await command("/rollback 1/1/2"), true);
                    assert.equal(requests.at(-1).params.kind, "session.rollback");
                    assert.equal(await statusText.textContent(), "Rolled back to 1/1/2 (1 restored, 0 skipped).");

                    result = { folder: "/tmp/digest-out" };
                    assert.equal(await command("/share /tmp/digest-out"), true);
                    assert.equal(requests.at(-1).params.kind, "workspace.share");
                    assert.equal(await statusText.textContent(), "Shared digest: /tmp/digest-out.");

                    result = { status: 201 };
                    assert.equal(await command("/env --scope workspace set NEW_FLAG inline-secret-value"), true);
                    assert.deepEqual([requests.at(-1).params.kind, requests.at(-1).params.params], [
                        "workspace.env.replace",
                        { alias: "NEW_FLAG", value: "inline-secret-value" },
                    ]);
                    assert.doesNotMatch(await feedback.textContent(), /inline-secret-value/u);

                    result = modelResponse({ alias: "local", provider: "fixture", model: "small", effort: "high", effortSource: "explicit" });
                    assert.equal(await command("/model local high"), true);
                    assert.equal(await statusText.textContent(), "Model: local — fixture/small (high).");

                    // Daemon Problem refusals, malformed responses, auth failures, and aborted requests report cleanly in #session-feedback.
                    const problem = { type: "https://example.test/problems/busy", title: "Busy", status: 409, detail: "Session still active.", recovery: "Wait for the work to settle." };
                    result = { ok: false, problem };
                    assert.equal(await command("/model fixture"), false);
                    assert.equal(await errorText.textContent(), `${problem.detail} ${problem.recovery}`);

                    for (const invalid of [
                        { configOptions: [], availableCommands: [] },
                        { configOptions: [], availableCommands: [], _meta: { plurnk: { status: {} } } },
                        { configOptions: [], availableCommands: [], _meta: { plurnk: { status: { model: 42 } } } },
                    ]) {
                        result = invalid;
                        assert.equal(await command("/model local"), false, "missing, mismatched and malformed results cannot claim success");
                    }

                    credentialStatus = 401;
                    const count = requests.length;
                    assert.equal(await command("/model local"), false);
                    assert.equal(requests.length, count, "credential refusal prevents action delivery");
                    assert.match(await errorText.textContent(), /401/u);
                    checkBrowser(engine === firefox ? [] : [httpFailure("/auth/token", 401)]);

                    credentialStatus = 200;
                    result = modelResponse({ alias: "local", provider: "fixture", model: "small" });
                    assert.equal(await command("/model local"), true, "a later explicit command can recover");

                    for (const input of requests) {
                        if (input.method !== "providers/list") {
                            assert.equal(input.params.sessionId, "7#session1");
                        }
                        assert.equal(input.params.messages, undefined);
                        assert.equal(input.params._meta?.plurnk?.interactive, undefined);
                    }
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                    held = Promise.withResolvers();
                    const received = page.waitForRequest((req) => req.url().endsWith("/acp") && req.method() === "POST" && req.postDataJSON()?.method !== "initialize");
                    const pending = command("/model local");
                    await received;
                    await page.evaluate(() => window.depart());
                    held.resolve();
                    assert.equal(await pending, false, "departure cancels only delivery, with no successful result invented");
                    assert.equal(await errorText.textContent(), "Response not confirmed.");
                    assert.equal(requests.some((input) => input.method === "session/cancel"), false);
                    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
