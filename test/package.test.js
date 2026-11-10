import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { test } from "node:test";

// {§web-package} The installed module resolves only what its manifest declares; hoisting is not a declaration.
test("{§web-package} every package the module imports is a declared dependency", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).toSorted(), [
        "@plurnk/plurnk-acp",
        "@plurnk/plurnk-auth",
        "@plurnk/plurnk-contracts",
        "@plurnk/plurnk-modules",
    ]);
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    const directory = new URL("../src/", import.meta.url);
    const undeclared = [];
    for (const name of (await readdir(directory)).filter((file) => file.endsWith(".js")).toSorted()) {
        const source = await readFile(new URL(name, directory), "utf8");
        for (const [, specifier] of source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"'./][^"']*)["']/gu)) {
            if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
            const pkg = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
            if (!declared.has(pkg)) undeclared.push(`${name}: ${pkg}`);
        }
    }
    assert.deepEqual(undeclared, [], "a runtime import resolves through a declared dependency");
});

test("{§web-package} the package exports its native module and ships root defaults", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(manifest.exports, {
        "./module": "./src/module.js",
        "./package.json": "./package.json",
    });
    assert.ok(manifest.files.includes(".env.defaults"));
    assert.ok(manifest.files.includes("dist/"));
    assert.match(await readFile(new URL("../.env.defaults", import.meta.url), "utf8"), /PLURNK_WEB_ENABLED=/u);
});
