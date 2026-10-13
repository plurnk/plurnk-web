import assert from "node:assert/strict";

// {§web-language} Query, browser and unrelated stored preferences cannot translate
// the source-language document into itself or select an unshipped language.
export default async function verifyDocument(browser, base) {
    for (const query of ["", "?lang=fr"]) {
        const context = await browser.newContext({ locale: "fr-FR" });
        try {
            await context.addInitScript(() => {
                localStorage.setItem("otm:lang", "es");
                localStorage.setItem("plurnk:lang", "es");
                window.storageWrites = [];
                window.sourceReplacements = [];
                new MutationObserver((records) => {
                    for (const record of records) {
                        const carrier = record.target.nodeType === Node.TEXT_NODE
                            ? record.target.parentElement
                            : record.target;
                        if (carrier?.matches?.("[data-i18n]")
                            && (record.type === "characterData" || record.removedNodes.length > 0)) {
                            window.sourceReplacements.push(carrier.getAttribute("data-i18n"));
                        }
                    }
                }).observe(document, { childList: true, characterData: true, subtree: true });
                for (const method of ["setItem", "removeItem", "clear"]) {
                    const original = Storage.prototype[method];
                    Storage.prototype[method] = function (...args) {
                        window.storageWrites.push([method, ...args]);
                        return original.apply(this, args);
                    };
                }
            });
            const tab = await context.newPage();
            const errors = [];
            const requests = [];
            tab.on("pageerror", (error) => errors.push(error.message));
            tab.on("requestfailed", (request) => errors.push(request.url()));
            tab.on("console", (message) => {
                if (["error", "warning"].includes(message.type())) errors.push(message.text());
            });
            tab.on("request", (request) => requests.push(request.url()));
            await tab.goto(new URL(query || "/", base).href);
            assert.equal(await tab.locator("main h1").innerText(), "Hello world");
            assert.equal(await tab.locator("html").getAttribute("lang"), "en");
            assert.equal(await tab.title(), "Plurnk");
            assert.deepEqual(await tab.evaluate(() => window.sourceReplacements), [], "source text is not rewritten during boot");
            assert.ok(!requests.some((url) => new URL(url).pathname.startsWith("/locales/")), "source-language document needs no translation request");
            assert.deepEqual(await tab.evaluate(() => window.storageWrites), [], "boot does not persist browser state");
            assert.equal(await tab.evaluate(() => sessionStorage.length), 0);

            const styles = await tab.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")));
            assert.ok(styles.length > 0);
            assert.ok(styles.every((path) => /^\/assets\/.+\.css$/u.test(path)));
            assert.equal(await tab.locator("style, [class], [style], button, nav").count(), 0);
            assert.ok(requests.some((url) => /\/assets\/.+\.js$/u.test(url)));
            assert.ok(styles.every((path) => requests.includes(new URL(path, base).href)));
            assert.ok(!requests.some((url) => url.includes("/@vite/") || url.includes("/node_modules/")));
            assert.ok(requests.every((url) => new URL(url).origin === new URL(base).origin));
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    }
}
