import assert from "node:assert/strict";
import { chromium, firefox } from "playwright";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

// {§web-result-bodies} Exercise the actual renderer and request path, never a second message reducer.
export default async function verifyBodies(t) {
    const { server, url } = await conversationFixture(new URL("./body-entry.js", import.meta.url), new Map([
        ["/agui/redirect", (_request, response) => {
            response.writeHead(302, { Location: "https://elsewhere.invalid/body" });
            response.end();
        }],
    ]));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async () => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext();
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const reads = [];
                    const redirects = [];
                    page.on("request", (request) => {
                        if (request.url().includes("elsewhere.invalid")) redirects.push(request.url());
                    });
                    let credentials = 0;
                    await page.route("**/auth/token", async (route) => {
                        credentials++;
                        await route.fulfill({ json: { token_type: "Bearer", access_token: "body-fixture-credential" } });
                    });
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const address = new URL("/agui/7/9/entry?target=log%3A%2F%2F%2F1%2F2%2F3%2FREAD", url).href;
                    const source = '<script>window.bodyExecuted=true</script><img src="/unasked"><form data-action="read-body">Not controls</form>';
                    let failures = 0;
                    const held = Promise.withResolvers();
                    await page.route("**/agui/**", async (route) => {
                        const request = route.request();
                        assert.equal(request.headers().authorization, "Bearer body-fixture-credential");
                        reads.push(request.url());
                        if (request.url().endsWith("/missing") && failures++ === 0) {
                            await route.fulfill({ status: 404, contentType: "application/problem+json", body: '{"title":"Missing"}' });
                        } else if (request.url().endsWith("/redirect")) {
                            await route.continue();
                        } else {
                            if (request.url().endsWith("/held")) await held.promise;
                            await route.fulfill({ contentType: "text/html", body: source });
                        }
                    });
                    const messages = [{ id: "before-result", role: "assistant", content: "Earlier content.\n\n".repeat(80) },
                        { id: "result", role: "user", content: [
                        { type: "document", source: { type: "url", value: address, mimeType: "text/html" } },
                    ] }];
                    await page.evaluate((messages) => { window.messages = messages; window.present(messages); }, messages);
                    const result = page.locator('[data-message-id="result"]');
                    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    assert.equal(await result.locator("button, a, section, div").count(), 0);
                    assert.equal(await result.innerText(), "");
                    assert.doesNotMatch(await result.innerHTML(), /file.html|text\/html|agui\/7|status/u);
                    assert.equal(reads.length, 0);
                    assert.equal(credentials, 0, "off-screen history neither fetches nor obtains credentials");
                    await result.locator("[data-body-reference]").scrollIntoViewIfNeeded();
                    await result.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await result.locator("[data-body-reference]").textContent(), source);
                    assert.equal(await result.locator("script, img, form").count(), 0);
                    assert.deepEqual(await page.evaluate(() => window.messages), messages, "fetched bodies never enter messages sent back to HttpAgent");
                    await page.evaluate(() => { window.bodyNode = document.querySelector("[data-body-reference]"); window.present(structuredClone(window.messages)); });
                    assert.equal(await page.evaluate(() => window.bodyNode === document.querySelector("[data-body-reference]")), true);
                    assert.equal(reads.length, 1);
                    assert.equal(credentials, 1);

                    const presentReference = async (value) => {
                        const replacement = structuredClone(messages);
                        replacement[1].content[0].source.value = value;
                        await page.evaluate((messages) => window.present(messages), replacement);
                        await result.locator("[data-body-reference]").scrollIntoViewIfNeeded();
                    };
                    for (const refused of ["https://elsewhere.invalid/body", "javascript:alert(1)", new URL("/body", url).href.replace("://", "://user:pass@")]) {
                        await presentReference(refused);
                        await result.locator('[data-body-state="error"]').waitFor();
                        assert.equal(await result.locator("[data-body-reference]").textContent(), "Read address must be on this daemon's origin.");
                    }
                    assert.equal(credentials, 1, "an inadmissible address obtains no bearer");
                    assert.equal(reads.length, 1);

                    const missing = new URL("/agui/missing", url).href;
                    await presentReference(missing);
                    await result.locator('[data-body-state="error"]').waitFor();
                    assert.equal(await result.locator("[data-body-reference]").textContent(), "Read request failed (404).");
                    // Firefox does not log a handled fetch's HTTP refusal to the console.
                    checkBrowser(engine === firefox ? [] : [httpFailure("/agui/missing", 404)]);
                    await result.getByRole("button", { name: "Retry", exact: true }).click();
                    await result.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(reads.length, 3, "retry is explicit and performs one additional read");

                    await presentReference(new URL("/agui/redirect", url).href);
                    await result.locator('[data-body-state="error"]').waitFor();
                    assert.match(await result.locator("[data-body-reference]").textContent(), /Failed to fetch|NetworkError|Load failed/u);
                    assert.deepEqual(redirects, [], "content hydration never follows a credentialed redirect");
                    checkBrowser(engine === firefox ? [] : engine === chromium ? [
                        /^error \/body: Failed to load resource: net::ERR_FAILED$/u,
                    ] : [
                        /^error \/agui\/redirect: Failed to load resource:.*$/u,
                        /^error : Not allowed to follow a redirection while loading http:\/\/127\.0\.0\.1:\d+\/agui\/redirect$/u,
                        /^exception: \/127\.0\.0\.1:\d+\/agui\/redirect due to access control checks\.$/u,
                    ]);

                    const delayed = new URL("/agui/held", url).href;
                    const requested = page.waitForRequest(delayed);
                    const delivered = page.waitForResponse(delayed);
                    await presentReference(delayed);
                    await requested;
                    assert.equal(await result.locator("[data-body-reference]").getAttribute("aria-busy"), "true");
                    assert.equal(await result.getByRole("button").count(), 0);
                    await page.evaluate(() => window.present([{ id: "new-result", role: "tool", toolCallId: "read", content: "New receipt" }]));
                    held.resolve();
                    await (await delivered).finished();
                    await page.waitForFunction(() => !document.querySelector('[data-message-id="result"]'));
                    assert.equal(await page.locator('[data-message-id="new-result"] article').textContent(), "New receipt");
                    assert.equal(await page.locator("[data-body-reference]").count(), 0);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
