import assert from "node:assert/strict";
import { HttpAgent } from "@ag-ui/client";
import { inputPage } from "./worker-input.js";

const connected = (page) => page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
const settled = (page, lifecycle) => page.waitForFunction((lifecycle) =>
    document.querySelector('#worker-status [data-status-field="lifecycle"]')?.getAttribute("aria-label") === lifecycle, lifecycle);
const outcomes = (page) => page.locator("[data-stream-outcomes] ul > li");

export async function inspectStreamOutput(row) {
    await row.getByRole("button", { name: "Read output", exact: true }).click();
    await row.locator('[data-output-state="loaded"]').waitFor();
    return Object.fromEntries(await row.locator("[data-output-snapshot] > ul > li").evaluateAll((channels) =>
        channels.map((row) => [row.querySelector("[data-text=output-channel]").textContent, {
            content: row.querySelector("[data-output-content]").textContent,
            state: row.querySelector("[data-text=output-channel-state]").textContent,
            length: row.querySelector("[data-text=output-length]").textContent,
        }])));
}

// {§web-worker-streams} Real sh streams and management reads through the installed browser and daemon.
export default async function verifyWorkerStreams({ t, withDaemon }) {
    for (const cancelled of [false, true]) {
        await t.test(`{§web-worker-streams} silent work has no inventory; inspect outcomes after ${cancelled ? "explicit cancellation" : "completion while away"}`, () =>
            inputPage(withDaemon, async ({ page, context, path, base, model, checkBrowser, setup, headers }) => {
                const inputs = [];
                context.on("request", (request) => {
                    if (new URL(request.url()).pathname === "/agui") inputs.push(request.postDataJSON());
                });
                assert.equal(await page.locator("[data-open-streams]").count(), 0);
                await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: wait-status.");
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await model.streamStarted;
                await settled(page, "parked");
                await connected(page);
                assert.equal(await page.locator("[data-open-streams]").count(), 0);
                assert.equal(await outcomes(page).count(), 0, "active work is not an observed conclusion");

                await page.reload();
                await connected(page);
                await settled(page, "parked");
                assert.equal(await page.locator("[data-open-streams]").count(), 0);
                const readCount = inputs.filter((input) => input.forwardedProps?.plurnk?.action?.kind === "entry.read").length;
                assert.equal(readCount, 0, "neither connection nor reload silently reads stream output");
                assert.equal(model.requests.length, 1, "reload leaves the silent work running");
                let target;
                if (cancelled) {
                    await page.getByRole("button", { name: "Stop", exact: true }).click();
                    await settled(page, "cancelled");
                    await page.waitForFunction(() => document.querySelectorAll("[data-stream-outcomes] ul > li").length === 1);
                } else {
                    const observer = await context.newPage();
                    await observer.goto(path);
                    await connected(observer);
                    await settled(observer, "parked");
                    await page.goto(new URL("/~/", base).href);
                    assert.equal(model.requests.length, 1, "leaving the page leaves the stream running");
                    model.release("status-stream");
                    await settled(observer, "completed");
                    await observer.waitForFunction(() => document.querySelectorAll("[data-stream-outcomes] ul > li").length === 1);
                    await observer.locator("[data-stream-outcomes] > summary").click();
                    const outcome = outcomes(observer);
                    target = await outcome.getAttribute("data-stream-target");
                    await outcome.locator(":scope > details > summary").click();
                    assert.equal(await outcome.getAttribute("data-stream-exit-code"), "0");
                    assert.equal(await outcome.getAttribute("data-stream-result"), null);
                    const output = await inspectStreamOutput(outcome);
                    assert.equal(output.stdout.content, "Stream completed.\n");
                    assert.equal(output.stderr.content, "");
                    assert.equal(output.stdout.state, "closed");
                    await observer.close();
                    await page.goto(path);
                    await connected(page);
                    await settled(page, "completed");
                    assert.equal(model.requests.length, 2);
                }
                assert.equal(await page.locator("[data-open-streams]").count(), 0);
                if (cancelled) {
                    await page.locator("[data-stream-outcomes] > summary").click();
                    await outcomes(page).locator(":scope > details > summary").click();
                    assert.equal(await outcomes(page).getAttribute("data-stream-status"), "499", "cancellation preserves the stream's exact status");
                    target = await outcomes(page).getAttribute("data-stream-target");
                    const output = await inspectStreamOutput(outcomes(page));
                    assert.notEqual(output.stdout.state, "active");
                    assert.equal(model.requests.length, 1);
                }
                assert.match(target, /^sh:\/\/\/.+/u);
                const read = inputs.find((input) => input.forwardedProps?.plurnk?.action?.kind === "entry.read");
                assert.ok(read, "the outcome's native control uses the public management Run");
                assert.deepEqual(read.messages, []);
                assert.deepEqual(read.tools, []);
                assert.equal(read.threadId, `${setup.state.plurnk.workspace.id}#user`);
                assert.deepEqual(read.forwardedProps.plurnk.action, { kind: "entry.read", target });
                const inspection = new HttpAgent({ url: new URL("/agui", base).href, threadId: `${setup.state.plurnk.workspace.id}#user`, headers });
                await inspection.runAgent({ forwardedProps: { plurnk: { action: { kind: "entry.read", target } } } });
                assert.deepEqual(inspection.messages, [], "management evidence is not appended to SDK conversation");
                checkBrowser();
            }, { authenticated: cancelled }));
    }

    await t.test("{§web-worker-streams} a nonzero command result does not fail its worker", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: execution-failure.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Considering execution-failure.", { exact: true }).waitFor({ state: "attached" });
            model.release("execution-failure");
            await settled(page, "completed");
            await page.waitForFunction(() => document.querySelectorAll("[data-stream-outcomes] ul > li").length === 1);
            await page.locator("[data-stream-outcomes] > summary").click();
            await outcomes(page).locator(":scope > details > summary").click();
            assert.equal(await outcomes(page).getAttribute("data-stream-exit-code"), "7");
            assert.equal(await outcomes(page).getAttribute("data-stream-status"), "200", "the executor successfully ran a command whose answer was exit 7");
            assert.equal(await outcomes(page).locator("[data-stream-failure]").isVisible(), false, "a nonzero command answer is not a fabricated protocol Problem");
            const output = await inspectStreamOutput(outcomes(page));
            assert.equal(output.stdout.content, "execution-failure stdout\n");
            assert.equal(output.stderr.content, "execution-failure stderr\n");
            assert.equal(await page.locator("[data-open-streams]").count(), 0);
            assert.equal(model.requests.length, 2);
            checkBrowser();
        }));
}
