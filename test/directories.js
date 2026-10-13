import assert from "node:assert/strict";

// {§web-index-documents} The same external cases exercise production, dev and preview.
export default async function verifyDirectories(base) {
    // Compare one representation, not Vite preview's optional GET compression.
    const headers = { "accept-encoding": "identity" };
    for (const [folder, heading] of [["/", "Hello world"], ["/nested/", "Nested document"]]) {
        let document;
        for (const path of [folder, `${folder}index.html`, `${folder}?q=one%2Ftwo&lang=fr`, `${folder}index.html?q=one%2Ftwo`]) {
            const get = await fetch(new URL(path, base), { headers, redirect: "manual" });
            assert.equal(get.status, 200, `GET ${path}`);
            assert.match(get.headers.get("content-type"), /^text\/html/u);
            const body = await get.text();
            assert.ok(body.includes(heading), `${path} selects its own document`);
            document ??= body;
            assert.equal(body, document, `${path} serves the same document bytes`);
            const head = await fetch(new URL(path, base), { headers, method: "HEAD", redirect: "manual" });
            assert.equal(head.status, 200, `HEAD ${path}`);
            assert.equal(head.headers.get("content-type"), get.headers.get("content-type"));
            // RFC 9110 §9.3.2 permits HEAD to omit generation-dependent fields.
            assert.ok([null, get.headers.get("content-length")].includes(head.headers.get("content-length")),
                `${path}: GET ${JSON.stringify(Object.fromEntries(get.headers))}; HEAD ${JSON.stringify(Object.fromEntries(head.headers))}`);
            assert.equal(await head.text(), "");
        }
    }
    for (const path of ["/nested/child.txt", "/nested/child.txt?ignored=1"]) {
        const child = await fetch(new URL(path, base));
        assert.equal(child.status, 200, path);
        assert.match(child.headers.get("content-type"), /^text\/plain/u);
        assert.equal(await child.text(), "Child resource\n");
    }
    for (const path of ["/nested", "/missing/", "/missing/index.html", "/nested/missing.txt", "/nested/missing/", "/nested/child.txt/"]) {
        for (const method of ["GET", "HEAD"]) {
            const missing = await fetch(new URL(path, base), { method, redirect: "manual" });
            assert.equal(missing.status, 404, `${method} ${path}`);
            assert.ok(!(await missing.text()).includes("<h1"), "missing resources never return index HTML");
        }
    }
}
