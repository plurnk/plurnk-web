import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputPage } from "./session-input.js";
import startTerminal from "./terminal-fixture.js";

// {§web-session-approval} All four modes share one owner and one real daemon operation.
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
        }, { authenticated: true, env: { PLURNK_WEB_YOLO: "0" } }));
    }
    for (const browserYolo of [false, true]) {
        for (const terminalYolo of [false, true]) {
            const answers = browserYolo || terminalYolo ? ["automatic"] : ["browser", "terminal"];
            for (const answer of answers) {
                const mode = (yolo) => yolo ? "YOLO" : "manual";
                await t.test(`{§web-session-approval} shared terminal/browser ${mode(terminalYolo)}/${mode(browserYolo)} with ${answer} settlement`, { timeout: 90_000 }, async (journey) => {
                    const directory = await mkdtemp(join(tmpdir(), "plurnk-shared-execution-"));
                    journey.after(() => rm(directory, { recursive: true, force: true }));
                    const witness = join(directory, "executions.txt");
                    const quoted = `'${witness.replaceAll("'", "'\\''")}'`;
                    await inputPage(withDaemon, async ({ page, model, checkBrowser, base, workspace, secret }) => {
                        await rm(witness, { force: true });
                        const responses = [];
                        page.on("response", (response) => {
                            if (new URL(response.url()).pathname === "/acp" && response.request().postDataJSON()?.result?.outcome !== undefined) {
                                responses.push(response.text().catch(() => ""));
                            }
                        });
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
                                browserConnection: await page.locator("#session-status").getAttribute("data-connection"),
                            }));
                            if (failures.length) throw new AggregateError(failures, "Every attached view must observe the settled work without another answer or Reconnect");
                            assert.ok(JSON.stringify(model.requests[1].messages).includes("approved"), "the accepted executor actually ran");
                            assert.equal(await review.isVisible(), false, "the browser withdraws its old form");
                            await terminal.waitForScreen((text) => !/Enter: confirm|pending reviews?/u.test(text));
                            const errors = (await Promise.all(responses)).flatMap((body) => body.split("\n\n")
                                .filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6))))
                                .filter(({ error }) => error).map(({ error }) => error);
                            assert.ok(errors.length <= (browserYolo && terminalYolo ? 1 : 0), "only two automatic answers may race");
                            for (const error of errors) {
                                const problem = error.data?.plurnk?.problem;
                                assert.equal(problem?.status, 409);
                                assert.match(problem?.type, /^https:\/\/problems\.plurnk\.xyz\/(acp\/interrupt\/interrupt|proposal[:/]resolution\/proposal|interaction[:/]resolution\/interaction)-not-pending$/u);
                            }
                            const commandError = await page.locator('[data-text="command-error"]').textContent();
                            if (commandError) {
                                assert.match(commandError, /^Response not accepted:/u, "a refused answer stays visible without hiding live progress");
                            }
                            const terminalOutput = browserYolo && terminalYolo
                                ? terminal.output().replaceAll(/❌ problem:(?:Interrupt|Proposal|Interaction) not pending —/gu, "")
                                : terminal.output();
                            assert.doesNotMatch(terminalOutput, /❌/u, "no unrelated terminal failures are accepted");
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
