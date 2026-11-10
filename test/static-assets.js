import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

// {§web-asset-encoding} Inspect wire bytes: fetch transparently decompresses them.
async function response(base, path, method = "GET", encoding) {
    const incoming = await new Promise((resolve, reject) => {
        request(new URL(path, base), {
            method,
            headers: encoding === undefined ? {} : { "accept-encoding": encoding },
        }, resolve).on("error", reject).end();
    });
    return { status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(await Array.fromAsync(incoming)) };
}

export default async function verifyStaticAssets(base, pkgRoot) {
    const inventory = JSON.parse(await readFile(new URL("dist/assets.json", pkgRoot), "utf8"));
    const [path, file] = inventory.find(([path]) => /\/session-[^/]+\.js$/u.test(path));
    const original = await readFile(new URL(`dist/${file}`, pkgRoot));
    for (const [accept, expected] of [
        ["gzip", "gzip"], ["br", "br"], ["BR", "br"],
        [undefined, "identity"], ["", "identity"],
        ["gzip, deflate, br, zstd", "br"],
        ["br;q=0.2, gzip;q=0.8", "gzip"],
        ["identity;q=1, br;q=0.5, gzip;q=0.5", "identity"],
        ["br;q=0, gzip;q=1", "gzip"],
        ["br;q=0, gzip;q=0", "identity"], ["zstd", "identity"],
        ["*", "br"], ["*;q=0.5, br;q=0", "gzip"],
        ["*;q=0, gzip;q=1", "gzip"],
    ]) {
        const get = await response(base, path, "GET", accept);
        assert.equal(get.status, 200, String(accept));
        assert.equal(get.headers["content-encoding"], expected === "identity" ? undefined : expected, String(accept));
        assert.equal(get.headers.vary, "Accept-Encoding");
        assert.equal(get.headers["content-type"], "text/javascript; charset=utf-8");
        assert.equal(get.headers["x-content-type-options"], "nosniff");
        assert.equal(Number(get.headers["content-length"]), get.body.byteLength);
        const decoded = expected === "br" ? brotliDecompressSync(get.body) : expected === "gzip" ? gunzipSync(get.body) : get.body;
        assert.deepEqual(decoded, original);
        if (expected !== "identity") assert.ok(get.body.byteLength < original.byteLength);
        const head = await response(base, path, "HEAD", accept);
        assert.equal(head.status, get.status);
        for (const name of ["content-encoding", "content-type", "content-length", "vary", "x-content-type-options", "cache-control"]) {
            assert.equal(head.headers[name], get.headers[name], `HEAD ${accept}: ${name}`);
        }
        assert.equal(head.body.byteLength, 0);
    }
    for (const accept of ["*;q=0", "br;q=0, gzip;q=0, identity;q=0", "zstd, identity;q=0"]) {
        const get = await response(base, path, "GET", accept);
        assert.equal(get.status, 406, accept);
        assert.equal(get.headers.vary, "Accept-Encoding");
        assert.equal(get.headers["cache-control"], "no-store");
        assert.match(get.body.toString(), /406 Not Acceptable/u);
        const head = await response(base, path, "HEAD", accept);
        assert.equal(head.status, 406);
        assert.equal(head.headers["content-length"], get.headers["content-length"]);
        assert.equal(head.body.byteLength, 0);
    }
    for (const suffix of [".br", ".gz"]) {
        const result = await response(base, `${path}${suffix}`, "GET", "br, gzip");
        assert.equal(result.status, 404, "encoded files are not additional public resources");
        assert.equal(result.headers["content-encoding"], undefined);
    }
    const method = await response(base, path, "POST", "br, gzip");
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, "GET, HEAD");
    for (const path of ["/", "/missing-page"]) {
        const result = await response(base, path, "GET", "br, gzip");
        assert.equal(result.headers["content-encoding"], undefined);
        assert.equal(result.headers["cache-control"], "no-store");
        assert.equal(Number(result.headers["content-length"]), result.body.byteLength);
    }
}
