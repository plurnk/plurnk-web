import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
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
        for (const engine of [chromium, firefox, webkit]) {
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
                    const address = new URL("/agui/7/9/log/1/2/3/READ", url).href;
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
                    const messages = [{ id: "result", role: "tool", toolCallId: "read", content: [
                        { type: "text", text: '{"status":200,"path":"file.html"}' },
                        { type: "document", source: { type: "url", value: address, mimeType: "text/html" } },
                    ] }];
                    await page.evaluate((messages) => { window.messages = messages; window.present(messages); }, messages);
                    const result = page.locator('[data-message-id="result"]');
                    assert.equal(await result.locator("[data-message-body] > pre code").textContent(), '{"status":200,"path":"file.html"}');
                    assert.equal(await result.getByRole("button", { name: "Read body", exact: true }).count(), 1);
                    assert.equal(await result.locator("[data-text=body-address]").textContent(), address);
                    assert.equal(reads.length, 0);
                    assert.equal(credentials, 0, "rendering or opening a result neither fetches nor obtains credentials");
                    await result.getByRole("button", { name: "Read body", exact: true }).click();
                    await result.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(await result.locator("[data-text=body-content]").textContent(), source);
                    assert.equal(await result.locator("script, img, form").count(), 0);
                    assert.deepEqual(await page.evaluate(() => window.messages), messages, "fetched bodies never enter messages sent back to HttpAgent");
                    await page.evaluate(() => { window.bodyNode = document.querySelector("[data-body-content]"); window.present(structuredClone(window.messages)); });
                    assert.equal(await page.evaluate(() => window.bodyNode === document.querySelector("[data-body-content]")), true);
                    assert.equal(reads.length, 1);
                    assert.equal(credentials, 1);

                    const presentReference = async (value) => {
                        const replacement = structuredClone(messages);
                        replacement[0].content[1].source.value = value;
                        await page.evaluate((messages) => window.present(messages), replacement);
                    };
                    for (const refused of ["https://elsewhere.invalid/body", "javascript:alert(1)", new URL("/body", url).href.replace("://", "://user:pass@")]) {
                        await presentReference(refused);
                        await result.getByRole("button", { name: "Read body", exact: true }).click();
                        await result.locator('[data-body-state="error"]').waitFor();
                        assert.equal(await result.locator("[data-text=body-error]").textContent(), "Body address must be on this daemon's origin.");
                    }
                    assert.equal(credentials, 1, "an inadmissible address obtains no bearer");
                    assert.equal(reads.length, 1);

                    const missing = new URL("/agui/missing", url).href;
                    await presentReference(missing);
                    await result.getByRole("button", { name: "Read body", exact: true }).click();
                    await result.locator('[data-body-state="error"]').waitFor();
                    assert.equal(await result.locator("[data-text=body-error]").textContent(), "Body request failed (404).");
                    assert.equal(await result.locator("[data-message-body] > pre code").textContent(), '{"status":200,"path":"file.html"}');
                    // Firefox does not log a handled fetch's HTTP refusal to the console.
                    checkBrowser(engine === firefox ? [] : [httpFailure("/agui/missing", 404)]);
                    await result.getByRole("button", { name: "Read body", exact: true }).click();
                    await result.locator('[data-body-state="loaded"]').waitFor();
                    assert.equal(reads.length, 3, "retry is explicit and performs one additional read");

                    await presentReference(new URL("/agui/redirect", url).href);
                    await result.getByRole("button", { name: "Read body", exact: true }).click();
                    await result.locator('[data-body-state="error"]').waitFor();
                    assert.match(await result.locator("[data-text=body-error]").textContent(), /Failed to fetch|NetworkError|Load failed/u);
                    assert.deepEqual(redirects, [], "even explicit inspection never follows a credentialed redirect");
                    checkBrowser(engine === firefox ? [] : engine === chromium ? [
                        /^error \/body: Failed to load resource: net::ERR_FAILED$/u,
                    ] : [
                        /^error \/agui\/redirect: Failed to load resource:.*$/u,
                        /^error : Not allowed to follow a redirection while loading http:\/\/127\.0\.0\.1:\d+\/agui\/redirect$/u,
                        /^exception: \/127\.0\.0\.1:\d+\/agui\/redirect due to access control checks\.$/u,
                    ]);

                    const delayed = new URL("/agui/held", url).href;
                    await presentReference(delayed);
                    const requested = page.waitForRequest(delayed);
                    const delivered = page.waitForResponse(delayed);
                    await result.getByRole("button", { name: "Read body", exact: true }).click();
                    assert.equal(await result.getByRole("button", { name: "Read body", exact: true }).isDisabled(), true);
                    await requested;
                    await page.evaluate(() => window.present([{ id: "new-result", role: "tool", toolCallId: "read", content: "New receipt" }]));
                    held.resolve();
                    await (await delivered).finished();
                    await page.waitForFunction(() => !document.querySelector('[data-message-id="result"]'));
                    assert.equal(await page.locator('[data-message-id="new-result"] [data-message-body]').textContent(), "New receipt");
                    assert.equal(await page.locator("[data-body-reference]").count(), 0);
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
