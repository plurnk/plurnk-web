import assert from "node:assert/strict";
import { chromium, firefox } from "playwright";
import { engines } from "./engines.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

export const diagrams = [
    "flowchart LR\n A[Client] --> B[Daemon]",
    "stateDiagram-v2\n [*] --> Ready\n Ready --> Running: start\n Running --> [*]",
    "sequenceDiagram\n participant C as Client\n participant D as Daemon\n C->>D: Request\n D-->>C: Response",
    "classDiagram\n class Worker {\n +String name\n +run()\n }",
    "erDiagram\n WORKSPACE ||--o{ WORKER : contains\n WORKER {\n string name\n }",
    "xychart-beta\n x-axis [Jan, Feb, Mar]\n y-axis 0 --> 10\n bar [3, 7, 5]",
    'pie\n title Counts\n "A" : 2\n "B" : 3',
    "gantt\n title Work\n dateFormat YYYY-MM-DD\n section Tasks\n Build :2026-10-19, 2d",
    "mindmap\n root((Plurnk))\n  Workers\n  Messages",
    "gitGraph\n commit\n branch feature\n commit\n checkout main\n merge feature",
    "timeline\n title Project\n 2025 : Started\n 2026 : Improved",
];
const fenced = (source) => `\`\`\`mermaid\n${source}\n\`\`\``;

