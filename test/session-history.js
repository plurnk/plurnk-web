import assert from "node:assert/strict";
import { inputPage } from "./session-input.js";

/** {§web-session-history} The installed browser on an authenticated candidate daemon, no substituted wire. */
export default async function verifySessionHistory({ t, withDaemon }) {
    await t.test("{§web-session-history} packed browser pages real loops without uploading archives or starting work", () =>
        inputPage(withDaemon, async ({ page, model, checkBrowser }) => {
            const requests = [];
            const pages = [];
            page.on("request", (request) => {
                const url = new URL(request.url());
                if (url.pathname === "/acp" && request.postDataJSON()?.method === "session/prompt") requests.push(request.postDataJSON());
                if (url.pathname.endsWith("/messages")) pages.push(request);
            });
            const field = page.getByRole("textbox", { name: "Message", exact: true });
            const send = async (name) => {
                await field.fill(`Lifecycle fixture: ${name}.`);
                await page.getByRole("button", { name: "Send", exact: true }).click();
                await page.getByText(`Completed ${name}.`, { exact: true }).waitFor();
                await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            };
            for (const name of ["history-first", "history-second", "history-third"]) await send(name);
            await page.reload();
            await page.getByText("Completed history-third.", { exact: true }).waitFor();
            assert.equal(await page.getByText("Completed history-first.", { exact: true }).count(), 0, "the daemon's default attachment holds two loops");
            assert.equal(await page.getByText("Completed history-second.", { exact: true }).count(), 1);
            assert.equal(pages.length, 0, "attachment does not preload older loops");
            await page.getByRole("button", { name: "Load previous loop" }).click();
            await page.getByText("Completed history-first.", { exact: true }).waitFor();
            assert.equal(pages.length, 1);
            assert.match(pages[0].headers().authorization, /^Bearer /u);
            assert.equal(model.requests.length, 3, "reading history initiates no inference");
            const firstId = requests[0].params.messageId;
            await send("history-fourth");
            const upload = requests.at(-1);
            assert.notEqual(upload.params.messageId, firstId, "an actual controlling Run excludes the loaded archival arrival");
            assert.ok(!upload.params.prompt.some(({ text }) => typeof text === "string" && text === "Completed history-first."));
            assert.equal(await page.getByText("Completed history-first.", { exact: true }).count(), 1, "explicitly loaded history remains in the view");
            assert.equal(pages.length, 1, "the final page is immutable and never revalidated");
            await page.reload();
            await page.getByText("Completed history-fourth.", { exact: true }).waitFor();
            assert.equal(await page.getByText("Completed history-first.", { exact: true }).count(), 0, "reload has no private transcript cache");
            assert.equal(model.requests.length, 4);
            checkBrowser();
        }, { authenticated: true }));

    await t.test("{§web-session-history} oversized pasted words remain readable through the public entry route", () =>
        inputPage(withDaemon, async ({ page, checkBrowser }) => {
            const source = `Lifecycle fixture: history-paste.\n${"Literal <p>pasted words</p>.\n".repeat(300)}`;
            const reads = [];
            page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/entry")) reads.push(request); });
            const field = page.getByRole("textbox", { name: "Message", exact: true });
            await field.fill(source);
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed history-paste.", { exact: true }).waitFor();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            await field.fill("Lifecycle fixture: history-paste-second.");
            await page.getByRole("button", { name: "Send", exact: true }).click();
            await page.getByText("Completed history-paste-second.", { exact: true }).waitFor();
            await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
            await page.reload();
            await page.getByText("Completed history-paste-second.", { exact: true }).waitFor();
            assert.equal(await page.locator("#main").evaluate((main) => main.scrollHeight - main.scrollTop - main.clientHeight <= 24), true, "initial reload lands at main's bottom edge");
            assert.equal(await page.getByText("Completed history-paste.", { exact: true }).count(), 0, "character ceiling drops the oversized earlier loop from initial window");
            await page.getByRole("button", { name: "Load previous loop" }).first().click();
            await page.getByText("Completed history-paste.", { exact: true }).waitFor();
            const user = page.locator('[data-message-role="user"]').first();
            assert.equal((await user.textContent())?.trim(), source.trim());
            assert.equal(await user.locator("p p").count(), 0, "pasted words are literal text, not inserted HTML markup");
            await page.locator("[data-operations] > details > summary").first().click();
            const reasoning = page.locator('[data-message-role="reasoning"]').first();
            await reasoning.locator("summary").click();
            await reasoning.locator("[data-body-reference]").scrollIntoViewIfNeeded();
            await reasoning.locator('[data-body-state="loaded"]').waitFor();
            assert.equal(await reasoning.locator("[data-body-reference]").textContent(), "Considering history-paste.");
            assert.ok(reads.some((request) => new URL(request.url()).searchParams.get("target")?.startsWith("reasoning://")));
            for (const request of reads) assert.match(request.headers().authorization, /^Bearer /u);
            checkBrowser();
        }, { authenticated: true, env: { PLURNK_ACP_HISTORY_PAGE_CHARS: "2000" } }));
}
