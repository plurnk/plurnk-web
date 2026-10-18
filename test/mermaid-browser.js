import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";
import conversationFixture from "./conversation-fixture.js";

export const diagrams = [
    "flowchart LR\n A[Client] --> B[Daemon]",
    "stateDiagram-v2\n [*] --> Ready\n Ready --> Running: start\n Running --> [*]",
    "sequenceDiagram\n participant C as Client\n participant D as Daemon\n C->>D: Request\n D-->>C: Response",
    "classDiagram\n class Worker {\n +String name\n +run()\n }",
    "erDiagram\n WORKSPACE ||--o{ WORKER : contains\n WORKER {\n string name\n }",
    "xychart-beta\n x-axis [Jan, Feb, Mar]\n y-axis 0 --> 10\n bar [3, 7, 5]",
];
const fenced = (source) => `\`\`\`mermaid\n${source}\n\`\`\``;

export async function verifyMermaid(t) {
    const { server, url } = await conversationFixture();
    try {
        for (const engine of [chromium, firefox, webkit]) {
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
                    const body = page.locator("[data-message-body]");

                    await t.test("lazy rendering cannot resurrect replaced content", async () => {
                        assert.ok(!requests.some((path) => /mermaid-renderer-/u.test(path)));
                        const release = Promise.withResolvers();
                        const arrived = page.waitForRequest("**/mermaid-renderer-*.js");
                        await page.route("**/mermaid-renderer-*.js", async (route) => { await release.promise; await route.continue(); });
                        try {
                            await present(fenced("flowchart LR\n Old --> Gone"));
                            await arrived;
                            assert.equal(await body.locator("pre code").textContent(), "flowchart LR\n Old --> Gone\n");
                            await present(fenced(diagrams[0]));
                            release.resolve();
                            await body.locator("figure[data-diagram]:not([hidden]) img").waitFor();
                            assert.equal(await body.locator("[data-diagram]").count(), 1);
                            assert.equal(await body.locator("pre code").textContent(), diagrams[0] + "\n");
                        } finally { release.resolve(); await page.unroute("**/mermaid-renderer-*.js"); }
                    });

                    await t.test("all supported diagram families are decoded images with inspectable source", async () => {
                        await present(diagrams.map(fenced).join("\n\n"));
                        await page.waitForFunction(() => document.querySelectorAll("[data-diagram]:not([hidden])").length === 6);
                        const images = await body.locator("img").evaluateAll((items) => items.map((image) => ({
                            complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
                            source: image.src.startsWith("data:image/svg+xml;"), label: image.alt,
                        })));
                        assert.equal(images.length, 6);
                        assert.ok(images.every(({ complete, width, height, source, label }) => complete && width > 0 && height > 0 && source && label));
                        assert.deepEqual(await body.locator("pre code").allTextContents(), diagrams.map((source) => source + "\n"));
                        assert.equal(await body.locator("details[open]").count(), 0);
                        assert.equal(await body.locator("svg, iframe, object, embed, style").count(), 0);
                        await body.locator("details summary").first().click();
                        await body.locator("img").first().evaluate((image) => { window.savedDiagram = image; });
                        await present(diagrams.map(fenced).join("\n\n"));
                        assert.equal(await body.locator("img").first().evaluate((image) => image === window.savedDiagram), true);
                        assert.equal(await body.locator("details").first().evaluate((element) => element.open), true);
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
                        assert.deepEqual(requests.slice(before).filter((path) => !path.startsWith("data:")), []);
                    });

                    await t.test("rich roles and NOTE share one image boundary; tool results remain literal", async () => {
                        const content = fenced(diagrams[0]).replace("```mermaid", "```MERMAID example");
                        const roles = ["user", "assistant", "reasoning", "system", "developer"];
                        await page.evaluate(({ content, roles }) => window.present([
                            ...roles.map((role) => ({ id: role, role, content })),
                            { id: "notes", role: "assistant", content: "", toolCalls: [{ id: "note", type: "function", function: { name: "NOTE", arguments: JSON.stringify({ aside: "idea", body: content }) }, metadata: { plurnk: { op: "NOTE" } } }] },
                            { id: "result", role: "tool", toolCallId: "note", content },
                        ]), { content, roles });
                        await page.waitForFunction(() => document.querySelectorAll("[data-diagram]:not([hidden])").length === 6);
                        for (const role of roles) assert.equal(await page.locator(`[data-message-id="${role}"] [data-diagram]`).count(), 1);
                        assert.equal(await page.locator('[data-call-kind="note"] [data-diagram]').count(), 1);
                        assert.equal(await page.locator('[data-message-id="result"] img').count(), 0);
                        assert.equal(await page.locator('[data-message-id="result"] pre code').textContent(), content);
                    });

                    await t.test("unsupported and malformed diagrams retain source; ordinary code is never promoted", async () => {
                        const invalid = ["notMermaid\n A-->B", "flowchart WRONG\n A-->B", "pie\n title Counts\n \"A\" : 2"];
                        await present(invalid.map(fenced).join("\n\n") + "\n\n````markdown\n" + fenced(diagrams[0]) + "\n````\n\n`mermaid`\n\n    flowchart LR\n    A-->B");
                        await page.waitForFunction(() => document.querySelectorAll("[data-diagram-error]").length === 3);
                        assert.equal(await body.locator("img").count(), 0);
                        assert.deepEqual(await body.locator("[data-diagram-error] code").allTextContents(), invalid.map((source) => source + "\n"));
                        assert.ok((await body.locator("[data-diagram-error]").evaluateAll((items) => items.map((item) => item.title))).every(Boolean));
                        assert.equal(await body.locator("[data-diagram-error]").count(), 3, "examples and indented code are not interpreted as diagrams");
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
        await page.route("**/mermaid-renderer-*.js", (route) => {
            refused.push(new URL(route.request().url()).pathname);
            return route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
        });
        await page.goto(url);
        await page.waitForFunction(() => typeof window.present === "function");
        await page.evaluate((content) => window.present([{ id: "diagram", role: "assistant", content }]), fenced(diagrams[0]));
        await page.locator('[data-diagram-error="Diagram unavailable"]').waitFor();
        assert.equal(await page.locator("[data-mermaid] code").textContent(), diagrams[0] + "\n");
        assert.equal(await page.locator("[data-message-body] img").count(), 0);
        await page.evaluate(() => window.present([{ id: "plain", role: "assistant", content: "**Still connected**" }]));
        assert.equal(await page.locator("[data-message-body] strong").textContent(), "Still connected");
        assert.ok(refused.length > 0);
        assert.equal(new Set(refused).size, 1);
        checkBrowser([...refused.map((path) => httpFailure(path, 404)),
            new RegExp(`^exception: Failed to fetch dynamically imported module: ${RegExp.escape(new URL(refused[0], url).href)}$`, "u")]);
    } finally { await browser.close(); await server.close(); }
}
