import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputPage } from "./worker-input.js";
import startTerminal from "./terminal-fixture.js";

// {§web-worker-approval} All four modes share one owner and one real daemon operation.
export default async function verifySharedReview({ t, withDaemon, consumer }) {
    for (const browserYolo of [false, true]) {
        for (const terminalYolo of [false, true]) {
            const answers = browserYolo || terminalYolo ? ["automatic"] : ["browser", "terminal"];
            for (const answer of answers) {
                const mode = (yolo) => yolo ? "YOLO" : "manual";
                await t.test(`{§web-worker-approval} shared terminal/browser ${mode(terminalYolo)}/${mode(browserYolo)} with ${answer} settlement`, { timeout: 25_000 }, async (journey) => {
                    const directory = await mkdtemp(join(tmpdir(), "plurnk-shared-execution-"));
                    journey.after(() => rm(directory, { recursive: true, force: true }));
                    const witness = join(directory, "executions.txt");
                    const quoted = `'${witness.replaceAll("'", "'\\''")}'`;
                    await inputPage(withDaemon, async ({ page, model, checkBrowser, base, workspace, secret }) => {
                        const terminal = await startTerminal({ consumer, base, workspace, secret, yolo: terminalYolo });
                        const name = `held-approval-shared-${mode(terminalYolo).toLowerCase()}-${mode(browserYolo).toLowerCase()}-${answer}`;
                        try {
                            await terminal.waitFor(new RegExp(`workspace: ${RegExp.escape(workspace)}`, "u"));
                            await page.getByRole("textbox", { name: "Message", exact: true }).fill(`Lifecycle fixture: ${name}.`);
                            await page.getByRole("button", { name: "Send", exact: true }).click();
                            await Promise.all([
                                terminal.waitFor(new RegExp(RegExp.escape(`Considering ${name}.`), "u")),
                                page.getByText(`Considering ${name}.`, { exact: true }).waitFor({ state: "attached", timeout: 5000 }),
                            ]);
                            assert.equal(model.requests.length, 1, "both real clients observe the same held inference");
                            model.release(name);
                            const review = page.getByRole("form", { name: "Review requests", exact: true });
                            if (answer !== "automatic") {
                                await review.waitFor({ timeout: 5000 });
                                await terminal.waitForScreen((text) => /Enter: confirm/u.test(text));
                                assert.equal(model.requests.length, 1, "manual clients do not settle a gate before an answer");
                                if (answer === "browser") {
                                    await review.getByRole("radio", { name: "Accept", exact: true }).check();
                                    await review.getByRole("button", { name: "Submit responses", exact: true }).click();
                                } else terminal.write("\r");
                            }
                            const observed = await Promise.allSettled([
                                terminal.waitFor(new RegExp(RegExp.escape(`Completed ${name}.`), "u")),
                                page.getByText(`Completed ${name}.`, { exact: true }).waitFor({ timeout: 5000 }),
                            ]);
                            const failures = observed.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
                            assert.equal(await readFile(witness, "utf8"), "approved\n", "the operation's filesystem witness records exactly one execution");
                            assert.equal(model.requests.length, 2, "one executor operation causes one continuation, not one per view");
                            journey.diagnostic(JSON.stringify({
                                executions: 1,
                                modelCalls: model.requests.length,
                                terminal: observed[0].status,
                                browser: observed[1].status,
                                browserConnection: await page.locator("#worker-status").getAttribute("data-connection"),
                            }));
                            if (failures.length) throw new AggregateError(failures, "Every attached view must observe the settled work without another answer or Reconnect");
                            assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"), "the accepted executor actually ran");
                            assert.equal(await review.isVisible(), false, "the browser withdraws its old form");
                            await terminal.waitForScreen((text) => !/Enter: confirm|pending reviews?/u.test(text));
                            assert.doesNotMatch(terminal.output(), /unknown interrupt presentation|❌/u);
                            assert.equal(await page.locator('[data-text="command-error"]').textContent(), "");
                            assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
                            checkBrowser();
                        } catch (cause) {
                            throw new Error(`Shared client journey failed. Terminal tail:\n${terminal.output().slice(-4000)}`, { cause });
                        } finally { await terminal.close(); }
                    }, {
                        authenticated: true,
                        env: { PLURNK_WEB_YOLO: browserYolo ? "1" : "0" },
                        modelOptions: { approvalCommand: `printf 'approved\\n' >> ${quoted}; printf approved` },
                    });
                });
            }
        }
    }
}
