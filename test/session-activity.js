import assert from "node:assert/strict";
import { inputPage } from "./session-input.js";
import { outsideText } from "./model-fixture.js";

// {§web-session-activity} Shipped controls and real daemon projection, with a deterministic local model.
export default async function verifySessionActivity({ t, withDaemon }) {
    await t.test("{§web-session-activity} ambient evidence and outside text remain inspectable without becoming messages", () =>
        inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
            const uploads = [];
            page.on("request", (request) => {
                const body = request.postDataJSON();
                if (
                    new URL(request.url()).pathname === "/acp"
                    && body?.method !== "initialize"
                    && body?.params?._meta?.plurnk?.control !== false
                ) {
                    uploads.push(body);
                }
            });
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: activity.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed activity.", { exact: true }).waitFor();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            const activity = page.locator("#session-activity");
            const rows = activity.locator(":scope > ul > li");
            const outside = activity.locator(':scope > ul > li[data-activity-kind="outside"]');
            assert.equal(await outside.count(), 1, "live outside-operation text is not dropped");
            await activity.locator(":scope > summary").click();
            assert.equal(await outside.locator("article > details > pre").textContent(), outsideText);
            assert.equal(await outside.getAttribute("data-activity-text"), null);
            assert.equal(await page.locator("[data-messages]").getByText(outsideText, { exact: true }).count(), 0);
            assert.ok(await rows.count() > 1, "daemon-owned ambient rows are also visible");
            const receipt = rows.filter({ has: page.locator("article > header") }).first();
            assert.ok(Number(await receipt.getAttribute("data-plurnk-session")) > 0);
            assert.match(await receipt.getAttribute("data-plurnk-coordinate"), /^\d+\/\d+\/\d+$/u);
            assert.equal(await receipt.locator("details, dl").count(), 0);
            assert.equal(await receipt.locator("article > [data-body-reference]").count(), 0, "a summary does not fetch receipt content");
            assert.equal(await receipt.locator("article > header").count(), 1);
            assert.equal(model.requests.length, 2, "observation does not initiate inference");
            const keys = await rows.evaluateAll((items) => items.map(({ dataset: d }) =>
                JSON.stringify([d.activityKind, d.plurnkRow, d.plurnkSession, d.plurnkCoordinate, d.subagentRunId])));
            assert.equal(new Set(keys).size, keys.length, "automatic delivery handoff duplicates no activity");

            const fresh = await context.newPage();
            await fresh.goto(path);
            await fresh.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            assert.equal(await fresh.locator('#session-activity [data-activity-kind="outside"]').count(), 0,
                "a fresh page does not reconstruct unprovided outside text from history");
            await fresh.close();
            assert.equal(await outside.count(), 1, "another attachment does not remove this page's observation");
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: activity-followup.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed activity-followup.", { exact: true }).waitFor();
            assert.equal(model.requests.length, 3);
            assert.ok(uploads.length >= 2);
            for (const input of uploads) {
                assert.doesNotMatch(JSON.stringify(input.params.prompt), /Outside evidence, not the final answer/u);
                assert.notEqual(input.method, "_plurnk/action", "activity inspection uses HTTP body references, not work actions");
            }
            assert.equal(await activity.getAttribute("open"), "");
            assert.equal(await outside.count(), 1);
            assert.equal(await outside.getByRole("article", { name: "Outside operations", exact: true }).count(), 1);
            checkBrowser();
        }, { authenticated: true }));
}
