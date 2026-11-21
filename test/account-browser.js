import assert from "node:assert/strict";
import { chromium } from "playwright";
import verifyPageShell from "./page-shell.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-account} Exercise the installed tabbed Account document (`#sign-ins` and `#about`) and ordinary forms, not a session-manager mock.
export default async function verifyAccount({ t, withDaemon }) {
    for (const javaScriptEnabled of [true, false]) {
        await t.test(`{§web-account} sign-in, tabbed Account (Sign-ins + About), individual/other revocation and sign-out with JavaScript ${javaScriptEnabled ? "on" : "off"}`, async () => {
            await withDaemon({ PLURNK_PASS: "account-password" }, async (base) => {
                const browser = await chromium.launch();
                const contexts = [];
                const checks = [];
                try {
                    const enter = async (target = "/account/", userAgent = undefined) => {
                        const context = await browser.newContext({
                            javaScriptEnabled,
                            ...(userAgent ? { userAgent } : {}),
                        });
                        contexts.push(context);
                        checks.push(browserDiagnostics(context));
                        const page = await context.newPage();
                        await page.goto(new URL(target, base).href);
                        assert.equal(new URL(page.url()).pathname, "/oauth/authorize");
                        await page.getByLabel("Password", { exact: true }).fill("account-password");
                        await page.getByRole("button", { name: "Continue", exact: true }).click();
                        await page.waitForURL(new URL(target, base).href);
                        await verifyPageShell(page, { title: "Account — Plurnk", kind: "account" });
                        assert.doesNotMatch(await page.locator("main").innerText(), /Signed in as|Local operator|operator/u);
                        return page;
                    };
                    const page = await enter();
                    const second = await enter();
                    const third = await enter("/account/", "Mozilla/5.0 PlurnkTest plurnk-desktop/2.1.0");
                    await page.reload();
                    await verifyPageShell(page, { title: "Account — Plurnk", kind: "account" });
                    const signInsSection = page.locator("#sign-ins");
                    const aboutSection = page.locator("#about");
                    assert.equal(await signInsSection.isVisible(), true);
                    assert.equal(await aboutSection.isVisible(), false);

                    // Verify About tab on ordinary browser vs plurnk-desktop User-Agent
                    await page.locator('#account-settings a[data-account-section="about"]').click();
                    assert.equal(await aboutSection.isVisible(), true);
                    assert.equal(await signInsSection.isVisible(), false);
                    assert.match(await aboutSection.locator('[data-text="about-service-version"]').innerText(), /^\d+\.\d+\.\d+/u);
                    assert.match(await aboutSection.locator('[data-text="about-web-version"]').innerText(), /^\d+\.\d+\.\d+/u);
                    assert.equal(await aboutSection.locator('[data-text="about-desktop-version"]').count(), 0, "ordinary browser omits plurnk-desktop row");
                    assert.equal(
                        await aboutSection.getByRole("link", { name: "github.com/plurnk/plurnk-service/issues", exact: true }).getAttribute("href"),
                        "https://github.com/plurnk/plurnk-service/issues",
                    );

                    await third.locator('#account-settings a[data-account-section="about"]').click();
                    assert.equal(await third.locator('#about [data-text="about-desktop-version"]').innerText(), "2.1.0");
                    await third.locator('#account-settings a[data-account-section="sign-ins"]').click();

                    await page.locator('#account-settings a[data-account-section="sign-ins"]').click();
                    assert.equal(await signInsSection.isVisible(), true);
                    assert.equal(await aboutSection.isVisible(), false);

                    const table = signInsSection.getByRole("table");
                    assert.deepEqual(await table.getByRole("columnheader").allTextContents(), ["Sign-in", "Started", "Expires", "Actions"]);
                    assert.deepEqual(await table.locator("..").evaluate((element) => ({
                        tag: element.tagName, overflow: getComputedStyle(element).overflowX,
                    })), { tag: "FIGURE", overflow: "auto" });
                    await page.setViewportSize({ width: 320, height: 900 });
                    assert.equal(await table.evaluate((element) => getComputedStyle(element).overflowWrap), "normal",
                        "table labels keep their words rather than breaking into vertical fragments");
                    assert.ok(await table.locator("..").evaluate((element) => element.scrollWidth > element.clientWidth),
                        "narrow tables scroll within their figure");
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
                    await page.setViewportSize({ width: 1440, height: 900 });
                    assert.equal(await page.getByRole("navigation", { name: "breadcrumb", exact: true }).getByRole("link", { name: "Home", exact: true }).getAttribute("href"), "/");
                    const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
                    assert.equal(await nav.getByRole("link").count(), 1);
                    assert.equal(await nav.getByRole("link", { name: "Account", exact: true }).locator("svg").count(), 1);
                    assert.equal(await nav.getByRole("button", { name: "Sign out", exact: true }).count(), 0, "Sign out moved out of header into /account/");
                    assert.equal(await page.locator("body > footer form").count(), 0);
                    const rows = (tab) => tab.locator("#sign-ins table > tbody > tr");
                    const current = (tab) => rows(tab).filter({ has: tab.getByRole("rowheader", { name: /^This sign-in/u }) });
                    assert.equal(await rows(page).count(), 3);
                    assert.equal(await current(page).count(), 1);
                    const family = await current(second).getAttribute("data-session");
                    const target = `/account/sign-ins/${encodeURIComponent(family)}/revoke`;
                    const context = page.context();
                    assert.equal((await context.request.get(new URL(target, base).href)).status(), 405, "GET cannot revoke a sign-in");
                    assert.equal((await context.request.post(new URL(target, base).href, { headers: { origin: "https://foreign.example" } })).status(), 403);
                    assert.equal((await context.request.post(new URL("/account/sign-ins/missing/revoke", base).href, { headers: { origin: new URL(base).origin } })).status(), 404);
                    await second.reload();
                    assert.equal(new URL(second.url()).pathname, "/account/", "refused mutations did not revoke the target");

                    await page.locator(`form[action="${target}"]`).getByRole("button", { name: "Revoke sign-in", exact: true }).click();
                    await page.waitForURL(new URL("/account/", base).href);
                    assert.equal(await rows(page).count(), 2);
                    await second.reload();
                    assert.equal(new URL(second.url()).pathname, "/oauth/authorize", "the selected browser cannot silently sign back in");
                    await third.reload();
                    assert.equal(new URL(third.url()).pathname, "/account/", "the unselected browser is still signed in");
                    await page.getByRole("button", { name: "Revoke other sign-ins", exact: true }).click();
                    assert.equal(await rows(page).count(), 1);
                    assert.equal(await current(page).count(), 1);
                    assert.equal(await page.getByRole("button", { name: "Revoke other sign-ins", exact: true }).count(), 0);
                    await third.reload();
                    assert.equal(new URL(third.url()).pathname, "/oauth/authorize");

                    const cookies = await context.cookies();
                    const get = await context.request.get(new URL("/account/index.html", base).href);
                    const head = await context.request.head(new URL("/account/", base).href);
                    assert.equal(get.status(), 200);
                    assert.equal(head.status(), 200);
                    assert.equal(get.headers()["content-length"], head.headers()["content-length"]);
                    assert.equal(get.headers()["cache-control"], "no-store");
                    assert.equal((await head.body()).length, 0);
                    const html = await get.text();
                    for (const cookie of cookies) assert.equal(html.includes(cookie.value), false, "account HTML never contains credentials");
                    assert.equal((await context.request.post(new URL("/account/", base).href)).status(), 405);
                    assert.equal((await context.request.get(new URL("/account", base).href)).status(), 404);

                    await page.getByRole("navigation", { name: "breadcrumb", exact: true }).getByRole("link", { name: "Home", exact: true }).click();
                    await page.waitForLoadState("load");
                    assert.equal(await nav.getByRole("link", { name: "Account", exact: true }).count(), 1, "home arrival reflects the live session");
                    await nav.getByRole("link", { name: "Account", exact: true }).click();
                    await page.waitForURL(new URL("/account/", base).href);
                    await page.getByRole("button", { name: "Sign out", exact: true }).click();
                    await page.waitForURL((url) => new URL(url).pathname === "/oauth/authorize");
                    assert.equal(await nav.getByRole("link", { name: "Account", exact: true }).count(), 0);
                    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
                    await page.goto(new URL("/account/index.html", base).href);
                    assert.equal(new URL(page.url()).pathname, "/oauth/authorize");
                    const replay = await context.request.post(new URL(target, base).href, { headers: { origin: new URL(base).origin } });
                    assert.equal(replay.status(), 401, "a signed-out form is not replayed after automatic authorization");
                    await page.getByLabel("Password", { exact: true }).fill("account-password");
                    await page.getByRole("button", { name: "Continue", exact: true }).click();
                    await page.waitForURL(new URL("/account/", base).href);
                    assert.equal(await current(page).count(), 1, "direct Account entry returns there after fresh sign-in");
                    for (const check of checks) check();
                } finally {
                    await Promise.all(contexts.map((context) => context.close()));
                    await browser.close();
                }
            });
        });
    }
}
