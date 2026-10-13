import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ESLint } from "eslint";

test("{§web-language} source-only HTML passes the shipped OTM linter without a dictionary", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-web-source-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "index.html"), '<!doctype html><html lang="en"><head><title data-i18n="title">Plurnk</title></head><body><main><h1 data-i18n="greeting">Hello world</h1></main></body></html>');
    const lint = fileURLToPath(new URL("../node_modules/.bin/otm-lint", import.meta.url));
    await promisify(execFile)(process.execPath, [lint, "--check", directory]);
});

test("{§web-authoring} browser lint admits native forms and rejects replacement mechanisms", async () => {
    const lint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
    const source = 'import { on, the } from "on_the_money"; on("form", "submit", "form", (event, form) => { event.preventDefault(); submit(the.form(form)); });';
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
