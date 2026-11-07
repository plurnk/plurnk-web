import assert from "node:assert/strict";
import { engines } from "./engines.js";
import browserDiagnostics from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

export const footnoteContent = [
    "First[^a], repeated[^a], distinct[^a-2], heading[^label], reference[^ref-a], Unicode[^分析].",
    "`[^a]` stays code.",
    "```markdown\n[^a]: A code example, not a definition.\n```",
    "[^a]: First **definition**.\n\n    Second paragraph with *emphasis*.\n\n    - Nested item",
    "[^a-2]: Second definition.",
    "[^label]: Third definition.",
    "[^ref-a]: Fourth definition.",
    "[^分析]: Fifth definition.",
    "[^unused]: Unreferenced definition.",
].join("\n\n");

/** Inspect the native graph without depending on an implementation's ID spelling. */
export async function footnoteGraph(body) {
    return body.evaluate((element) => {
        const target = (link) => element.ownerDocument.getElementById(decodeURIComponent(new URL(link.href).hash.slice(1)));
        const references = [...element.querySelectorAll("sup > a")];
        const definitions = [...element.querySelectorAll('section[aria-label="Footnotes"] > ol > li')];
        const backlinks = [...element.querySelectorAll('a[aria-label^="Back to reference "]')];
        return {
            ids: [...element.querySelectorAll("[id]")].map(({ id }) => id),
            references: references.map((link) => ({ id: link.id, label: link.getAttribute("aria-label"), target: target(link)?.id })),
            definitions: definitions.map(({ id }) => id),
            backlinks: backlinks.map((link) => target(link)?.id),
            local: [...references, ...backlinks].every((link) => {
                const address = new URL(link.href);
                const current = new URL(location.href);
                return address.origin === current.origin && address.pathname === current.pathname
                    && address.search === current.search && element.contains(target(link));
            }),
        };
    });
}

