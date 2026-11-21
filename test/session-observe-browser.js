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

                    await t.test("{§web-session-input} {§web-session-status} {§web-session-approval} Shift+Tab toggles YOLO in composer and settles pending proposals", async () => {
                        const gateResponses = [];
                        fixture.onAcp((input) => {
                            if (input.method === undefined) {
                                assert.equal(input.error, undefined);
                                gateResponses.push(input);
                                setTimeout(() => {
                                    fixture.push({
                                        sessionUpdate: "state_update",
                                        state: "running",
                                        _meta: { plurnk: sessionMeta("running") },
                                    });
                                }, 20);
                                return {};
                            }
                            if (input.method === "session/resume") {
                                return {
                                    updates: [],
                                    result: {
                                        configOptions: [],
                                        availableCommands: [],
                                        _meta: { plurnk: sessionMeta("idle") },
                                    },
                                };
                            }
                            return { result: {} };
                        });
                        await page.goto(fixture.url);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        const draft = page.getByRole("textbox", { name: "Message", exact: true });
                        const approval = page.getByRole("button", { name: "Automatic approval", exact: true });
                        const statusLine = page.locator("#session-status > [data-status-line]");

                        assert.equal(await statusLine.isVisible(), true, "connected session keeps steady status row visible without focus jump");
                        await draft.focus();
                        await draft.fill("Draft stays intact.");
                        assert.equal(await statusLine.isVisible(), true);
                        assert.equal(await approval.getAttribute("aria-pressed"), "false");

                        for (const lifecycle of ["idle", "running", "completed"]) {
                            fixture.push({
                                sessionUpdate: "state_update",
                                state: lifecycle === "running" ? "running" : "idle",
                                _meta: { plurnk: sessionMeta(lifecycle) },
                            });
                            await page.waitForFunction((expected) => document.querySelector("#session-status")?.dataset.lifecycle === expected, lifecycle);
                            await draft.focus();
                            const before = await approval.getAttribute("aria-pressed");
                            await draft.press("Shift+Tab");
                            const expected = before === "true" ? "false" : "true";
                            assert.equal(await approval.getAttribute("aria-pressed"), expected, `${lifecycle}: Shift+Tab in composer toggles auto-approval`);
                            assert.equal(await approval.locator('[data-text="yolo-label"]').textContent(), expected === "true" ? "Auto-approve" : "Review");
                            assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", `${lifecycle}: composer keeps focus`);
                            assert.equal(await draft.inputValue(), "Draft stays intact.");
                        }

                        // Ended on completed with aria-pressed === "true" (idle->true, running->false, completed->true).
                        assert.equal(await approval.getAttribute("aria-pressed"), "true");
                        await draft.press("Escape");
                        assert.notEqual(await page.evaluate(() => document.activeElement?.id), "session-message", "Escape leaves the composer cleanly");
                        assert.equal(await draft.inputValue(), "Draft stays intact.", "Escape preserves unsent draft");
                        assert.equal(await statusLine.isVisible(), true);

                        // Outside the composer when not interrupted, Shift+Tab preserves native backward focus traversal without toggling YOLO.
                        const effort = page.getByRole("button", { name: "Effort", exact: true });
                        await effort.focus();
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-effort");
                        await page.keyboard.press("Shift+Tab");
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-model", "Shift+Tab outside composer moves focus backward");
                        assert.equal(await approval.getAttribute("aria-pressed"), "true", "backward focus navigation does not toggle YOLO");

                        // Toggle Auto-approve off from composer and verify steady status bar stays visible without shifting.
                        await draft.focus();
                        await draft.press("Shift+Tab");
                        assert.equal(await approval.getAttribute("aria-pressed"), "false");
                        await page.locator("body > header > a").focus();
                        assert.equal(await statusLine.isVisible(), true, "steady status bar causes zero focus/blur layout shift");

                        // When interrupted with a pending session/request_permission proposal, Shift+Tab anywhere auto-approves it.
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
                        await page.waitForFunction(() => document.querySelector("#session-yolo")?.getAttribute("aria-pressed") === "true");
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        assert.equal(gateResponses.length, 1);
                        assert.equal(gateResponses[0].id, "gate-yolo-1");
                        assert.deepEqual(gateResponses[0].result, {
                            outcome: { outcome: "selected", optionId: "allow_once" },
                            _meta: { plurnk: { outcome: "client_yolo" } },
                        });
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

                        // 7. Client /help command reveals #session-command-results at the bottom.
                        await draft.fill("/help");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.locator("#session-command-results > ul > li").waitFor();
                        assert.ok((await metrics()).gap <= 24, "client command presentation jumps to show command output");
                    });

                    await t.test("{§web-onboarding} {§web-session-input} {§web-session-approval} {§web-session-commands} onboarding setup, prompt suggestions, @path openPaths, and ? forced review with e proposal editing", async () => {
                        const recordedSetCalls = [];
                        const deletedSessions = [];
                        const promptParams = [];
                        const gateResolutions = [];
                        let activeModel = null;

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
                                meta.status = { ...meta.status, model: activeModel };
                                return {
                                    updates: [],
                                    result: {
                                        configOptions: [],
                                        availableCommands: [],
                                        _meta: { plurnk: meta },
                                    },
                                };
                            }
                            if (input.method === "session/new") {
                                return { result: { sessionId: "7#onboard-verify-1", configOptions: [] } };
                            }
                            if (input.method === "session/delete") {
                                deletedSessions.push(input.params.sessionId);
                                return { result: {} };
                            }
                            if (input.method === "session/set_config_option") {
                                if (input.params.configId === "model") {
                                    activeModel = { alias: input.params.value, provider: "deepseek", model: "deepseek-chat" };
                                }
                                return {
                                    result: {
                                        configOptions: [],
                                        _meta: { plurnk: { status: { model: activeModel } } },
                                    },
                                };
                            }
                            if (input.method === "_plurnk/action") {
                                const { kind, params } = input.params;
                                if (kind === "models.local") {
                                    return {
                                        result: {
                                            candidates: [
                                                {
                                                    runtime: "ollama",
                                                    id: "qwen3:8b",
                                                    label: "Ollama · qwen3:8b",
                                                    alias: "ollama_qwen3",
                                                    selector: "ollama/qwen3:8b",
                                                    baseUrl: "http://127.0.0.1:11434/v1",
                                                },
                                            ],
                                        },
                                    };
                                }
                                if (kind === "service.env.list") {
                                    return {
                                        result: {
                                            configFile: "/home/test/.config/plurnk/.env",
                                            entries: [
                                                { key: "DEEPSEEK_API_KEY", secret: true, configured: false, value: null, overriddenBy: null },
                                            ],
                                        },
                                    };
                                }
                                if (kind === "models.list") {
                                    return {
                                        result: {
                                            total: 1,
                                            offset: 0,
                                            items: [
                                                { selector: "deepseek/deepseek-chat", provider: "deepseek", modelName: "DeepSeek Chat" },
                                            ],
                                        },
                                    };
                                }
                                if (kind === "service.env.set") {
                                    recordedSetCalls.push(params.updates);
                                    return {
                                        result: {
                                            configFile: "/home/test/.config/plurnk/.env",
                                            generation: 2,
                                            entries: [],
                                            shadowed: [{ key: "PLURNK_MODEL", overriddenBy: "process environment" }],
                                        },
                                    };
                                }
                            }
                            if (input.method === "session/prompt") {
                                promptParams.push(input.params);
                                if (input.params.sessionId === "7#onboard-verify-1") {
                                    return {
                                        updates: [
                                            {
                                                sessionUpdate: "agent_message_chunk",
                                                messageId: "verify-reply",
                                                content: { type: "text", text: "OK" },
                                                _meta: { plurnk: { id: 1, coordinate: "1/1/2", loopId: 1, loopSeq: 1 } },
                                            },
                                            {
                                                sessionUpdate: "state_update",
                                                state: "idle",
                                                stopReason: "end_turn",
                                                _meta: { plurnk: { ...sessionMeta("completed"), terminal: { status: 200 } } },
                                            },
                                        ],
                                        result: { messageId: input.params.messageId ?? "verify-1", stopReason: "end_turn" },
                                    };
                                }
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

                        // 1. Open onboarding via /onboard, verify local + hosted discovery, write-only secret clearing, 1-turn verification, and shadowed warning.
                        await draft.fill("/onboard");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        const dialog = page.locator("#dialog-onboarding");
                        await dialog.waitFor({ state: "visible" });
                        await page.waitForFunction(() => document.querySelector("#dialog-onboarding article")?.getAttribute("aria-busy") !== "true");
                        const sourceSelect = dialog.getByRole("combobox", { name: "Model source", exact: true });
                        assert.match(await sourceSelect.locator("option").first().textContent(), /Ollama · qwen3:8b/u);
                        await sourceSelect.selectOption("hosted:deepseek");
                        const apiKeyInput = dialog.getByLabel("Provider API key", { exact: true });
                        await apiKeyInput.fill("sk-deepseek-secret-token");
                        await dialog.getByRole("button", { name: "Save and verify", exact: true }).click();
                        await page.waitForFunction(() =>
                            document.querySelector('#dialog-onboarding [data-text="onboarding-shadowed"]')?.textContent?.includes("PLURNK_MODEL is overridden by process environment"),
                        );
                        assert.equal(await apiKeyInput.inputValue(), "", "secret input clears immediately after submission");
                        assert.doesNotMatch(await dialog.innerHTML(), /sk-deepseek-secret-token/u, "secret never enters DOM attributes or text");
                        assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0, "onboarding stores zero secrets in Web Storage");
                        assert.deepEqual(recordedSetCalls, [{
                            DEEPSEEK_API_KEY: "sk-deepseek-secret-token",
                            PLURNK_MODEL_deepseek: "deepseek/deepseek-chat",
                            PLURNK_MODEL: "deepseek",
                        }]);
                        assert.deepEqual(deletedSessions, ["7#onboard-verify-1"], "temporary verification session is deleted");
                        await dialog.locator("header [data-dialog-close]").click();
                        await dialog.waitFor({ state: "hidden" });

                        // 2. Prompt suggestions project chips and Tab-complete into an empty composer.
                        fixture.push({
                            sessionUpdate: "prompt_suggestions_update",
                            suggestions: [{ prompt: [{ type: "text", text: "? Inspect @src/app.js carefully" }] }],
                        });
                        await page.locator("[data-accept-suggestion]").waitFor({ state: "visible" });
                        assert.match(await draft.getAttribute("placeholder"), /Inspect @src\/app\.js carefully \(Tab\)/u);
                        await draft.focus();
                        await draft.press("Tab");
                        assert.equal(await draft.inputValue(), "? Inspect @src/app.js carefully");

                        // 3. Enable YOLO, submit '? Inspect @src/app.js carefully', verify openPaths + forced manual review + 'e' shortcut + Ctrl+Enter submit.
                        await draft.press("Shift+Tab");
                        assert.equal(await page.getByRole("button", { name: "Automatic approval", exact: true }).getAttribute("aria-pressed"), "true");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
                        const mainPrompt = promptParams.find((p) => p.sessionId === "7#session1");
                        assert.ok(mainPrompt);
                        assert.equal(mainPrompt.prompt[0].text, "Inspect @src/app.js carefully");
                        assert.deepEqual(mainPrompt._meta?.plurnk?.openPaths, ["src/app.js"]);

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

                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
