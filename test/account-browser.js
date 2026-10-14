import assert from "node:assert/strict";
import { chromium } from "playwright";
import verifyPageShell from "./page-shell.js";

// {§web-account} Exercise the installed documents and ordinary forms, not a session-manager mock.
export default async function verifyAccount({ t, withDaemon }) {
    for (const javaScriptEnabled of [true, false]) {
        await t.test(`{§web-account} sign-in, native Account, individual/other revocation and sign-out with JavaScript ${javaScriptEnabled ? "on" : "off"}`, async () => {
            await withDaemon({ PLURNK_USER: "account-user", PLURNK_PASS: "account-password" }, async (base) => {
                const browser = await chromium.launch();
                const contexts = [];
                try {
                    const enter = async () => {
                        const context = await browser.newContext({ javaScriptEnabled });
                        contexts.push(context);
                        const page = await context.newPage();
                        await page.goto(new URL("/account/", base).href);
                        assert.equal(new URL(page.url()).pathname, "/oauth/authorize");
                        await page.getByLabel("User", { exact: true }).fill("account-user");
                        await page.getByLabel("Password", { exact: true }).fill("account-password");
                        await page.getByRole("button", { name: "Continue", exact: true }).click();
                        await page.waitForURL(new URL("/account/", base).href);
                        return page;
                    };
                    const page = await enter();
                    const second = await enter();
                    const third = await enter();
                    await page.reload();
                    await verifyPageShell(page, { title: "Account — Plurnk", kind: "account" });
                    const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
                    assert.deepEqual(await nav.getByRole("link").allTextContents(), [" Plurnk", "Workspaces", "Account"]);
                    assert.equal(await nav.getByRole("button", { name: "Sign out", exact: true }).count(), 1);
                    assert.equal(await page.locator("footer form").count(), 0);
                    const signOut = nav.getByRole("button", { name: "Sign out", exact: true });
                    for (const colorScheme of ["light", "dark"]) {
                        await page.emulateMedia({ colorScheme });
                        for (const state of ["normal", "hover", "focus"]) {
                            if (state === "normal") { await page.mouse.move(0, 0); await signOut.blur(); }
                            if (state === "hover") await signOut.hover();
                            if (state === "focus") await signOut.focus();
                            const appearance = await signOut.evaluate((element) => {
                                const style = getComputedStyle(element);
                                return { background: style.backgroundColor, padding: style.padding, margin: style.margin, color: style.color,
                                    height: element.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight) };
                            });
                            assert.equal(appearance.background, "rgba(0, 0, 0, 0)", `${colorScheme}/${state}: Sign out is an unfilled menu action`);
                            assert.equal(appearance.padding, "0px", `${colorScheme}/${state}: no primary-button padding`);
                            assert.equal(appearance.margin, "0px", `${colorScheme}/${state}: the form action aligns with adjacent menu links`);
                            assert.ok(appearance.height <= appearance.lineHeight + 2, "Sign out occupies a text line, not a large call-to-action");
                            assert.notEqual(appearance.color, "rgba(0, 0, 0, 0)");
                        }
                    }
                    const rows = (tab) => tab.locator('section[aria-labelledby="sign-ins"] > ul > li');
                    const current = (tab) => rows(tab).filter({ has: tab.getByRole("heading", { name: "This session", exact: true }) });
                    assert.equal(await rows(page).count(), 3);
                    assert.equal(await current(page).count(), 1);
                    const family = await current(second).getAttribute("data-session");
                    const target = `/account/sessions/${encodeURIComponent(family)}/revoke`;
                    const context = page.context();
                    assert.equal((await context.request.get(new URL(target, base).href)).status(), 405, "GET cannot revoke a sign-in");
                    assert.equal((await context.request.post(new URL(target, base).href, { headers: { origin: "https://foreign.example" } })).status(), 403);
                    assert.equal((await context.request.post(new URL("/account/sessions/missing/revoke", base).href, { headers: { origin: new URL(base).origin } })).status(), 404);
                    await second.reload();
                    assert.equal(new URL(second.url()).pathname, "/account/", "refused mutations did not revoke the target");

                    await page.locator(`form[action="${target}"]`).getByRole("button", { name: "Revoke session", exact: true }).click();
                    assert.equal(await rows(page).count(), 2);
                    await second.reload();
                    assert.equal(new URL(second.url()).pathname, "/oauth/authorize", "the selected browser cannot silently sign back in");
                    await third.reload();
                    assert.equal(new URL(third.url()).pathname, "/account/", "the unselected browser is still signed in");
                    await page.getByRole("button", { name: "Revoke other sessions", exact: true }).click();
                    assert.equal(await rows(page).count(), 1);
                    assert.equal(await current(page).count(), 1);
                    assert.equal(await page.getByRole("button", { name: "Revoke other sessions", exact: true }).count(), 0);
                    await third.reload();
                    assert.equal(new URL(third.url()).pathname, "/oauth/authorize");

                    const get = await context.request.get(new URL("/account/index.html", base).href);
                    const head = await context.request.head(new URL("/account/", base).href);
                    assert.equal(get.status(), 200);
                    assert.equal(get.headers()["content-length"], head.headers()["content-length"]);
                    assert.equal(get.headers()["cache-control"], "no-store");
                    assert.equal((await head.body()).length, 0);
                    const cookies = await context.cookies();
                    const html = await get.text();
                    for (const cookie of cookies) assert.equal(html.includes(cookie.value), false, "account HTML never contains credentials");
                    await nav.getByRole("link", { name: "Plurnk", exact: true }).click();
                    assert.equal(await nav.getByRole("link", { name: "Account", exact: true }).count(), 1, "home reflects the live session");
                    await nav.getByRole("link", { name: "Account", exact: true }).click();
                    await page.getByRole("button", { name: "End this session", exact: true }).click();
                    await page.waitForURL(base);
                    assert.equal(await nav.getByRole("link", { name: "Account", exact: true }).count(), 0);
                    assert.equal(await nav.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
                    await page.goto(new URL("/account/", base).href);
                    assert.equal(new URL(page.url()).pathname, "/oauth/authorize");
                    const replay = await context.request.post(new URL(target, base).href, { headers: { origin: new URL(base).origin } });
                    assert.equal(replay.status(), 401, "a signed-out form is not replayed after automatic authorization");
                } finally {
                    await Promise.all(contexts.map((context) => context.close()));
                    await browser.close();
                }
            });
        });
    }
}
