import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

test("{§web-authoring} browser lint admits native forms and rejects replacement mechanisms", async () => {
    const lint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
    const source = 'import { on, the } from "on_the_money"; on("form", "submit", (event, form) => { event.preventDefault(); submit(the.form(form)); });';
    const [valid] = await lint.lintText(source, { filePath: "web/authoring-specimen.js" });
    assert.deepEqual(valid.messages, []);
    for (const [code, rule] of [
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
