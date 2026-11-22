import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputPage } from "./session-input.js";
import startTerminal from "./terminal-fixture.js";

// {§web-session-approval} Terminal and browser share one durable session approval policy and one pending gate set on the daemon.
export default async function verifySharedReview({ t, withDaemon, consumer }) {
    for (const family of ["approval", "question"]) {
        const tag = family === "approval" ? "{§web-session-approval}" : "{§web-session-questions}";
        await t.test(`${tag} shared views retire ${family} when another view explicitly stops the loop`, { timeout: 60_000 }, () => inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
            page.setDefaultTimeout(5000);
            const name = `${family}-external-stop`;
            await page.getByRole("textbox", { name: "Message", exact: true }).fill(`Lifecycle fixture: ${name}.`);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Preserve this unsent draft.");
            const other = await context.newPage();
            other.setDefaultTimeout(5000);
            await other.goto(path);
            await other.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "interrupted");
            const stopping = other.waitForResponse((response) => new URL(response.url()).pathname === "/acp"
                && response.request().postDataJSON()?.method === "session/cancel");
            await other.getByRole("button", { name: "Stop", exact: true }).click();
            const cancelResponse = await stopping;
            assert.ok(cancelResponse.status() === 200 || cancelResponse.status() === 202, "Stop actually cancelled the live work");
            for (const view of [page, other]) {
                await view.waitForFunction(() => {
                    const status = document.querySelector("#session-status");
                    return status?.dataset.connection === "connected" && status.dataset.lifecycle === "cancelled";
                });
                assert.equal(await view.getByRole("form", { name: "Review requests", exact: true }).isVisible(), false);
                assert.equal(await view.locator('[data-message-role="user"]').count(), 1);
                assert.equal(await view.locator('[data-text="command-error"]').textContent(), "");
            }
            assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Preserve this unsent draft.");
            assert.equal(model.requests.length, 1, "cancellation produces no answer or further inference");
            checkBrowser();
        }, { env: { PLURNK_SERVICE_PROPOSALS: "review" } }));
    }

    for (const scenario of /** @type {const} */ ([
        { label: "manual/browser", terminalYolo: false, answer: "browser" },
        { label: "manual/terminal", terminalYolo: false, answer: "terminal" },
        { label: "manual/shift-tab-yolo", terminalYolo: false, answer: "shift-tab" },
        { label: "terminal-yolo/shared-accept", terminalYolo: true, answer: "automatic" },
    ])) {
        await t.test(`{§web-session-approval} shared terminal/browser (${scenario.label}) settles once across views without client races`, { timeout: 90_000 }, async (journey) => {
            const directory = await mkdtemp(join(tmpdir(), "plurnk-shared-execution-"));
            journey.after(() => rm(directory, { recursive: true, force: true }));
            const witness = join(directory, "executions.txt");
            const quoted = `'${witness.replaceAll("'", "'\\''")}'`;
            await inputPage(withDaemon, async ({ page, model, checkBrowser, base, workspace }) => {
                await rm(witness, { force: true });
                const wsErrors = [];
                page.on("websocket", (ws) => {
                    if (new URL(ws.url()).pathname !== "/acp") return;
                    ws.on("framereceived", ({ payload }) => {
                        for (const line of String(payload).split("\n")) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;
                            try {
                                const parsed = JSON.parse(trimmed);
                                if (parsed?.error) wsErrors.push(parsed.error);
                            } catch { /* ignore */ }
                        }
                    });
                });
                const terminal = await startTerminal({ consumer, base, workspace, yolo: scenario.terminalYolo });
                const name = `held-approval-shared-${scenario.label.replaceAll("/", "-")}`;
                try {
                    await terminal.waitFor(new RegExp(`workspace: ${RegExp.escape(workspace)}`, "u"));
                    const draft = page.getByRole("textbox", { name: "Message", exact: true });
                    await draft.fill(`Lifecycle fixture: ${name}.`);
                    await page.getByRole("button", { name: "Send", exact: true }).click();
                    await Promise.all([
                        terminal.waitFor(new RegExp(RegExp.escape(`Considering ${name}.`), "u")),
                        page.locator('[data-prompt-work][data-work-running="true"] [data-operation-tally="reasoning"]').last().waitFor({ state: "attached", timeout: 5000 }),
                    ]);
                    assert.equal(model.requests.length, 1, "both real clients observe the same held inference");
                    model.release(name);
                    const review = page.getByRole("form", { name: "Review requests", exact: true });
                    if (scenario.answer !== "automatic") {
                        await review.waitFor({ timeout: 5000 });
                        await terminal.waitForScreen((text) => /Enter: confirm/u.test(text));
                        assert.equal(model.requests.length, 1, "manual clients do not settle a gate before an answer");
                        if (scenario.answer === "browser") {
                            await review.getByRole("radio", { name: "Accept", exact: true }).check();
                            await review.getByRole("button", { name: "Submit responses", exact: true }).click();
                        } else if (scenario.answer === "terminal") {
                            terminal.write("\r");
                        } else {
                            await draft.press("Shift+Tab");
                            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.approvalMode === "accept");
                            await terminal.waitFor(/yolo: on/u);
                        }
                    }
                    const observed = await Promise.allSettled([
                        terminal.waitFor(new RegExp(RegExp.escape(`Completed ${name}.`), "u")),
                        page.getByText(`Completed ${name}.`, { exact: true }).waitFor({ timeout: 5000 }),
                    ]);
                    const failures = observed.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
                    assert.equal(await readFile(witness, "utf8"), "approved\n", "the operation's filesystem witness records exactly one execution");
                    assert.equal(model.requests.length, 2, "one executor operation causes one continuation, not one per view");
                    if (failures.length) throw new AggregateError(failures, "Every attached view must observe the settled work without another answer or Reconnect");
                    assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"), "the accepted executor actually ran");
                    assert.equal(await review.isVisible(), false, "the browser withdraws its old form");
                    await terminal.waitForScreen((text) => !/Enter: confirm|pending reviews?/u.test(text));
                    assert.deepEqual(wsErrors, [], "shared daemon-owned session approval produces zero 409 client race errors");
                    assert.equal(await page.locator('[data-text="command-error"]').textContent(), "");
                    assert.doesNotMatch(terminal.output(), /❌/u, "no terminal failures occur");
                    assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
                    checkBrowser();
                } catch (cause) {
                    throw new Error(`Shared client journey failed. Terminal tail:\n${terminal.output().slice(-4000)}`, { cause });
                } finally { await terminal.close(); }
            }, {
                env: { PLURNK_SERVICE_PROPOSALS: "review" },
                modelOptions: { approvalCommand: `printf 'approved\\n' >> ${quoted}; printf approved` },
            });
        });
    }
}