export async function verifyMermaid(t) {
    const { server, url } = await conversationFixture();
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
                    const checkBrowser = browserDiagnostics(context);
                    const page = await context.newPage();
                    const requests = [];
                    page.on("request", (request) => requests.push(request.url()));
                    await page.goto(url);
                    await page.waitForFunction(() => typeof window.present === "function");
                    const present = (content) => page.evaluate((content) => window.present([{ id: "diagram", role: "assistant", content }]), content);
                    const body = page.locator("[data-messages] article");

                    await t.test("lazy rendering cannot resurrect replaced content", async () => {
                        assert.ok(!requests.some((path) => path.endsWith("/render/mermaid")));
                        const release = Promise.withResolvers();
                        const arrived = page.waitForRequest("**/render/mermaid");
                        await page.route("**/render/mermaid", async (route) => { await release.promise; await route.continue(); });
                        try {
                            await present(fenced("flowchart LR\n Old --> Gone"));
                            await arrived;
                            assert.equal(await body.locator("pre code").textContent(), "flowchart LR\n Old --> Gone\n");
                            await present(fenced(diagrams[0]));
                            release.resolve();
                            await body.locator("figure[data-diagram]:not([hidden]) img").waitFor();
                            assert.equal(await body.locator("[data-diagram]").count(), 1);
                            assert.equal(await body.locator("pre code").textContent(), diagrams[0] + "\n");
                        } finally { release.resolve(); await page.unroute("**/render/mermaid"); }
                    });

                    await t.test("representative diagram families are decoded images with inspectable source", async () => {
                        await present(diagrams.map(fenced).join("\n\n"));
                        await page.waitForFunction((count) => document.querySelectorAll("[data-diagram]:not([hidden])").length === count, diagrams.length);
                        const images = await body.locator("img").evaluateAll((items) => items.map((image) => ({
                            complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
                            source: image.src.startsWith("data:image/svg+xml;"), label: image.alt,
                        })));
                        assert.equal(images.length, diagrams.length);
                        assert.ok(images.every(({ complete, width, height, source, label }) => complete && width > 0 && height > 0 && source && label));
                        assert.deepEqual(await body.locator("pre code").allTextContents(), diagrams.map((source) => source + "\n"));
                        assert.equal(await body.locator("figure[data-diagram-source]").count(), 0, "source is native code content, not figure state");
                        assert.equal(await body.locator("figure[data-diagram] details[open]").count(), 0);
                        assert.equal(await body.locator("svg, iframe, object, embed, style").count(), 0);
                        await body.locator("figure[data-diagram] details summary").first().click();
                        await body.locator("img").first().evaluate((image) => { window.savedDiagram = image; });
                        await present(diagrams.map(fenced).join("\n\n"));
                        assert.equal(await body.locator("img").first().evaluate((image) => image === window.savedDiagram), true);
                        assert.equal(await body.locator("figure[data-diagram] details").first().evaluate((element) => element.open), true);
                    });

                    await t.test("untrusted labels and renderer styles never become application markup or requests", async () => {
                        const before = requests.length;
                        await present(fenced('flowchart LR\n A["<img src=\'/diagram-trap\'><script>alert(1)</script>"] --> B[Done]')
                            + "\n\n![authored](/authored-image)\n\n<figure data-mermaid><code>flowchart LR; X-->Y</code></figure>");
                        await body.locator("[data-diagram]:not([hidden]) img").waitFor();
                        assert.equal(await body.locator("[data-diagram]").count(), 1);
                        assert.equal(await body.locator("script, style, svg, iframe, form, [onclick]").count(), 0);
                        assert.equal(await body.locator("img").count(), 1);
                        assert.equal(await body.getByRole("link", { name: "authored" }).getAttribute("href"), "/authored-image");
                        assert.deepEqual(requests.slice(before).filter((path) => !path.startsWith("data:")), [new URL("/render/mermaid", url).href]);
                    });

                    await t.test("rich messages and SEND compile diagrams; NOTE, reasoning and receipts remain literal", async () => {
                        const content = fenced(diagrams[0]).replace("```mermaid", "```MERMAID example");
                        const roles = ["user", "assistant", "system", "developer"];
                        await page.evaluate(({ content, roles }) => window.present([
                            ...roles.map((role) => ({ id: role, role, content })),
                            { id: "notes", role: "assistant", content: "", toolCalls: [{ id: "note", type: "function", function: { name: "NOTE", arguments: JSON.stringify({ aside: "idea", body: content }) }, metadata: { plurnk: { op: "NOTE" } } }] },
                            { id: "send", role: "assistant", toolCalls: [{ id: "send-call", type: "function", function: { name: "SEND", arguments: JSON.stringify({ body: content }) }, metadata: { plurnk: { op: "SEND" } } }] },
                            { id: "reasoning", role: "reasoning", content },
                            { id: "result", role: "tool", toolCallId: "opaque-call", content },
                        ]), { content, roles });
                        await page.waitForFunction(() => document.querySelectorAll("[data-diagram]:not([hidden])").length === 5);
                        for (const role of roles) assert.equal(await page.locator(`[data-message-id="${role}"] [data-diagram]`).count(), 1);
                        assert.equal(await page.locator('[data-message-id="send"] [data-diagram]').count(), 1);
                        for (const id of ["notes", "reasoning", "result"]) {
                            const row = page.locator(`[data-message-id="${id}"]`);
                            assert.equal(await row.locator("img, [data-diagram]").count(), 0);
                            assert.equal(await row.locator("article > details > pre").textContent(), content);
                        }
                    });

                    await t.test("even active SVG response bytes remain inert inside a native image", async () => {
                        const before = requests.length;
                        await page.route("**/render/mermaid", (route) => route.fulfill({ contentType: "image/svg+xml", body:
                            '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><script>window.diagramExecuted=true</script>'
                            + '<style>@import url("/svg-style-trap");</style><image href="/svg-image-trap" width="10" height="10"/>'
                            + '<rect width="100" height="40" fill="green"/></svg>' }));
                        try {
                            await present(fenced("flowchart LR\n Inert --> Image"));
                            const image = body.locator("[data-diagram]:not([hidden]) img");
                            await image.waitFor();
                            assert.equal(await image.evaluate((image) => image.complete && image.naturalWidth === 100), true);
                            assert.equal(await page.evaluate(() => window.diagramExecuted), undefined);
                            assert.equal(await body.locator("svg, script, iframe, object, embed, style").count(), 0);
                            assert.deepEqual(requests.slice(before).filter((path) => !path.startsWith("data:")), [new URL("/render/mermaid", url).href]);
                        } finally { await page.unroute("**/render/mermaid"); }
                    });

                    await t.test("unsupported and malformed diagrams retain source; ordinary code is never promoted", async () => {
                        checkBrowser();
                        const invalid = ["notMermaid\n A-->B", "flowchart WRONG\n A-->B", "flowchart LR\n A[Unclosed"];
                        await present(invalid.map(fenced).join("\n\n") + "\n\n````markdown\n" + fenced(diagrams[0]) + "\n````\n\n`mermaid`\n\n    flowchart LR\n    A-->B");
                        await page.waitForFunction(() => document.querySelectorAll("[data-diagram-error]").length === 3);
                        assert.equal(await body.locator("img").count(), 0);
                        assert.deepEqual(await body.locator("[data-diagram-error] code").allTextContents(), invalid.map((source) => source + "\n"));
                        assert.ok((await body.locator("[data-diagram-error]").evaluateAll((items) => items.map((item) => item.title))).every(Boolean));
                        assert.equal(await body.locator("[data-diagram-error]").count(), 3, "examples and indented code are not interpreted as diagrams");
                        checkBrowser(engine === firefox ? [] : invalid.map(() => httpFailure("/render/mermaid", 422)));
                    });

                    await t.test("wide diagrams scroll locally at intrinsic size without changing on viewport or palette changes", async () => {
                        await present(fenced("flowchart LR\n A[First] --> B[Second] --> C[Third] --> D[Fourth] --> E[Fifth] --> F[Sixth]"));
                        const image = body.locator("[data-diagram]:not([hidden]) img");
                        await image.waitFor();
                        const width = await image.evaluate((image) => image.naturalWidth);
                        assert.ok(width > 320);
                        for (const colorScheme of ["light", "dark"]) {
                            await page.emulateMedia({ colorScheme });
                            for (const viewport of [320, 768, 420]) {
                                await page.setViewportSize({ width: viewport, height: 640 });
                                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                                assert.equal(await image.evaluate((image) => Math.round(image.getBoundingClientRect().width)), width);
                                assert.equal(await body.locator("[data-diagram-viewport]").evaluate((element) => getComputedStyle(element).overflowX), "auto");
                            }
                        }
                    });
                    assert.ok(requests.every((address) => address.startsWith("data:") || new URL(address).origin === new URL(url).origin));
                    assert.ok(!requests.some((path) => /mermaid-renderer|\.wasm$/u.test(path)), "no browser compiler or WebAssembly download");
                    checkBrowser();
                } finally { await browser.close(); }
            });
        }
    } finally { await server.close(); }
}

