import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ESLint } from "eslint";

test("{§web-contract-checks} the actual web lint command rejects an unresolved specification citation", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-web-contract-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = new URL("../", import.meta.url);
    const { scripts } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, scripts: { "test:lint": scripts["test:lint"] } }));
    await writeFile(join(directory, ".gitignore"), "node_modules/\n");
    await writeFile(join(directory, "broken.js"), `// {${"§"}missing-web-contract}\n`);
    await symlink(fileURLToPath(new URL("node_modules", root)), join(directory, "node_modules"), "dir");
    const run = promisify(execFile);
    await run("git", ["init", "--quiet"], { cwd: directory });
    await assert.rejects(run("npm", ["run", "test:lint"], { cwd: directory }), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Unresolved specification-tag citations/u);
        assert.match(error.stderr, /broken\.js:1/u);
        assert.match(error.stderr, /missing-web-contract/u);
        return true;
    });
});

test("{§web-language} source-only HTML passes the shipped OTM linter without a dictionary", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-web-source-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "index.html"), '<!doctype html><html lang="en"><head><title data-i18n="title">Plurnk</title></head><body><main><h1 data-i18n="greeting">Hello world</h1></main></body></html>');
    const lint = fileURLToPath(new URL("../node_modules/.bin/otm-lint", import.meta.url));
    await promisify(execFile)(process.execPath, [lint, "--check", directory]);
});

test("{§web-authoring} browser lint admits native forms and rejects replacement mechanisms", async () => {
    const lint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
    const source = 'import { on, the } from "on_the_money"; on("form", "submit", "form", (event, form) => { event.preventDefault(); the(form, the.form(form)); });';
    const [valid] = await lint.lintText(source, { filePath: "web/authoring-specimen.js" });
    assert.deepEqual(valid.messages, []);
    for (const [code, rule] of [
        ['on("form", "submit", handler)', "otm/prefer-on"],
        ['document.querySelector("main")', "otm/no-document-query"],
        ['element.textContent = message', "otm/prefer-the-set"],
        ['element.style.display = "none"', "otm/no-style-mutation"],
        ['element.innerHTML = message', "no-unsanitized/property"],
        ['new WebSocket("wss://example.test")', "otm/no-raw-websocket"],
    ]) {
        const [result] = await lint.lintText(code, { filePath: "web/authoring-specimen.js" });
        assert.ok(result.messages.some(({ ruleId, severity }) => ruleId === rule && severity === 2), `${rule}: ${JSON.stringify(result.messages)}`);
    }
});

test("{§web-authoring} all owned JavaScript is checked without imposing browser rules on Node", async () => {
    const lint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
    for (const filePath of ["ai.plurnk/specimen.js", "web/specimen.js", "scripts/specimen.mjs", "test/specimen.js", "vite.config.js"]) {
        for (const [code, rule] of [
            ['var value = 1; console.log(value);', "no-var"],
            ['let value = 1; console.log(value);', "prefer-const"],
            ['try { throw new Error("failed"); } catch (error) {}', "no-empty"],
            ['unbound();', "no-undef"],
        ]) {
            const [result] = await lint.lintText(code, { filePath });
            assert.ok(result.messages.some(({ ruleId, severity }) => ruleId === rule && severity === 2), `${filePath} ${rule}: ${JSON.stringify(result.messages)}`);
        }
    }
    for (const [filePath, code] of [
        ["ai.plurnk/specimen.js", 'import { readFile } from "node:fs/promises"; await readFile(new URL("assets.json", import.meta.url));'],
        ["web/specimen.js", 'console.log(document.documentElement.lang);'],
        ["test/specimen.js", 'const browser = { evaluate: (fn) => fn() }; await browser.evaluate(() => document.title); console.log(process.version);'],
    ]) {
        const [result] = await lint.lintText(code, { filePath });
        assert.deepEqual(result.messages, [], filePath);
    }
    const [browser] = await lint.lintText('console.log(process.env);', { filePath: "web/specimen.js" });
    assert.ok(browser.messages.some(({ ruleId }) => ruleId === "no-undef"), "browser code has no Node environment");
});

test("{§web-authoring} runtime timers need an owner, not a blanket ban on numbers", async () => {
    const lint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
    for (const filePath of ["ai.plurnk/specimen.js", "web/specimen.js"]) {
        const [timer] = await lint.lintText('setInterval(() => console.log("tick"), 1000);', { filePath });
        assert.ok(timer.messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"), filePath);
        const [named] = await lint.lintText('const DISPLAY_SECOND_MS = 1000; setInterval(() => console.log("tick"), DISPLAY_SECOND_MS);', { filePath });
        assert.deepEqual(named.messages, [], filePath);
        const [units] = await lint.lintText('console.log(Date.now() / 1000);', { filePath });
        assert.deepEqual(units.messages, [], "unit conversions are mechanisms");
    }
});

test("{§web-browser-security} browser SDK imports cannot bypass schema initialization", async () => {
    const lint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
    const [result] = await lint.lintText('import { randomUUID } from "@ag-ui/client"; console.log(randomUUID());', { filePath: "web/specimen.js" });
    assert.ok(result.messages.some(({ ruleId }) => ruleId === "no-restricted-imports"));
    const [valid] = await lint.lintText('import { randomUUID } from "./worker-agent.js"; console.log(randomUUID());', { filePath: "web/specimen.js" });
    assert.deepEqual(valid.messages, []);
});
