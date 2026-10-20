import assert from "node:assert/strict";
import { HttpAgent } from "@ag-ui/client";
import { inputPage } from "./worker-input.js";

const connected = (page) => page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
const settled = (page, lifecycle) => page.waitForFunction((lifecycle) =>
    document.querySelector('#worker-status [data-text="lifecycle"]')?.textContent === lifecycle, lifecycle);
const current = (page) => page.locator("#worker-streams [data-open-streams] > li");
const outcomes = (page) => page.locator("[data-stream-outcomes] ol > li");

async function openCurrent(page) {
    await page.locator("#worker-streams > details:first-child > summary").click();
    await current(page).locator(":scope > details > summary").click();
}

async function inspect(row) {
    await row.getByRole("button", { name: "Read output", exact: true }).click();
    await row.locator('[data-output-state="loaded"]').waitFor();
    return Object.fromEntries(await row.locator("[data-output-snapshot] > ul > li").evaluateAll((channels) =>
        channels.map((row) => [row.querySelector("[data-text=output-channel]").textContent, {
            content: row.querySelector("[data-text=output-content]").textContent,
            state: row.querySelector("[data-text=output-channel-state]").textContent,
            length: row.querySelector("[data-text=output-length]").textContent,
        }])));
}

// {§web-worker-streams} Real sh streams and management reads through the installed browser and daemon.
export default async function verifyWorkerStreams({ t, withDaemon }) {
    for (const cancelled of [false, true]) {
        await t.test(`{§web-worker-streams} silent stream inspection, fresh census and ${cancelled ? "explicit cancellation" : "completion while away"}`, () =>
            inputPage(withDaemon, async ({ page, context, path, base, model, checkBrowser, setup, headers }) => {
                const inputs = [];
                page.on("request", (request) => {
                    if (new URL(request.url()).pathname === "/agui") inputs.push(request.postDataJSON());
                });
                assert.equal(await current(page).count(), 0);
                await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: wait-status.");
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await model.streamStarted;
                await settled(page, "parked");
                await connected(page);
                assert.equal(await current(page).count(), 1);
                const target = await current(page).getAttribute("data-stream-target");
                assert.match(target, /^sh:\/\/\/.+/u);
                await openCurrent(page);
                const channels = await current(page).locator("[data-text=stream-channel]").allTextContents();
                assert.ok(channels.includes("stdout"));
                assert.ok(channels.includes("stderr"), "never-written stderr exists in the authoritative census");
                const silent = await inspect(current(page));
                for (const channel of ["stdout", "stderr"]) assert.deepEqual(silent[channel], { content: "", state: "active", length: "0" });
                const read = inputs.find((input) => input.forwardedProps?.plurnk?.action?.kind === "entry.read");
                assert.ok(read, "the native control uses the public management Run");
                assert.deepEqual(read.messages, []);
                assert.deepEqual(read.tools, []);
                assert.equal(read.threadId, `${setup.state.plurnk.workspace.id}#user`);
                assert.deepEqual(read.forwardedProps.plurnk.action, { kind: "entry.read", target });
                assert.equal(model.requests.length, 1, "inspection is not another inference or conversation turn");

                await page.reload();
                await connected(page);
                assert.equal(await current(page).getAttribute("data-stream-target"), target, "refresh recovers a silent stream without channel activity");
                assert.equal(await current(page).locator("[data-output-snapshot]").isVisible(), false, "reload does not silently reread output");
                await openCurrent(page);
                const readCount = inputs.filter((input) => input.forwardedProps?.plurnk?.action?.kind === "entry.read").length;
                assert.equal(readCount, 1);
                if (cancelled) {
                    await page.getByRole("button", { name: "Stop", exact: true }).click();
                    await settled(page, "cancelled");
                    await page.waitForFunction(() => document.querySelectorAll("[data-stream-outcomes] ol > li").length === 1);
                } else {
                    const observer = await context.newPage();
                    await observer.goto(path);
                    await connected(observer);
                    assert.equal(await current(observer).getAttribute("data-stream-target"), target);
                    await page.goto(new URL("/~/", base).href);
                    assert.equal(model.requests.length, 1, "leaving the page leaves the stream running");
                    model.release("status-stream");
                    await settled(observer, "completed");
                    await observer.waitForFunction(() => document.querySelectorAll("[data-stream-outcomes] ol > li").length === 1);
                    await observer.locator("[data-stream-outcomes] > summary").click();
                    const outcome = outcomes(observer);
                    await outcome.locator(":scope > details > summary").click();
                    const result = JSON.parse(await outcome.locator("[data-text=stream-result]").textContent());
                    assert.equal(result.exitCode, 0);
                    const output = await inspect(outcome);
                    assert.equal(output.stdout.content, "Stream completed.\n");
                    assert.equal(output.stderr.content, "");
                    assert.equal(output.stdout.state, "closed");
                    await observer.close();
                    await page.goto(path);
                    await connected(page);
                    assert.equal(await current(page).count(), 0, "fresh state removes work completed during absence");
                    assert.equal(model.requests.length, 2);
                }
                assert.equal(await current(page).count(), 0);
                if (cancelled) {
                    await page.locator("[data-stream-outcomes] > summary").click();
                    await outcomes(page).locator(":scope > details > summary").click();
                    const result = JSON.parse(await outcomes(page).locator("[data-text=stream-result]").textContent());
                    assert.equal(result.status, 499, "cancellation preserves the stream's exact result");
                    const output = await inspect(outcomes(page));
                    assert.notEqual(output.stdout.state, "active");
                    assert.equal(model.requests.length, 1);
                }
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
            await page.waitForFunction(() => document.querySelectorAll("[data-stream-outcomes] ol > li").length === 1);
            await page.locator("[data-stream-outcomes] > summary").click();
            await outcomes(page).locator(":scope > details > summary").click();
            const result = JSON.parse(await outcomes(page).locator("[data-text=stream-result]").textContent());
            assert.equal(result.exitCode, 7);
            assert.equal(result.status, 200, "the executor successfully ran a command whose answer was exit 7");
            assert.equal(result.problem, undefined, "a nonzero command answer is not a fabricated protocol Problem");
            const output = await inspect(outcomes(page));
            assert.equal(output.stdout.content, "execution-failure stdout\n");
            assert.equal(output.stderr.content, "execution-failure stderr\n");
            assert.equal(await current(page).count(), 0);
            assert.equal(model.requests.length, 2);
            checkBrowser();
        }));
}
