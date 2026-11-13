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
            sessionId: "7#user",
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

// {§web-session-input} {§web-session-status} {§web-session-approval} {§web-session-history} Real observeSession keyboard, status and sticky-tail contracts across engines.
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

                        assert.equal(await statusLine.isVisible(), false, "idle Manual Review session hides unfocused status row");
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
                            assert.equal(await approval.getAttribute("aria-pressed"), expected, `${lifecycle}: Shift+Tab in composer toggles YOLO`);
                            assert.equal(await approval.locator('[data-text="yolo-label"]').textContent(), expected === "true" ? "YOLO" : "Review");
                            assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", `${lifecycle}: composer keeps focus`);
                            assert.equal(await draft.inputValue(), "Draft stays intact.");
                        }

                        // Ended on completed with aria-pressed === "true" (idle->true, running->false, completed->true).
                        assert.equal(await approval.getAttribute("aria-pressed"), "true");
                        await draft.press("Escape");
                        assert.notEqual(await page.evaluate(() => document.activeElement?.id), "session-message", "Escape leaves the composer cleanly");
                        assert.equal(await draft.inputValue(), "Draft stays intact.", "Escape preserves unsent draft");
                        assert.equal(await statusLine.isVisible(), true, "active YOLO keeps status row visible on unfocused completed session");

                        // Outside the composer when not interrupted, Shift+Tab preserves native backward focus traversal without toggling YOLO.
                        const effort = page.getByRole("button", { name: "Effort", exact: true });
                        await effort.focus();
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-effort");
                        await page.keyboard.press("Shift+Tab");
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-model", "Shift+Tab outside composer moves focus backward");
                        assert.equal(await approval.getAttribute("aria-pressed"), "true", "backward focus navigation does not toggle YOLO");

                        // Toggle YOLO off from composer and verify unfocused completed status hides again.
                        await draft.focus();
                        await draft.press("Shift+Tab");
                        assert.equal(await approval.getAttribute("aria-pressed"), "false");
                        await page.locator("body > header > a").focus();
                        assert.equal(await statusLine.isVisible(), false, "disabling YOLO releases unfocused completed status space");

                        // When interrupted with a pending session/request_permission proposal, Shift+Tab anywhere auto-approves it.
                        fixture.pushFrame(permissionFrame("gate-yolo-1", {
                            logEntryId: 10,
                            sessionId: 9,
                            session: "user",
                            loopId: 2,
                            turnId: 1,
                            coordinate: "2/1/2",
                            op: "sh",
                            target: { scheme: "file", authority: null, pathname: "witness.txt" },
                            body: "echo ok\n",
                            attrs: {},
                            owner: "acp://operator/sessions/user",
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

                    await t.test("{§web-session-history} sticky-tail scroll anchoring pins bottom arrivals without hijacking upward reading", async () => {
                        await page.route("**/history/older-loop", (route) => route.fulfill({
                            json: {
                                session: "7#user",
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
                                const turnUpdates = [
                                    {
                                        sessionUpdate: "user_message_chunk",
                                        messageId: input.params.messageId,
                                        content: { type: "text", text: input.params.prompt[0].text },
                                        _meta: { plurnk: { id: 300, coordinate: "2/10/1", loopId: 2, loopSeq: 2, origin: "operator" } },
                                    },
                                    {
                                        sessionUpdate: "agent_message_chunk",
                                        messageId: "reply-after-submit",
                                        content: { type: "text", text: `Answered prompt.\n\n${"tail line ".repeat(20)}` },
                                        _meta: { plurnk: { id: 301, coordinate: "2/10/2", loopId: 2, loopSeq: 2 } },
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

                        const metrics = () => page.locator("#main").evaluate((main) => ({
                            scrollTop: main.scrollTop,
                            scrollHeight: main.scrollHeight,
                            clientHeight: main.clientHeight,
                            gap: main.scrollHeight - main.scrollTop - main.clientHeight,
                        }));

                        const initial = await metrics();
                        assert.ok(initial.scrollHeight > initial.clientHeight * 2, "multi-message session overflows main");
                        assert.ok(initial.gap <= 24, `initial transcript arrival lands at main's bottom edge (gap=${initial.gap})`);

                        const draft = page.getByRole("textbox", { name: "Message", exact: true });
                        await draft.fill("");
                        await draft.focus();

                        // Streaming message chunks, live reasoning preview, slash-command results, and review gates keep main pinned without moving focus.
                        fixture.push({
                            sessionUpdate: "agent_thought_chunk",
                            messageId: "live-thought-1",
                            content: { type: "text", text: "Evaluating edge cases.\n".repeat(12) },
                            _meta: { plurnk: { sessionName: "user", loopSeq: 2, turnSeq: 9 } },
                        });
                        await page.locator("[data-reasoning-preview] pre").filter({ hasText: "Evaluating edge cases." }).waitFor();
                        assert.ok((await metrics()).gap <= 24, "live reasoning preview keeps main pinned at bottom");
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", "reasoning stream never moves focus");

                        fixture.push({
                            sessionUpdate: "agent_message_chunk",
                            messageId: "stream-tail-1",
                            content: { type: "text", text: `Streaming tail paragraph.\n\n${"more words ".repeat(30)}` },
                            _meta: { plurnk: { id: 250, coordinate: "2/9/2", loopId: 2, loopSeq: 2 } },
                        });
                        await page.locator('[data-message-id="stream-tail-1"]').waitFor();
                        assert.ok((await metrics()).gap <= 24, "streaming assistant message keeps main pinned at bottom");
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "session-message", "message stream never moves focus");

                        await draft.fill("/help");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.locator("#session-command-results > ul > li").waitFor();
                        assert.ok((await metrics()).gap <= 24, "command result presentation keeps main pinned at bottom");

                        fixture.pushFrame(permissionFrame("gate-tail-1", {
                            logEntryId: 20,
                            sessionId: 9,
                            session: "user",
                            loopId: 2,
                            turnId: 9,
                            coordinate: "2/9/3",
                            op: "sh",
                            target: { scheme: "file", authority: null, pathname: "tail.txt" },
                            body: "ls -la\n".repeat(8),
                            attrs: {},
                            owner: "acp://operator/sessions/user",
                            disposition: { decision: "review" },
                            expiresAt: "2030-01-01T00:00:00Z",
                        }));
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
                        assert.ok((await metrics()).gap <= 24, "arriving review gate keeps main pinned at bottom");

                        // Settle the gate manually so connection returns to connected before testing upward reading.
                        await page.getByRole("radio", { name: "Accept", exact: true }).check();
                        await page.getByRole("button", { name: "Submit responses", exact: true }).click();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");

                        // Scroll upward to inspect earlier turns: pin releases immediately.
                        await page.locator("#main").evaluate((main) => {
                            main.scrollTop = 120;
                            main.dispatchEvent(new Event("scroll"));
                        });
                        const readingBefore = await metrics();
                        assert.ok(Math.abs(readingBefore.scrollTop - 120) < 1);
                        assert.ok(readingBefore.gap > 200);

                        fixture.push({
                            sessionUpdate: "agent_message_chunk",
                            messageId: "stream-while-unpinned",
                            content: { type: "text", text: `Tail output while reader inspects top.\n\n${"more output ".repeat(35)}` },
                            _meta: { plurnk: { id: 260, coordinate: "2/9/4", loopId: 2, loopSeq: 2 } },
                        });
                        await page.locator('[data-message-id="stream-while-unpinned"]').waitFor();
                        const readingAfterStream = await metrics();
                        assert.equal(readingAfterStream.scrollTop, readingBefore.scrollTop, "tail streaming while unpinned does not jump scrollTop");

                        // Scroll to top and click Load previous loop: prepending Loop 1 does not jump back to the bottom.
                        await page.locator("#main").evaluate((main) => {
                            main.scrollTop = 0;
                            main.dispatchEvent(new Event("scroll"));
                        });
                        await page.getByRole("button", { name: "Load previous loop" }).click();
                        await page.locator('[data-message-id="older-0"]').waitFor();
                        const afterOlder = await metrics();
                        assert.ok(afterOlder.gap > 400, "activating Load previous loop keeps reader away from bottom");

                        // Explicit prompt submission re-pins to main's bottom edge.
                        await draft.fill("Resume at the tail.");
                        await page.getByRole("button", { name: "Send", exact: true }).click();
                        await page.locator('[data-message-id="reply-after-submit"]').waitFor();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        assert.ok((await metrics()).gap <= 24, "explicit prompt submission re-pins main to its bottom edge");
                    });

                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await fixture.server.close(); }
}