// {§web-footnote-content} Exercise the compiled renderer, sanitizer, native anchors and production stylesheet.
export default async function verifyFootnotes(t) {
    const { server, url } = await conversationFixture();
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const present = (messages) => page.evaluate((messages) => window.present(messages), messages);
                    const rows = page.locator("[data-messages] [data-message-id]");
                    const body = () => rows.first().locator(":scope > article");

                    await t.test("repeated references and label collisions have unique message-local destinations", async () => {
                        const messages = ["same/label", "same%2Flabel"].map((id) => ({ id, role: "assistant", content: footnoteContent }));
                        await present(messages);
                        const graphs = [];
                        for (const row of await rows.all()) {
                            const outlet = row.locator("article");
                            const graph = await footnoteGraph(outlet);
                            assert.equal(graph.definitions.length, 5);
                            assert.equal(graph.references.length, 6);
                            assert.equal(graph.local, true);
                            assert.equal(graph.references[0].target, graph.references[1].target);
                            assert.deepEqual(graph.references.slice(1).map(({ target }) => target), graph.definitions);
                            assert.deepEqual(graph.backlinks, graph.references.map(({ id }) => id));
                            assert.deepEqual(graph.references.map(({ label }) => label), ["Footnote 1", "Footnote 1", "Footnote 2", "Footnote 3", "Footnote 4", "Footnote 5"]);
                            assert.deepEqual(await outlet.locator("code").allTextContents(), ["[^a]", "[^a]: A code example, not a definition.\n"]);
                            assert.equal(await outlet.locator("section strong").textContent(), "definition");
                            assert.equal(await outlet.locator("section em").textContent(), "emphasis");
                            assert.equal(await outlet.locator("section ul li").textContent(), "Nested item");
                            assert.doesNotMatch(await outlet.textContent(), /Unreferenced definition/u);
                            graphs.push(graph);
                        }
                        const ids = graphs.flatMap(({ ids }) => ids);
                        assert.equal(new Set(ids).size, ids.length);
                        for (const width of [320, 960, 420, 320]) {
                            await page.setViewportSize({ width, height: 640 });
                            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                        }
                        const reference = body().locator("sup > a").nth(1);
                        await reference.focus();
                        await page.keyboard.press("Enter");
                        await page.waitForFunction((id) => document.querySelector(":target")?.id === id, graphs[0].references[1].target);
                        const backlink = body().getByRole("link", { name: "Back to reference 1.2", exact: true });
                        await backlink.focus();
                        await page.keyboard.press("Enter");
                        await page.waitForFunction((id) => document.querySelector(":target")?.id === id, graphs[0].references[1].id);
                        assert.equal(new URL(page.url()).pathname, new URL(url).pathname);
                    });

                    await t.test("partial updates, replay and removal neither leak definitions nor reset unchanged nodes", async () => {
                        const message = { id: "stream", role: "assistant", content: "A[^a" };
                        for (const content of ["A[^a", "A[^a]", "A[^a]\n\n[^a"]) {
                            await present([{ ...message, content }]);
                            assert.equal(await body().locator("sup > a").count(), 0);
                            assert.match(await body().textContent(), /A\[\^a/u);
                        }
                        message.content = "A[^a]\n\n[^a]: Ready.";
                        await present([message]);
                        const before = await footnoteGraph(body());
                        assert.equal(before.references.length, 1);
                        await body().locator("sup > a").evaluate((link) => { window.savedFootnote = link; });
                        await present([structuredClone(message), { id: "unresolved", role: "assistant", content: "B[^a]" }]);
                        assert.equal(await body().locator("sup > a").evaluate((link) => link === window.savedFootnote), true);
                        assert.equal(await rows.nth(1).locator("sup > a").count(), 0);
                        message.content += "\n\nLater paragraph.";
                        await present([message]);
                        assert.deepEqual(await footnoteGraph(body()), before);
                        await present([]);
                        await present([message]);
                        assert.deepEqual(await footnoteGraph(body()), before);
                        await present([{ ...message, content: "A[^a]" }]);
                        assert.equal(await body().locator("[id], section").count(), 0);
                        assert.equal(await body().textContent(), "A[^a]\n");
                    });

                    await t.test("rich messages and send get separate scopes; note and reasoning remain literal", async () => {
                        const content = "A[^a]\n\n[^a]: **Definition**.";
                        const roles = ["user", "assistant", "system", "developer"];
                        /** @type {any[]} */
                        const messages = roles.map((role) => ({ id: role, role, content }));
                        messages.push(...["\ud800", "\ufffd"].map((id) => ({ id, role: "assistant", content })));
                        messages.push({ id: "replies", role: "assistant", toolCalls: ["assistant", "reply/分析%\""].map((toolCallId) => ({
                            toolCallId, name: "send", rawInput: { body: content }, _meta: { plurnk: { op: "send" } },
                        })) });
                        messages.push({ id: "note", role: "assistant", toolCalls: [{ toolCallId: "note-call",
                            name: "note", rawInput: { body: content }, _meta: { plurnk: { op: "note" } } }] },
                        { id: "reasoning", role: "reasoning", content });
                        messages.push({ id: "receipt", role: "tool", toolCallId: "opaque-call", content });
                        await present(messages);
                        const outlets = page.locator('[data-messages] article:has(section[aria-label="Footnotes"])');
                        assert.equal(await outlets.count(), 8);
                        const ids = [];
                        for (const outlet of await outlets.all()) {
                            const graph = await footnoteGraph(outlet);
                            assert.equal(graph.local, true);
                            assert.equal(graph.definitions.length, 1);
                            ids.push(...graph.ids);
                        }
                        assert.equal(new Set(ids).size, ids.length);
                        assert.equal(await page.locator('[data-call-id][data-plurnk-type="send"] > article').count(), 2);
                        for (const id of ["note", "reasoning", "receipt"]) {
                            const row = page.locator(`[data-message-id="${id}"]`);
                            assert.equal(await row.locator("article > details > pre").textContent(), content);
                            assert.equal(await row.locator("article sup").count(), 0);
                        }
                    });

                    await t.test("definitions compose with nested Markdown and native mathematics at phone width", async () => {
                        const content = "Inspect[^a].\n\n[^a]: " + "Prose wraps naturally. ".repeat(20)
                            + "\n\n    $x^2$ with **evidence**.\n\n    | Name | Value |\n    | --- | --- |\n    | A | B |"
                            + "\n\n    ```text\n    " + "wide code ".repeat(40) + "\n    ```";
                        await present([{ id: "math-note", role: "assistant", content }]);
                        const notes = body().locator('section[aria-label="Footnotes"]');
                        await notes.locator("math").waitFor();
                        assert.equal(await notes.locator("math annotation").textContent(), "x^2");
                        assert.equal(await notes.locator("strong").textContent(), "evidence");
                        assert.deepEqual(await notes.locator("table td").allTextContents(), ["A", "B"]);
                        assert.equal(await notes.locator("pre").evaluate((element) => element.scrollWidth > element.clientWidth), true);
                        assert.equal(await notes.locator("pre").evaluate((element) => getComputedStyle(element).overflowX), "auto");
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                        assert.equal((await footnoteGraph(body())).local, true);
                    });

                    await t.test("hostile labels and bodies cannot create application controls or request resources", async () => {
                        const requests = [];
                        const record = (request) => requests.push(request.url());
                        page.on("request", record);
                        const label = '<img src="/auth/token" onerror="window.contentExecuted=true">';
                        const content = `Read[^${label}].\n\n[^${label}]: <a id="session-status" data-text="connection-label" data-bind="href:call-href">Fake state</a>\n\n    <form action="/auth/logout"><button>Fake action</button></form>\n\n    [unsafe](javascript:alert%281%29) ![image](/security-probe)`;
                        await present([{ id: label, role: "assistant", content }]);
                        const graph = await footnoteGraph(body());
                        assert.equal(graph.definitions.length, 1);
                        assert.equal(graph.local, true);
                        assert.ok(graph.ids.every((id) => !id.includes("<") && !id.includes('"')));
                        assert.equal(await body().locator("script, form, button, img, [data-text], [data-bind], [name], [class], [style], [onerror]").count(), 0);
                        assert.match(await body().textContent(), /<form action="\/auth\/logout">/u);
                        assert.equal(await body().getByRole("link", { name: "image", exact: true }).getAttribute("href"), "/security-probe");
                        assert.equal(await body().locator('a[href^="javascript:"]').count(), 0);
                        assert.equal(await page.locator("#session-status").count(), 1);
                        assert.equal(await page.evaluate(() => window.contentExecuted), undefined);
                        assert.deepEqual(requests, []);
                        page.off("request", record);
                    });
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}
