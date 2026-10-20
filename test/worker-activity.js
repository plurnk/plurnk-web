import assert from "node:assert/strict";
import { inputPage } from "./worker-input.js";
import { outsideText } from "./model-fixture.js";

// {§web-worker-activity} Shipped controls and real daemon projection, with a deterministic local model.
export default async function verifyWorkerActivity({ t, withDaemon }) {
    await t.test("{§web-worker-activity} ambient evidence and outside text remain inspectable without becoming messages", () =>
        inputPage(withDaemon, async ({ page, context, path, model, checkBrowser }) => {
            const uploads = [];
            page.on("request", (request) => {
                if (new URL(request.url()).pathname === "/agui") uploads.push(request.postDataJSON());
            });
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: activity.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed activity.", { exact: true }).waitFor();
            await page.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
            const activity = page.locator("#worker-activity");
            const rows = activity.locator(":scope > ol > li");
            const outside = rows.filter({ has: page.locator('[data-text="activity-text"]') });
            assert.equal(await outside.count(), 1, "live outside-operation text is not dropped");
            await activity.locator(":scope > summary").click();
            await outside.locator(":scope > details > summary").click();
            assert.equal(await outside.locator("[data-text=activity-text]").textContent(), outsideText);
            assert.ok(Number(await outside.locator("[data-text=activity-tokens]").textContent()) > 0);
            assert.equal(await page.locator("[data-messages]").getByText(outsideText, { exact: true }).count(), 0);
            assert.ok(await rows.count() > 1, "daemon-owned ambient rows are also visible");
            const receipt = rows.filter({ has: page.locator("[data-activity-body] [data-body-reference]") }).first();
            await receipt.locator(":scope > details > summary").click();
            const evidence = JSON.parse(await receipt.locator("[data-text=activity-evidence]").textContent());
            assert.equal(await receipt.locator("[data-text=activity-worker]").textContent(), String(evidence.worker_id));
            const reference = receipt.locator("[data-activity-body] [data-body-reference]");
            await reference.getByRole("button", { name: "Read body", exact: true }).click();
            await reference.locator("[data-body-content]").waitFor();
            assert.ok((await reference.locator("[data-text=body-content]").textContent()).length > 0);
            assert.equal(model.requests.length, 2, "inspection does not initiate inference");
            const keys = await rows.evaluateAll((items) => items.map((item) => item.dataset.activityKey));
            assert.equal(new Set(keys).size, keys.length, "automatic delivery handoff duplicates no activity");

            const fresh = await context.newPage();
            await fresh.goto(path);
            await fresh.waitForFunction(() => document.querySelector("#worker-status")?.dataset.connection === "connected");
            assert.equal(await fresh.locator("#worker-activity [data-text=activity-text]").count(), 0,
                "a fresh page does not reconstruct unprovided outside text from history");
            await fresh.close();
            assert.equal(await outside.count(), 1, "another attachment does not remove this page's observation");
            await page.getByRole("textbox", { name: "Message", exact: true }).fill("Lifecycle fixture: activity-followup.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed activity-followup.", { exact: true }).waitFor();
            assert.equal(model.requests.length, 3);
            assert.ok(uploads.length >= 2);
            for (const input of uploads) {
                assert.doesNotMatch(JSON.stringify(input.messages), /Outside evidence, not the final answer/u);
                assert.ok(!input.forwardedProps?.plurnk?.action, "activity inspection uses HTTP body references, not work actions");
            }
            assert.equal(await activity.getAttribute("open"), "");
            assert.equal(await outside.count(), 1);
            assert.equal(await outside.locator(":scope > details").getAttribute("open"), "");
            checkBrowser();
        }, { authenticated: true }));
}