export async function verifyUnavailableMermaid() {
    const { server, url } = await conversationFixture();
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        const checkBrowser = browserDiagnostics(context);
        const page = await context.newPage();
        const refused = [];
        await page.route("**/render/mermaid", (route) => {
            refused.push(new URL(route.request().url()).pathname);
            return route.fulfill({ status: 503, contentType: "application/problem+json", body: JSON.stringify({ status: 503, detail: "Diagram service unavailable." }) });
        });
        await page.goto(url);
        await page.waitForFunction(() => typeof window.present === "function");
        await page.evaluate((content) => window.present([{ id: "diagram", role: "assistant", content }]), fenced(diagrams[0]));
        await page.locator('[data-diagram-error="Diagram failed to render"]').waitFor();
        assert.equal(await page.locator("[data-diagram-error]").getAttribute("title"), "Error: Diagram service unavailable.");
        assert.equal(await page.locator("[data-mermaid] code").textContent(), diagrams[0] + "\n");
        assert.equal(await page.locator("[data-messages] article img").count(), 0);
        await page.evaluate(() => window.present([{ id: "plain", role: "assistant", content: "**Still connected**" }]));
        assert.equal(await page.locator("[data-messages] article strong").textContent(), "Still connected");
        assert.ok(refused.length > 0);
        assert.equal(new Set(refused).size, 1);
        checkBrowser(refused.map((path) => httpFailure(path, 503)));
    } finally { await browser.close(); await server.close(); }
}
