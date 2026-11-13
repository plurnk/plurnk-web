import assert from "node:assert/strict";
import { engines } from "./engines.js";
import conversationFixture from "./conversation-fixture.js";
import browserDiagnostics, { httpFailure } from "./browser-diagnostics.js";

export const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
export const GIF_1X1_BASE64 = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
export const WEBP_1X1_BASE64 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

function sessionMeta(lifecycle = "idle") {
    return {
        workspace: { id: 7, name: "conversation", projectRoot: null, projectLabel: null, preparation: [], activity: null },
        status: {
            lifecycle,
            model: { alias: null, provider: "fixture", model: "browser", effort: "low", effortSource: "default" },
            loopId: lifecycle === "idle" ? null : 1,
            packetCount: 0,
            waitUntil: null,
            descendants: [],
            inbox: [],
            claimedAt: lifecycle === "running" ? 1000 : null,
            terminatedAt: lifecycle === "completed" ? 2000 : null,
            spend: {
                requests: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
                knownUsage: { inputTokens: 0, outputTokens: 0 },
                costUsd: "0",
                knownCostUsd: "0",
            },
        },
        budget: { contextTokens: null, contextCapacity: null, curationWeight: null, curationBudget: null },
        history: { older: null },
    };
}

// {§web-inline-images} {§web-session-input} {§web-card-disclosure} {§web-operation-summary} {§web-result-bodies}
export default async function verifyInlineImages(t) {
    const bodyFixture = await conversationFixture(new URL("./body-entry.js", import.meta.url));
    const appFixture = await conversationFixture(new URL("../web/app.js", import.meta.url));
    try {
        for (const engine of engines) {
            await t.test(engine.name(), async (t) => {
                const browser = await engine.launch();
                try {
                    await t.test("{§web-inline-images} {§web-card-disclosure} {§web-operation-summary} {§web-result-bodies} transcript raster parts, user attachment links, lazy read/MCP disclosures, and SVG/corrupt refusals", async () => {
                        const context = await browser.newContext({ viewport: { width: 420, height: 640 } });
                        const checkBrowser = browserDiagnostics(context);
                        const page = await context.newPage();
                        const unasked = [];
                        page.on("request", (req) => {
                            if (req.url().includes("/unasked")) unasked.push(req.url());
                        });
                        let tokenRequests = 0;
                        await page.route("**/auth/token", async (route) => {
                            tokenRequests += 1;
                            await route.fulfill({ json: { token_type: "Bearer", access_token: "image-fixture-token" } });
                        });
                        const entryReads = [];
                        let failMissingOnce = true;
                        await page.route("**/acp/7/9/entry**", async (route) => {
                            const req = route.request();
                            assert.equal(req.headers().authorization, "Bearer image-fixture-token");
                            const target = new URL(req.url()).searchParams.get("target") ?? "";
                            entryReads.push(target);
                            if (target.endsWith("/missing.png") && failMissingOnce) {
                                failMissingOnce = false;
                                await route.fulfill({
                                    status: 404,
                                    contentType: "application/problem+json",
                                    body: JSON.stringify({
                                        type: "https://problems.plurnk.xyz/acp/entry/entry-not-found",
                                        title: "Not Found",
                                        status: 404,
                                        detail: "Attachment entry is unavailable.",
                                    }),
                                });
                                return;
                            }
                            if (target.endsWith("/spoofed-svg.png")) {
                                await route.fulfill({
                                    status: 200,
                                    contentType: "image/png; charset=utf-8",
                                    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.svgRan=true"></svg>', "utf8").toString("base64"),
                                });
                                return;
                            }
                            if (target.endsWith("/binary.gif")) {
                                await route.fulfill({
                                    status: 200,
                                    contentType: "image/gif",
                                    body: Buffer.from(GIF_1X1_BASE64, "base64"),
                                });
                                return;
                            }
                            await route.fulfill({
                                status: 200,
                                contentType: "image/png; charset=utf-8",
                                body: PNG_1X1_BASE64,
                            });
                        });

                        await page.goto(bodyFixture.url);
                        await page.waitForFunction(() => typeof window.present === "function");
                        const jpegBase64 = await page.evaluate(() => {
                            const canvas = document.createElement("canvas");
                            canvas.width = 1;
                            canvas.height = 1;
                            const ctx = canvas.getContext("2d");
                            ctx.fillStyle = "#336699";
                            ctx.fillRect(0, 0, 1, 1);
                            return canvas.toDataURL("image/jpeg").split(",")[1];
                        });
                        const entryBaseUrl = new URL("/acp/7/9/entry?target=log%3A%2F%2F%2F1%2F1%2F1%2Fsend", bodyFixture.url).href;

                        // 1. Direct { type: "image" } across all four safe raster formats (PNG, JPEG, GIF, WebP).
                        await page.evaluate(({ png, jpeg, gif, webp }) => {
                            window.present([
                                {
                                    id: "raster-matrix",
                                    role: "assistant",
                                    content: [
                                        { type: "text", text: "Verified **raster** matrix." },
                                        { type: "image", mimeType: "image/png", data: png, name: "sample.png" },
                                        { type: "image", mimeType: "image/jpeg", data: jpeg, name: "sample.jpg" },
                                        { type: "image", mimeType: "image/gif", data: gif, name: "sample.gif" },
                                        { type: "image", mimeType: "image/webp", data: webp, name: "sample.webp" },
                                    ],
                                },
                            ]);
                        }, { png: PNG_1X1_BASE64, jpeg: jpegBase64, gif: GIF_1X1_BASE64, webp: WEBP_1X1_BASE64 });

                        const matrixRow = page.locator('[data-message-id="raster-matrix"]');
                        await page.waitForFunction(() => document.querySelectorAll('[data-message-id="raster-matrix"] figure[data-inline-image]:not([hidden]) img').length === 4);
                        const decodedMatrix = await matrixRow.locator("figure[data-inline-image] img").evaluateAll((imgs) => imgs.map((img) => ({
                            alt: img.alt,
                            prefix: img.getAttribute("src")?.slice(0, 22),
                            naturalWidth: img.naturalWidth,
                            naturalHeight: img.naturalHeight,
                        })));
                        assert.deepEqual(decodedMatrix, [
                            { alt: "sample.png", prefix: "data:image/png;base64,", naturalWidth: 1, naturalHeight: 1 },
                            { alt: "sample.jpg", prefix: "data:image/jpeg;base64", naturalWidth: 1, naturalHeight: 1 },
                            { alt: "sample.gif", prefix: "data:image/gif;base64,", naturalWidth: 1, naturalHeight: 1 },
                            { alt: "sample.webp", prefix: "data:image/webp;base64", naturalWidth: 1, naturalHeight: 1 },
                        ]);
                        assert.equal(await page.locator("#session-conversation [class], #session-conversation [style]").count(), 0);
                        assert.equal(entryReads.length, 0, "direct base64 raster parts make no entry HTTP fetches");

                        // 2. Off-screen user attachment link waits for viewport visibility, then hydrates with Authorization bearer.
                        await page.evaluate(({ entryBaseUrl }) => {
                            const updates = [
                                {
                                    sessionUpdate: "agent_message_chunk",
                                    messageId: "spacer",
                                    content: { type: "text", text: "Spacer line.\n\n".repeat(80) },
                                    _meta: { plurnk: { id: 1, coordinate: "1/1/1", loopId: 1 } },
                                },
                                {
                                    sessionUpdate: "user_message_chunk",
                                    messageId: "user-attached",
                                    content: {
                                        type: "text",
                                        text: "Inspect these two captures.\n\n<session://user/attachments/deadbeef/diagram.png>\n\n<session://user/attachments/deadbeef/binary.gif>",
                                    },
                                    _meta: { plurnk: { id: 2, coordinate: "1/2/1", loopId: 1, origin: "operator", body: { url: entryBaseUrl, mimeType: "text/plain" } } },
                                },
                            ];
                            window.currentMessages = window.projectUpdates(updates, []);
                            window.present(window.currentMessages);
                        }, { entryBaseUrl });

                        const userRow = page.locator('[data-message-id="user-attached"]');
                        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                        assert.equal(entryReads.length, 0, "off-screen user image attachments do not fetch eagerly");
                        assert.equal(tokenRequests, 0, "off-screen user image attachments do not request bearer tokens");

                        await userRow.scrollIntoViewIfNeeded();
                        await userRow.locator('[data-image-reference][data-body-state="loaded"]').nth(1).waitFor();
                        assert.deepEqual(entryReads, [
                            "session://user/attachments/deadbeef/diagram.png",
                            "session://user/attachments/deadbeef/binary.gif",
                        ]);
                        assert.equal(await userRow.locator("article p").textContent(), "Inspect these two captures.");
                        assert.doesNotMatch(await userRow.innerText(), /session:\/\/user\/attachments/u);
                        assert.deepEqual(
                            await userRow.locator("figure[data-inline-image] img").evaluateAll((imgs) => imgs.map((img) => [img.alt, img.naturalWidth])),
                            [["diagram.png", 1], ["binary.gif", 1]],
                        );

                        await page.evaluate(() => {
                            window.savedImageNode = document.querySelector('[data-message-id="user-attached"] [data-image-reference]');
                            window.present(structuredClone(window.currentMessages));
                        });
                        assert.equal(await page.evaluate(() => window.savedImageNode === document.querySelector('[data-message-id="user-attached"] [data-image-reference]')), true);
                        assert.equal(entryReads.length, 2, "re-presenting unchanged messages reuses mounted image references without refetching");

                        // 3. Working operations: raster read (both file:/// and relative path) + MCP image channel stay collapsed until opened; plain text read has no details.
                        entryReads.length = 0;
                        await page.evaluate(({ entryBaseUrl }) => {
                            const updates = [
                                {
                                    sessionUpdate: "tool_call_update",
                                    toolCallId: "1/1/2",
                                    name: "read",
                                    title: "read (witness.txt)",
                                    kind: "read",
                                    status: "completed",
                                    locations: [{ path: "witness.txt" }],
                                    rawInput: { path: "witness.txt" },
                                    rawOutput: { status: 200, mimetype: "text/plain" },
                                    content: [{ type: "content", content: { type: "text", text: "Plain text body" } }],
                                    _meta: { plurnk: { id: 10, op: "read", coordinate: "1/1/2", origin: "model", state: "resolved", status: 200, target: "witness.txt", body: { url: entryBaseUrl } } },
                                },
                                {
                                    sessionUpdate: "tool_call_update",
                                    toolCallId: "1/1/3",
                                    name: "read",
                                    title: "read (chart.png)",
                                    kind: "read",
                                    status: "completed",
                                    locations: [{ path: "chart.png" }],
                                    rawInput: { path: "chart.png" },
                                    rawOutput: { status: 200, mimetype: "text/markdown", image: { mimetype: "image/png", width: 1, height: 1, bytes: 68 } },
                                    content: [{ type: "content", content: { type: "text", text: "PNG image, 1×1 px, 68 bytes" } }],
                                    _meta: { plurnk: { id: 11, op: "read", coordinate: "1/1/3", origin: "model", state: "resolved", status: 200, target: "chart.png", receipt: { status: 200, image: { mimetype: "image/png", width: 1, height: 1, bytes: 68 } }, body: { url: entryBaseUrl } } },
                                },
                                {
                                    sessionUpdate: "tool_call_update",
                                    toolCallId: "1/1/4",
                                    name: "browser_screenshot",
                                    title: "browser_screenshot",
                                    kind: "other",
                                    status: "completed",
                                    rawInput: {},
                                    rawOutput: { status: 200 },
                                    content: [{ type: "content", content: { type: "text", text: "<session://user/mcp/shot.png> — image/png" } }],
                                    _meta: { plurnk: { id: 12, op: "exec", coordinate: "1/1/4", origin: "model", state: "resolved", status: 200, body: { url: entryBaseUrl } } },
                                },
                            ];
                            window.present(window.projectUpdates(updates, []));
                        }, { entryBaseUrl });

                        const opsDetails = page.locator("[data-operations] > details");
                        assert.equal(await opsDetails.evaluate((el) => el.open), false);
                        assert.equal(entryReads.length, 0);
                        await opsDetails.locator(":scope > summary").click();

                        const textRead = page.locator('[data-call-id="1/1/2"]');
                        const imageRead = page.locator('[data-call-id="1/1/3"]');
                        const mcpShot = page.locator('[data-call-id="1/1/4"]');
                        assert.equal(await textRead.locator("details").count(), 0, "plain text read retains zero body disclosure");
                        assert.equal(await imageRead.locator("details").evaluate((el) => el.open), false, "raster read card starts collapsed");
                        assert.equal(await mcpShot.locator("details").evaluate((el) => el.open), false, "MCP image tool card starts collapsed");
                        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                        assert.equal(entryReads.length, 0, "collapsed operation cards do not fetch image entries");

                        await imageRead.locator("summary").click();
                        await imageRead.locator('[data-image-reference][data-body-state="loaded"]').waitFor();
                        assert.deepEqual(entryReads, ["chart.png"]);
                        assert.equal(await imageRead.locator("figure[data-inline-image] img").evaluate((img) => img.naturalWidth), 1);

                        await mcpShot.locator("summary").click();
                        await mcpShot.locator('[data-image-reference][data-body-state="loaded"]').waitFor();
                        assert.deepEqual(entryReads, ["chart.png", "session://user/mcp/shot.png"]);
                        assert.equal(await mcpShot.locator("figure[data-inline-image] img").evaluate((img) => img.naturalWidth), 1);

                        // 4. Adversarial Markdown/HTML images, spoofed SVG bytes, and 404 Retry recovery.
                        entryReads.length = 0;
                        await page.evaluate(({ entryBaseUrl }) => {
                            window.present([
                                {
                                    id: "authored-markdown",
                                    role: "assistant",
                                    content: '![probe](/unasked/markdown.png)\n\n<img src="/unasked/raw.png" alt="raw">',
                                },
                                {
                                    id: "svg-direct",
                                    role: "assistant",
                                    content: [
                                        { type: "image", mimeType: "image/png", data: btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), name: "evil.png" },
                                    ],
                                },
                                {
                                    id: "spoofed-entry",
                                    role: "user",
                                    content: [
                                        {
                                            type: "resource_link",
                                            uri: `${new URL("/acp/7/9/entry", entryBaseUrl).href}?target=${encodeURIComponent("session://user/attachments/deadbeef/spoofed-svg.png")}`,
                                            mimeType: "image/png",
                                            name: "spoofed-svg.png",
                                        },
                                    ],
                                },
                                {
                                    id: "missing-entry",
                                    role: "user",
                                    content: [
                                        {
                                            type: "resource_link",
                                            uri: `${new URL("/acp/7/9/entry", entryBaseUrl).href}?target=${encodeURIComponent("session://user/attachments/deadbeef/missing.png")}`,
                                            mimeType: "image/png",
                                            name: "missing.png",
                                        },
                                    ],
                                },
                            ]);
                        }, { entryBaseUrl });

                        const authoredRow = page.locator('[data-message-id="authored-markdown"]');
                        assert.equal(await authoredRow.locator("img").count(), 0, "authored Markdown and HTML never mount <img>");
                        assert.equal(await authoredRow.locator('a[href="/unasked/markdown.png"]').textContent(), "probe");
                        assert.deepEqual(unasked, []);

                        const svgDirectRow = page.locator('[data-message-id="svg-direct"]');
                        await svgDirectRow.locator('[data-image-reference][data-body-state="error"]').waitFor();
                        assert.equal(await svgDirectRow.locator("img").count(), 0);
                        assert.match(await svgDirectRow.innerText(), /Unsupported or invalid raster image data\./u);

                        const spoofedRow = page.locator('[data-message-id="spoofed-entry"]');
                        await spoofedRow.scrollIntoViewIfNeeded();
                        await spoofedRow.locator('[data-image-reference][data-body-state="error"]').waitFor();
                        assert.equal(await spoofedRow.locator("img").count(), 0);
                        assert.equal(await page.evaluate(() => Boolean(window.svgRan)), false);
                        assert.match(await spoofedRow.innerText(), /Unsupported or invalid raster image data\./u);

                        const missingRow = page.locator('[data-message-id="missing-entry"]');
                        await missingRow.scrollIntoViewIfNeeded();
                        await missingRow.locator('[data-image-reference][data-body-state="error"]').waitFor();
                        assert.equal(await missingRow.locator("[data-image-reference]").textContent(), "Attachment entry is unavailable.");
                        checkBrowser([httpFailure("/acp/7/9/entry", 404)]);

                        await missingRow.getByRole("button", { name: "Retry", exact: true }).click();
                        await missingRow.locator('[data-image-reference][data-body-state="loaded"]').waitFor();
                        assert.equal(await missingRow.locator("figure[data-inline-image] img").evaluate((img) => img.naturalWidth), 1);

                        checkBrowser();
                        await context.close();
                    });

                    await t.test("{§web-inline-images} {§web-session-input} composer attachment button capability gating, file/paste/drop validation, slash-command guard, and ACP prompt image blocks", async () => {
                        const context = await browser.newContext({ viewport: { width: 420, height: 680 } });
                        const checkBrowser = browserDiagnostics(context);
                        const page = await context.newPage();

                        const prompts = [];
                        /** @type {any[]} */
                        const publishedUpdates = [];
                        let refuseNextPrompt = false;
                        appFixture.setCapabilities({});
                        appFixture.onAcp((input) => {
                            if (input.method === "session/resume") {
                                return {
                                    updates: [...publishedUpdates],
                                    result: {
                                        configOptions: [],
                                        availableCommands: [{ name: "help", description: "Show help" }],
                                        _meta: { plurnk: sessionMeta("idle") },
                                    },
                                };
                            }
                            if (input.method === "session/prompt") {
                                prompts.push(input.params);
                                if (refuseNextPrompt) {
                                    refuseNextPrompt = false;
                                    return {
                                        error: {
                                            code: -32602,
                                            message: "Simulated prompt refusal",
                                            data: {
                                                type: "https://problems.plurnk.xyz/acp/prompt-refused",
                                                title: "Bad Request",
                                                status: 400,
                                                detail: "Simulated daemon refusal.",
                                            },
                                        },
                                    };
                                }
                                const messageId = input.params.messageId;
                                const textBlocks = input.params.prompt.filter((b) => b.type === "text").map((b) => b.text);
                                const imageBlocks = input.params.prompt.filter((b) => b.type === "image");
                                const bodyUrl = new URL("/acp/7/9/entry?target=log%3A%2F%2F%2F1%2F1%2F1%2Fsend", appFixture.url).href;
                                const links = imageBlocks.map((img) => `<session://user/attachments/deadbeef/${encodeURIComponent(img.uri ?? "image.png")}>`);
                                const publishedText = [...textBlocks, ...links].filter(Boolean).join("\n\n");
                                const turnUpdates = [
                                    {
                                        sessionUpdate: "user_message_chunk",
                                        messageId,
                                        content: { type: "text", text: publishedText },
                                        _meta: {
                                            plurnk: {
                                                id: prompts.length * 2,
                                                coordinate: `${prompts.length}/1/1`,
                                                loopId: prompts.length,
                                                origin: "operator",
                                                body: { url: bodyUrl, mimeType: "text/plain" },
                                            },
                                        },
                                    },
                                    {
                                        sessionUpdate: "agent_message_chunk",
                                        messageId: `${prompts.length}/1/2`,
                                        content: { type: "text", text: `Prompt ${prompts.length} received ${imageBlocks.length} image(s).` },
                                        _meta: { plurnk: { id: prompts.length * 2 + 1, coordinate: `${prompts.length}/1/2`, loopId: prompts.length } },
                                    },
                                ];
                                publishedUpdates.push(...turnUpdates);
                                return {
                                    updates: [
                                        ...turnUpdates,
                                        {
                                            sessionUpdate: "state_update",
                                            state: "idle",
                                            _meta: { plurnk: sessionMeta("idle") },
                                        },
                                    ],
                                    result: { stopReason: "end_turn", messageId },
                                };
                            }
                            return { result: {} };
                        });

                        await page.route("**/auth/token", (route) => route.fulfill({ json: { token_type: "Bearer", access_token: "app-token" } }));
                        await page.route("**/acp/7/9/entry**", (route) => route.fulfill({
                            status: 200,
                            contentType: "image/png; charset=utf-8",
                            body: PNG_1X1_BASE64,
                        }));

                        // 1. Unsupported session capability: Attach image button is hidden and paste/drop reports clear refusal.
                        await page.goto(appFixture.url);
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        const attachButton = page.getByRole("button", { name: "Attach image", exact: true });
                        const draft = page.getByRole("textbox", { name: "Message", exact: true });
                        const send = page.getByRole("button", { name: "Send", exact: true });

                        assert.equal(await attachButton.isVisible(), false, "Attach image button stays hidden without prompt.image capability");
                        await page.evaluate((pngBase64) => {
                            const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
                            const file = new File([bytes], "paste.png", { type: "image/png" });
                            const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
                            Object.defineProperty(pasteEvent, "clipboardData", {
                                value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], files: [file] },
                            });
                            document.querySelector("#session-message")?.dispatchEvent(pasteEvent);
                        }, PNG_1X1_BASE64);
                        await page.getByText("Image attachments are not supported on this session.", { exact: true }).waitFor();
                        assert.equal(await page.locator("[data-compose-attachments] > li").count(), 0);

                        // 2. Supported session capability: button visible, aligned with textarea height, picker + paste + drop + remove + slash guard + submit.
                        appFixture.setCapabilities({ session: { prompt: { image: {} } } });
                        await page.reload();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        assert.equal(await attachButton.isVisible(), true, "Attach image button is visible when prompt.image is advertised");
                        const [attachBox, draftBox] = await Promise.all([attachButton.boundingBox(), draft.boundingBox()]);
                        assert.ok(attachBox && draftBox && Math.abs(attachBox.height - draftBox.height) <= 1.5,
                            `Attach button (${attachBox?.height}) aligns with composer height (${draftBox?.height})`);

                        // Queue valid PNG + invalid SVG via file input: valid queues, SVG reports error.
                        await page.locator("input[data-attach-input]").setInputFiles([
                            { name: "diagram.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1_BASE64, "base64") },
                            { name: "vector.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8") },
                        ]);
                        await page.getByText('Unsupported image file "vector.svg". Attach PNG, JPEG, GIF, or WebP.', { exact: true }).waitFor();
                        assert.equal(await page.locator("[data-compose-attachments] > li").count(), 1);
                        assert.equal(await page.locator('[data-compose-attachments] [data-text="attachment-name"]').textContent(), "diagram.png");

                        // Slash command guard while attachment is queued.
                        await draft.fill("/help");
                        await send.click();
                        await page.getByText("Remove queued image attachments before running a client slash command.", { exact: true }).waitFor();
                        assert.equal(prompts.length, 0);
                        assert.equal(await page.locator("[data-compose-attachments] > li").count(), 1);

                        // Submit image-only prompt (empty text + queued diagram.png).
                        await draft.fill("");
                        await send.click();
                        await page.getByText("Prompt 1 received 1 image(s).", { exact: true }).waitFor();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected"
                            && document.querySelectorAll("[data-compose-attachments] > li").length === 0);
                        assert.equal(prompts.length, 1);
                        assert.deepEqual(prompts[0].prompt, [
                            { type: "image", mimeType: "image/png", data: PNG_1X1_BASE64, uri: "file:///diagram.png" },
                        ]);
                        assert.equal(await page.locator("[data-compose-attachments] > li").count(), 0, "acknowledged submission clears attachment pills");
                        await page.locator('[data-message-role="user"] figure[data-inline-image] img').waitFor();
                        assert.equal(await page.locator('[data-message-role="user"] figure[data-inline-image] img').evaluate((img) => img.naturalWidth), 1);

                        // Paste unnamed GIF + drop misnamed WebP, remove one, fail once (retaining draft + attachment + messageId), then retry cleanly.
                        await page.evaluate(({ gifBase64, webpBase64 }) => {
                            const gifBytes = Uint8Array.from(atob(gifBase64), (c) => c.charCodeAt(0));
                            const gifFile = new File([gifBytes], "", { type: "image/gif" });
                            const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
                            Object.defineProperty(pasteEvent, "clipboardData", {
                                value: { items: [{ kind: "file", type: "image/gif", getAsFile: () => gifFile }], files: [gifFile] },
                            });
                            document.querySelector("#session-message")?.dispatchEvent(pasteEvent);

                            const webpBytes = Uint8Array.from(atob(webpBase64), (c) => c.charCodeAt(0));
                            const webpFile = new File([webpBytes], "capture.bin", { type: "application/octet-stream" });
                            const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
                            Object.defineProperty(dropEvent, "dataTransfer", {
                                value: { types: ["Files"], files: [webpFile] },
                            });
                            document.querySelector("#session-compose")?.dispatchEvent(dropEvent);
                        }, { gifBase64: GIF_1X1_BASE64, webpBase64: WEBP_1X1_BASE64 });

                        await page.waitForFunction(() => document.querySelectorAll("[data-compose-attachments] > li").length === 2);
                        assert.deepEqual(
                            await page.locator('[data-compose-attachments] [data-text="attachment-name"]').allTextContents(),
                            ["image.gif", "capture.webp"],
                        );
                        await page.getByRole("button", { name: "Remove image.gif", exact: true }).click();
                        assert.deepEqual(
                            await page.locator('[data-compose-attachments] [data-text="attachment-name"]').allTextContents(),
                            ["capture.webp"],
                        );

                        refuseNextPrompt = true;
                        await draft.fill("Explain this capture.");
                        await send.click();
                        await page.getByText(/Simulated daemon refusal\./u).waitFor();
                        assert.equal(await draft.inputValue(), "Explain this capture.", "failed submission retains draft text");
                        assert.equal(await page.locator("[data-compose-attachments] > li").count(), 1, "failed submission retains queued attachments");

                        await page.getByRole("button", { name: "Reconnect", exact: true }).click();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected");
                        await page.getByText("Delivery remains unconfirmed. You may retry this draft.", { exact: true }).waitFor();
                        await send.click();
                        await page.getByText("Prompt 3 received 1 image(s).", { exact: true }).waitFor();
                        await page.waitForFunction(() => document.querySelector("#session-status")?.dataset.connection === "connected"
                            && document.querySelectorAll("[data-compose-attachments] > li").length === 0);
                        assert.equal(prompts.length, 3);
                        assert.equal(prompts[1].messageId, prompts[2].messageId, "unchanged draft + attachments retry with stable idempotency messageId");
                        assert.deepEqual(prompts[2].prompt, [
                            { type: "text", text: "Explain this capture." },
                            { type: "image", mimeType: "image/webp", data: WEBP_1X1_BASE64, uri: "file:///capture.webp" },
                        ]);
                        assert.equal(await page.locator("[data-compose-attachments] > li").count(), 0);

                        checkBrowser();
                        await context.close();
                    });
                } finally {
                    await browser.close();
                }
            });
        }
    } finally {
        await Promise.all([bodyFixture.server.close(), appFixture.server.close()]);
    }
}
