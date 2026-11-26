import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics from "./browser-diagnostics.js";

function sessionMeta(lifecycle = "idle", older = null) {
    return {
        workspace: { id: 7, name: "conversation", projectRoot: null, projectLabel: null, preparation: [], activity: null },
        status: {
            lifecycle,
            model: { alias: null, provider: "fixture", model: "browser", effort: "low", effortSource: "default" },
            loopId: lifecycle === "idle" ? null : 2,
            packetCount: 0,
            waitUntil: null,
            descendants: [],
            inbox: [],
            claimedAt: lifecycle === "running" ? 1000 : null,
            terminatedAt: lifecycle === "completed" ? 2000 : null,
            spend: {
                requests: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
                knownUsage: { inputTokens: 0, outputTokens: 0 },
                costUsd: "0",
                knownCostUsd: "0",
            },
        },
        budget: { contextTokens: null, contextCapacity: null, curationWeight: null, curationBudget: null },
        history: { older },
    };
}

function permissionFrame(id, proposal) {
    const title = `${proposal.op} (${proposal.target.pathname})`;
    return {
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: {
            sessionId: "7#session1",
            title,
            description: "Review the requested action.",
            subject: {
                type: "tool_call",
                toolCall: {
                    toolCallId: proposal.coordinate,
                    name: proposal.op,
                    title,
                    kind: "execute",
                    status: "pending",
                },
            },
            options: [
                { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
                { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
            ],
            _meta: { plurnk: { proposal } },
        },
    };
}

// {§web-session-input} {§web-session-status} {§web-session-approval} {§web-session-history} Real observeSession keyboard, status and Reading Slate scroll contracts across engines.
export default async function verifySessionObserve(t) {
    const fixture = await conversationFixture(new URL("../web/app.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 390, height: 600 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();

                    await t.test("{§web-session-input} {§web-session-status} {§web-session-approval} {§web-session-commands} Shift+Tab toggles durable session approval mode in composer and settles pending proposals", async () => {
                        let currentMode = "review";
                        let pendingGateRequestId = null;
                        const modeConfigOptions = () => [
                            {
                                configId: "mode",
                                name: "Approval Policy",
                                type: "select",
                                currentValue: currentMode,
                                options: [
                                    { value: "review", name: "Review" },
                                    { value: "accept", name: "Accept" },
                                    { value: "reject", name: "Reject" },
                                ],
                            },
                        ];
                        fixture.onAcp((input) => {
                            if (input.method === undefined) {
                                assert.equal(input.error, undefined);
                                return {};
                            }
                            if (input.method === "session/resume") {
                                return {
                                    updates: [],
                                    result: {
                                        configOptions: modeConfigOptions(),
                                        availableCommands: [],
                                        _meta: { plurnk: sessionMeta("idle") },
                                    },
                                };
                            }
                            if (input.method === "session/set_config_option" && input.params.configId === "mode") {
                                currentMode = input.params.value;
                                if (currentMode === "accept" && pendingGateRequestId !== null) {
                                    const gateReqId = pendingGateRequestId;
                                    pendingGateRequestId = null;
                                    setTimeout(() => {
                                        fixture.pushFrame({ jsonrpc: "2.0", method: "$/cancel_request", params: { id: gateReqId } });
                                        fixture.push({
                                            sessionUpdate: "config_option_update",
                                            configOptions: modeConfigOptions(),
                                        });
                                        fixture.push({
                                            sessionUpdate: "state_update",
                                            state: "running",
                                            _meta: { plurnk: sessionMeta("running") },
                                        });
                                    }, 15);
                                }
                                return {
                                    result: {
                                        configOptions: modeConfigOptions(),
                                    },
                                };
                            }
                            return { result: {} };
                        });
                        await page.goto(fixture.url);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        const draft = page.getByRole("textbox", { name: "Message", exact: true });
                        const sendBtn = page.getByRole("button", { name: "Send", exact: true });
                        const statusFooter = page.locator("#session-status");
                        const statusLine = page.locator("#session-status > [data-status-line]");

                        assert.equal(await statusLine.isVisible(), true, "connected session keeps steady status row visible without focus jump");
                        await draft.focus();
                        await draft.fill("Draft stays intact.");
                        assert.equal(await statusLine.isVisible(), true);
                        assert.equal(await statusFooter.getAttribute("data-approval-mode"), "review");
                        assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🐹/u);

                        for (const lifecycle of ["idle", "running", "completed"]) {
                            fixture.push({
                                sessionUpdate: "state_update",
                                state: lifecycle === "running" ? "running" : "idle",
                                _meta: { plurnk: sessionMeta(lifecycle) },
                            });
                            await page.waitForFunction((expected) => document.querySelector("#session-status")?.dataset.lifecycle === expected, lifecycle);
                            await draft.focus();
                            const before = await statusFooter.getAttribute("data-approval-mode");
                            const expected = before === "accept" ? "review" : "accept";
                            await draft.press("Shift+Tab");
                            await page.waitForFunction((exp) => document.querySelector("#session-status")?.dataset.approvalMode === exp, expected);
                            assert.equal(await statusFooter.getAttribute("data-approval-mode"), expected, `${lifecycle}: Shift+Tab in composer toggles session approval mode`);
                            assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), expected === "accept" ? /🔥/u : /🐹/u);
                            assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", `${lifecycle}: composer keeps focus`);
                            assert.equal(await draft.inputValue(), "Draft stays intact.");
                        }

                        // Ended on completed with data-approval-mode === "accept" (idle->accept, running->review, completed->accept).
                        assert.equal(await statusFooter.getAttribute("data-approval-mode"), "accept");
                        await draft.press("Escape");
                        assert.notEqual(await page.evaluate(() => document.activeElement?.id), "session-message", "Escape leaves the composer cleanly");
                        assert.equal(await draft.inputValue(), "Draft stays intact.", "Escape preserves unsent draft");
                        assert.equal(await statusLine.isVisible(), true);

                        // Outside the composer when not interrupted, Shift+Tab preserves native backward focus traversal without toggling mode.
                        const effortLink = page.getByRole("link", { name: "Effort", exact: true });
                        await effortLink.focus();
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-effort");
                        await page.keyboard.press("Shift+Tab");
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-model", "Shift+Tab outside composer moves focus backward");
                        assert.equal(await statusFooter.getAttribute("data-approval-mode"), "accept", "backward focus navigation does not toggle mode");

                        // Toggle approval mode back to review from composer and verify steady status bar stays visible without shifting.
                        await draft.focus();
                        await draft.press("Shift+Tab");
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "review");
                        assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🐹/u);
                        await page.locator("body > header > a").focus();
                        assert.equal(await statusLine.isVisible(), true, "steady status bar causes zero focus/blur layout shift");

                        // When interrupted with a pending session/request_permission proposal, Shift+Tab switches mode to accept and settles the gate on the daemon.
                        pendingGateRequestId = "gate-yolo-1";
                        fixture.pushFrame(permissionFrame("gate-yolo-1", {
                            logEntryId: 10,
                            sessionId: 9,
                            session: "session1",
                            loopId: 2,
                            turnId: 1,
                            coordinate: "2/1/2",
                            op: "sh",
                            target: { scheme: "file", authority: null, pathname: "witness.txt" },
                            body: "echo ok\n",
                            attrs: {},
                            owner: "acp://operator/sessions/session1",
                            disposition: { decision: "review" },
                            expiresAt: "2030-01-01T00:00:00Z",
                        }));
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
                        await page.locator("body > header > a").focus();
                        await page.keyboard.press("Shift+Tab");
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "accept");
                        assert.match(await sendBtn.evaluate((el) => getComputedStyle(el, "::before").content), /🔥/u);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        assert.equal(pendingGateRequestId, null);
                        assert.equal(await page.locator('form[aria-label="Review requests"]').getAttribute("data-request-count"), "0");
                    });

                    await t.test("{§web-session-history} Reading Slate lands initial arrival at bottom, frames submitted turns at top without chasing streaming output, and surfaces jump-to-bottom / pending-review pill", async () => {
                        await page.route("**/history/older-loop", (route) => route.fulfill({
                            json: {
                                session: "7#session1",
                                history: { older: null },
                                updates: Array.from({ length: 12 }, (_, idx) => ({
                                    sessionUpdate: idx % 2 === 0 ? "user_message_chunk" : "agent_message_chunk",
                                    messageId: `older-${idx}`,
                                    content: { type: "text", text: `Archived loop 1 entry ${idx}: ${"steady anchor line ".repeat(6)}` },
                                    _meta: { plurnk: { id: idx + 1, coordinate: `1/${Math.floor(idx / 2) + 1}/1`, loopId: 1, loopSeq: 1 } },
                                })),
                            },
                        }));

                        const liveUpdates = Array.from({ length: 18 }, (_, idx) => ({
                            sessionUpdate: idx % 2 === 0 ? "user_message_chunk" : "agent_message_chunk",
                            messageId: `live-${idx}`,
                            content: { type: "text", text: `Loop 2 message ${idx}: ${"conversation paragraph ".repeat(8)}` },
                            _meta: { plurnk: { id: 100 + idx, coordinate: `2/${Math.floor(idx / 2) + 1}/1`, loopId: 2, loopSeq: 2 } },
                        }));

                        let nextPromptId = 300;
                        fixture.onAcp((input) => {
                            if (input.method === undefined) {
                                assert.equal(input.error, undefined);
                                setTimeout(() => {
                                    fixture.push({
                                        sessionUpdate: "state_update",
                                        state: "running",
                                        _meta: { plurnk: sessionMeta("running", "/history/older-loop") },
                                    });
                                }, 20);
                                return {};
                            }
                            if (input.method === "session/resume") {
                                return {
                                    updates: liveUpdates,
                                    result: {
                                        configOptions: [],
                                        availableCommands: [],
                                        _meta: { plurnk: sessionMeta("running", "/history/older-loop") },
                                    },
                                };
                            }
                            if (input.method === "session/prompt") {
                                const id = ++nextPromptId;
                                const replyId = `reply-${id}`;
                                const turnUpdates = [
                                    {
                                        sessionUpdate: "user_message_chunk",
                                        messageId: input.params.messageId,
                                        content: { type: "text", text: input.params.prompt[0].text },
                                        _meta: { plurnk: { id, coordinate: `2/${id}/1`, loopId: 2, loopSeq: 2, origin: "operator" } },
                                    },
                                    {
                                        sessionUpdate: "agent_message_chunk",
                                        messageId: replyId,
                                        content: { type: "text", text: "First line of incoming answer." },
                                        _meta: { plurnk: { id: id + 100, coordinate: `2/${id}/2`, loopId: 2, loopSeq: 2 } },
                                    },
                                ];
                                liveUpdates.push(...turnUpdates);
                                return {
                                    updates: [
                                        ...turnUpdates,
                                        {
                                            sessionUpdate: "state_update",
                                            state: "idle",
                                            stopReason: "end_turn",
                                            _meta: {
                                                plurnk: {
                                                    ...sessionMeta("completed", "/history/older-loop"),
                                                    terminal: { status: 200 },
                                                },
                                            },
                                        },
                                    ],
                                    result: {
                                        messageId: input.params.messageId,
                                        stopReason: "end_turn",
                                        _meta: { plurnk: sessionMeta("completed", "/history/older-loop") },
                                    },
                                };
                            }
                            return { result: {} };
                        });

                        await page.goto(fixture.url);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        await page.locator('[data-message-id="live-17"]').waitFor();

                        const metrics = () => page.locator("#main").evaluate((main) => {
                            const spacer = main.querySelector("svg[data-slate-spacer]");
                            const spacerHeight = Number(spacer?.getAttribute("height") ?? "0") || 0;
                            const realHeight = main.scrollHeight - spacerHeight;
                            return {
                                scrollTop: main.scrollTop,
                                scrollHeight: main.scrollHeight,
                                clientHeight: main.clientHeight,
                                spacerHeight,
                                gap: realHeight - main.scrollTop - main.clientHeight,
                            };
                        });

                        const jumpBtn = page.locator("[data-jump-bottom]");

                        // 1. Initial arrival lands at the bottom of real content with zero spacer and hidden jump button.
                        const initial = await metrics();
                        assert.ok(initial.scrollHeight > initial.clientHeight * 2, "multi-message session overflows main");
                        assert.ok(initial.gap <= 24, `initial transcript arrival lands at main's bottom edge (gap=${initial.gap})`);
                        assert.equal(initial.spacerHeight, 0);
                        assert.equal(await jumpBtn.isVisible(), false);

                        const draft = page.getByRole("textbox", { name: "Message", exact: true });
                        await draft.fill("");
                        await draft.focus();

                        // 2. Submitting a short prompt frames the new prompt near the top of <main> using <svg data-slate-spacer> (zero [style] attributes).
                        await draft.fill("Explain the Reading Slate scroll framing.");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.locator('[data-message-id="reply-301"]').waitFor();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        assert.equal(await page.locator("[style], [class]").count(), 0, "spacer uses native SVG height attribute with zero inline style");

                        const framedShort = await page.evaluate(() => {
                            const main = document.querySelector("#main");
                            const prompts = [...main.querySelectorAll('[data-messages] > [data-message-role="user"]')];
                            const lastPrompt = prompts.at(-1);
                            const mainRect = main.getBoundingClientRect();
                            const promptRect = lastPrompt.getBoundingClientRect();
                            const spacerHeight = Number(main.querySelector("svg[data-slate-spacer]")?.getAttribute("height") ?? "0");
                            return {
                                offsetFromMainTop: promptRect.top - mainRect.top,
                                scrollTop: main.scrollTop,
                                spacerHeight,
                            };
                        });
                        assert.ok(framedShort.offsetFromMainTop >= -2 && framedShort.offsetFromMainTop <= 36, `short prompt frames near top of <main> (offset=${framedShort.offsetFromMainTop}px)`);
                        assert.ok(framedShort.spacerHeight > 50, `spacer reserves breathing room below short reply (spacer=${framedShort.spacerHeight}px)`);

                        // 3. Streaming a long multi-screen response shrinks spacer to 0 WITHOUT chasing scrollHeight, and reveals the ↓ Jump to latest button!
                        fixture.push({
                            sessionUpdate: "agent_message_chunk",
                            messageId: "reply-301",
                            content: { type: "text", text: `\n\n${"Long streaming paragraph that extends well past the viewport fold.\n\n".repeat(35)}` },
                            _meta: { plurnk: { id: 401, coordinate: "2/301/2", loopId: 2, loopSeq: 2 } },
                        });
                        await page.waitForFunction(() => document.querySelector("[data-jump-bottom]")?.hasAttribute("hidden") === false);
                        const afterLongStream = await metrics();
                        assert.ok(Math.abs(afterLongStream.scrollTop - framedShort.scrollTop) <= 4, `streaming never chases scrollHeight (before=${framedShort.scrollTop}, after=${afterLongStream.scrollTop})`);
                        assert.equal(afterLongStream.spacerHeight, 0, "spacer shrinks to 0 once real response fills viewport");
                        assert.equal(await jumpBtn.isVisible(), true);
                        assert.equal(await jumpBtn.getAttribute("aria-label"), "Jump to latest");
                        assert.equal(await jumpBtn.getAttribute("data-jump-gate"), null);

                        // 3b. Manual downward scroll through and to the bottom of generated output hides [data-jump-bottom] and never jerks scrollTop back up across MutationObserver frames or composer typing (#147).
                        await page.evaluate(() => {
                            const main = document.querySelector("#main");
                            main.scrollTop += 250;
                        });
                        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
                        await page.evaluate(() => {
                            const main = document.querySelector("#main");
                            main.scrollTop = main.scrollHeight - main.clientHeight;
                        });
                        await page.waitForFunction(() => document.querySelector("[data-jump-bottom]")?.hasAttribute("hidden") === true);
                        await draft.fill("Follow-up note");
                        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                        const atBottom = await metrics();
                        assert.ok(atBottom.gap <= 24, `manual scroll to bottom stays at bottom without snapping back up (gap=${atBottom.gap}, scrollTop=${atBottom.scrollTop})`);
                        assert.equal(await jumpBtn.isVisible(), false);
                        await draft.fill("");

                        // Scroll back up to the framed turn top so step 4 exercises the below-fold review gate indicator.
                        await page.evaluate((top) => {
                            document.querySelector("#main").scrollTop = top;
                        }, framedShort.scrollTop);
                        await page.waitForFunction(() => document.querySelector("[data-jump-bottom]")?.hasAttribute("hidden") === false);

                        // 4. When a permission review gate opens below the fold, the floating button escalates to pending-review state, and clicking it jumps to the review!
                        fixture.pushFrame(permissionFrame("gate-tail-1", {
                            logEntryId: 20,
                            sessionId: 9,
                            session: "session1",
                            loopId: 2,
                            turnId: 9,
                            coordinate: "2/301/3",
                            op: "sh",
                            target: { scheme: "file", authority: null, pathname: "tail.txt" },
                            body: "ls -la\n".repeat(4),
                            attrs: {},
                            owner: "acp://operator/sessions/session1",
                            disposition: { decision: "review" },
                            expiresAt: "2030-01-01T00:00:00Z",
                        }));
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
                        await page.waitForFunction(() => document.querySelector("[data-jump-bottom]")?.getAttribute("data-jump-gate") === "true");
                        assert.equal(await jumpBtn.getAttribute("aria-label"), "Jump to pending review");

                        await jumpBtn.click();
                        await page.waitForFunction(() => document.querySelector("[data-jump-bottom]")?.hasAttribute("hidden") === true);
                        assert.ok((await metrics()).gap <= 24, "clicking jump button lands cleanly at the bottom review gate");

                        await page.getByRole("radio", { name: "Accept", exact: true }).check();
                        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");

                        // 5. Tall prompt (>35% of clientHeight) frames the bottom ~30% tail of the prompt + the top of the incoming reply.
                        const tallPromptText = Array.from({ length: 24 }, (_, idx) => `Tall prompt line ${idx + 1}: context specification details.`).join("\n");
                        await draft.fill(tallPromptText);
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.locator('[data-message-id="reply-302"]').waitFor();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        const framedTall = await page.evaluate(() => {
                            const main = document.querySelector("#main");
                            const prompts = [...main.querySelectorAll('[data-messages] > [data-message-role="user"]')];
                            const lastPrompt = prompts.at(-1);
                            const reply = main.querySelector('[data-message-id="reply-302"]');
                            const mainRect = main.getBoundingClientRect();
                            const promptRect = lastPrompt.getBoundingClientRect();
                            const replyRect = reply.getBoundingClientRect();
                            return {
                                promptTopRel: promptRect.top - mainRect.top,
                                promptBottomRel: promptRect.bottom - mainRect.top,
                                replyTopRel: replyRect.top - mainRect.top,
                                clientHeight: main.clientHeight,
                            };
                        });
                        assert.ok(framedTall.promptTopRel < 0, "tall prompt scrolls its upper body above the top fold");
                        assert.ok(framedTall.promptBottomRel > 20 && framedTall.promptBottomRel < framedTall.clientHeight * 0.55, "tall prompt keeps its bottom tail visible");
                        assert.ok(framedTall.replyTopRel > 0 && framedTall.replyTopRel < framedTall.clientHeight * 0.75, "incoming reply top is immediately visible below tall prompt tail");

                        // 6. Scroll to top and click Load earlier messages: prepending older messages preserves reading position away from bottom.
                        await page.locator("#main").evaluate((main) => {
                            main.scrollTop = 0;
                            main.dispatchEvent(new Event("scroll"));
                        });
                        await page.getByRole("button", { name: "Load earlier messages" }).click();
                        await page.locator('[data-message-id="older-0"]').waitFor();
                        assert.ok((await metrics()).gap > 400, "activating Load earlier messages keeps reader away from bottom");

                        // 7. Client /help command navigates directly to /settings/help without waterfall injection into #main.
                        await draft.fill("/help");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.waitForURL((url) => new URL(url).pathname === "/settings/help");
                        await page.locator('#workspace-settings [data-settings-panel="help"] dl[aria-label="Keyboard shortcuts"]').waitFor({ state: "visible" });
                    });

                    await t.test("{§web-session-input} {§web-session-approval} {§web-session-commands} prompt suggestions, @path openPaths, and ? forced review with e proposal editing", async () => {
                        const promptParams = [];
                        const gateResolutions = [];
                        let currentMode = "review";
                        const modeConfigOptions = () => [
                            {
                                configId: "mode",
                                name: "Approval Policy",
                                type: "select",
                                currentValue: currentMode,
                                options: [
                                    { value: "review", name: "Review" },
                                    { value: "accept", name: "Accept" },
                                    { value: "reject", name: "Reject" },
                                ],
                            },
                        ];

                        fixture.onAcp((input) => {
                            if (input.method === undefined) {
                                gateResolutions.push(input);
                                setTimeout(() => {
                                    fixture.push({
                                        sessionUpdate: "state_update",
                                        state: "idle",
                                        stopReason: "end_turn",
                                        _meta: {
                                            plurnk: {
                                                ...sessionMeta("completed"),
                                                terminal: { status: 200 },
                                            },
                                        },
                                    });
                                }, 15);
                                return {};
                            }
                            if (input.method === "session/resume") {
                                const meta = sessionMeta("idle");
                                meta.workspace = { ...meta.workspace, projectRoot: "/srv/project", projectLabel: "conversation" };
                                return {
                                    updates: [],
                                    result: {
                                        configOptions: modeConfigOptions(),
                                        availableCommands: [],
                                        _meta: { plurnk: meta },
                                    },
                                };
                            }
                            if (input.method === "session/set_config_option" && input.params.configId === "mode") {
                                currentMode = input.params.value;
                                return {
                                    result: {
                                        configOptions: modeConfigOptions(),
                                    },
                                };
                            }
                            if (input.method === "session/prompt") {
                                promptParams.push(input.params);
                                setTimeout(() => {
                                    fixture.pushFrame(permissionFrame("gate-edit-1", {
                                        logEntryId: 99,
                                        sessionId: 9,
                                        session: "session1",
                                        loopId: 2,
                                        turnId: 1,
                                        coordinate: "2/1/2",
                                        op: "sh",
                                        target: { scheme: "file", authority: null, pathname: "src/app.js" },
                                        body: "echo initial\n",
                                        attrs: {},
                                        owner: "acp://operator/sessions/session1",
                                        disposition: { decision: "review" },
                                        expiresAt: "2030-01-01T00:00:00Z",
                                    }));
                                }, 15);
                                return new Promise(() => {});
                            }
                            return { result: {} };
                        });

                        await page.goto(fixture.url);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        const draft = page.getByRole("textbox", { name: "Message", exact: true });

                        // 1. Prompt suggestions project chips and Tab-complete into an empty composer.
                        fixture.push({
                            sessionUpdate: "prompt_suggestions_update",
                            suggestions: [{ prompt: [{ type: "text", text: "? Inspect @src/app.js carefully" }] }],
                        });
                        await page.locator("[data-accept-suggestion]").waitFor({ state: "visible" });
                        assert.match(await draft.getAttribute("placeholder"), /Inspect @src\/app\.js carefully \(Tab\)/u);
                        await draft.focus();
                        await draft.press("Tab");
                        assert.equal(await draft.inputValue(), "? Inspect @src/app.js carefully");

                        // 2. Enable session accept mode via Shift+Tab, submit '? Inspect @src/app.js carefully', verify proposalPolicy: "review" + openPaths + 'e' shortcut + Ctrl+Enter submit.
                        await draft.press("Shift+Tab");
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "accept");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
                        const mainPrompt = promptParams.find((p) => p.sessionId === "7#session1");
                        assert.ok(mainPrompt);
                        assert.equal(mainPrompt.prompt[0].text, "Inspect @src/app.js carefully");
                        assert.deepEqual(mainPrompt._meta?.plurnk?.openPaths, ["src/app.js"]);
                        assert.equal(mainPrompt._meta?.plurnk?.proposalPolicy, "review");

                        // Ensure focus is outside text-entry controls, then press 'e' to select Edit and focus [data-proposal-edit-body].
                        await page.locator("body > header > a").focus();
                        await page.keyboard.press("e");
                        const editTextarea = page.locator("[data-proposal-edit-body]");
                        await editTextarea.waitFor({ state: "visible" });
                        assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-proposal-edit-body")), true);
                        await editTextarea.fill("echo edited-via-shortcut\n");
                        await editTextarea.press("Control+Enter");
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        assert.equal(gateResolutions.at(-1)?.result?._meta?.plurnk?.body, "echo edited-via-shortcut\n");
                    });

                    await t.test("{§web-workspace-settings} {§web-session-commands} top bar and mobile model links navigate directly to /settings/models to update active session effort", async () => {
                        /** @type {Array<{ configId: string, value: string }>} */
                        const configWrites = [];
                        let currentEffort = "high";
                        const modelOptions = () => [
                            {
                                configId: "model",
                                name: "Model",
                                type: "select",
                                currentValue: "browser",
                                options: [{ value: "browser", name: "browser — fixture/browser" }],
                            },
                            {
                                configId: "thought_level",
                                name: "Reasoning Effort",
                                type: "select",
                                currentValue: currentEffort,
                                options: [
                                    { value: "low", name: "low" },
                                    { value: "high", name: "high" },
                                ],
                            },
                        ];
                        fixture.onAcp(async (input) => {
                            if (input.method === "session/resume") {
                                const meta = sessionMeta("idle");
                                return {
                                    updates: [],
                                    result: {
                                        configOptions: modelOptions(),
                                        availableCommands: [],
                                        _meta: {
                                            plurnk: {
                                                ...meta,
                                                status: {
                                                    ...meta.status,
                                                    model: { alias: "browser", provider: "fixture", model: "browser", effort: currentEffort, effortSource: "default" },
                                                },
                                            },
                                        },
                                    },
                                };
                            }
                            if (input.method === "providers/list") {
                                return {
                                    result: {
                                        providers: [{
                                            providerId: "browser",
                                            supported: ["fixture"],
                                            required: false,
                                            _meta: { plurnk: { alias: "browser", provider: "fixture", model: "browser", effort: "high", effortSource: "default", active: true } },
                                        }],
                                    },
                                };
                            }
                            if (input.method === "_plurnk/action" && input.params?.kind === "models.list") {
                                return { result: { items: [], offset: 0, total: 0, providers: ["fixture"] } };
                            }
                            if (input.method === "session/options") {
                                return {
                                    result: {
                                        configOptions: modelOptions(),
                                        availableCommands: [],
                                        _meta: {
                                            plurnk: {
                                                status: { model: { alias: "browser", provider: "fixture", model: "browser", effort: currentEffort, effortSource: "default" } },
                                            },
                                        },
                                    },
                                };
                            }
                            if (input.method === "session/set_config_option") {
                                configWrites.push({ configId: String(input.params.configId), value: String(input.params.value) });
                                if (input.params.configId === "thought_level") currentEffort = String(input.params.value);
                                return {
                                    result: {
                                        configOptions: modelOptions(),
                                        _meta: {
                                            plurnk: {
                                                status: { model: { alias: "browser", provider: "fixture", model: "browser", effort: currentEffort, effortSource: "explicit" } },
                                            },
                                        },
                                    },
                                };
                            }
                            return { result: {} };
                        });

                        await page.goto(fixture.url);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        await page.setViewportSize({ width: 1280, height: 700 });
                        assert.equal(await page.locator("#header-model").isVisible(), true);
                        assert.equal(await page.locator("#header-model").getAttribute("href"), "/settings/models?workspace=conversation&session=session1");
                        await page.setViewportSize({ width: 390, height: 600 });
                        assert.equal(await page.locator("#header-model").isVisible(), false);
                        await page.locator("#session-model").click();
                        await page.waitForURL((url) => new URL(url).pathname === "/settings/models");
                        const modelsForm = page.locator('#workspace-settings [data-settings-panel="models"] form[data-models-session-form]');
                        await modelsForm.waitFor({ state: "visible" });
                        const effortSelect = modelsForm.getByRole("combobox", { name: "Reasoning effort", exact: true });
                        assert.equal(await effortSelect.inputValue(), "high");

                        await effortSelect.selectOption("low");
                        assert.equal(await effortSelect.inputValue(), "low");
                        await modelsForm.getByRole("button", { name: "Apply", exact: true }).click();
                        await page.waitForFunction(() => (document.querySelector('#workspace-settings > [data-text="ws-settings-message"]')?.textContent ?? "").includes("Effort: low"));
                        assert.deepEqual(configWrites, [{ configId: "thought_level", value: "low" }]);
                    });

                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
