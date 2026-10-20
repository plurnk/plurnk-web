import assert from "node:assert/strict";

// {§web-result-bodies} Read the standard reference for content assertions; never mutate SDK messages.
export async function inspectResult(content, token, origin) {
    if (typeof content === "string") return JSON.parse(content);
    assert.equal(content.length, 2);
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "document");
    assert.equal(content[1].source.type, "url");
    const receipt = JSON.parse(content[0].text);
    assert.equal(Object.hasOwn(receipt, "content"), false, "the body must not also travel inline");
    const url = new URL(content[1].source.value);
    assert.equal(url.origin, new URL(origin).origin);
    const response = await fetch(url, { headers: token === undefined ? {} : { Authorization: `Bearer ${token}` }, redirect: "error" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { ...receipt, content: await response.text() };
}

// Exercise the shipped Read body control when a browser assertion needs the full result.
export async function inspectRenderedResults(page) {
    const results = [];
    for (const row of await page.locator('[data-message-role="tool"]').all()) {
        const receipt = JSON.parse(await row.locator("[data-message-body] > pre > code").textContent());
        const body = row.locator("[data-body-reference]");
        if (await body.count()) {
            if (await body.getAttribute("data-body-state") !== "loaded") {
                await body.getByRole("button", { name: "Read body", exact: true }).click();
                await body.locator('[data-body-content]').waitFor({ state: "visible" });
            }
            receipt.content = await body.locator("[data-text=body-content]").textContent();
        }
        results.push(receipt);
    }
    return results;
}
