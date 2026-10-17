import assert from "node:assert/strict";
import aguiSession from "./agui-session.js";
import httpAgentBundle from "./http-agent-bundle.js";
import browserDiagnostics from "./browser-diagnostics.js";

// {§web-agui-conformance} Real commands, standard messages, and the SDK's own replay reducer.
export default async function verifyExecution(browser, base, token, projectRoot, model, t) {
    const context = await browser.newContext();
    const checkBrowser = browserDiagnostics(context);
    try {
        const tab = await context.newPage();
        const mount = await httpAgentBundle();
        await mount(tab, base);
        await tab.goto(base);
        const session = await aguiSession(tab, { token, projectRoot });
        const { start, finish, event, successful, action, observe, detach, prompt } = session;
        try {
            for (const [name, exitCode] of [["execution-success", 0], ["execution-failure", 7]]) {
                await t.test(`{§web-agui-conformance} command exit ${exitCode} retains stdout/stderr live and after refresh`, async () => {
                    const worker = "user";
                    await action(name, worker, "worker.model.set", { selector: "browser" });
                    const before = model.requests.length;
                    await observe(`${name}-live`, name, worker);
                    await start(`${name}-submitter`, { workspace: name, threadId: worker, messages: prompt(name) });
                    await event(`${name}-submitter`, "REASONING_MESSAGE_CONTENT");
                    await observe(`${name}-late`, name, worker);
                    model.release(name);
                    const completed = await Promise.all([`${name}-live`, `${name}-submitter`, `${name}-late`].map(finish));
                    const fresh = await observe(`${name}-fresh`, name, worker);
                    await detach(`${name}-fresh`);

                    for (const result of completed) successful(result);
                    for (const result of [...completed, fresh]) {
                        const { messages } = result;
                        assert.deepEqual(messages.filter(({ role }) => role === "user").map(({ id, role, content }) => ({ id, role, content })), prompt(name));
                        const calls = messages.flatMap(({ toolCalls }) => toolCalls ?? []);
                        assert.deepEqual(calls.map(({ function: fn }) => fn.name), ["sh", "WAIT"],
                            "every authored operation remains visible, including a bodiless WAIT");
                        const [command] = calls;
                        const args = JSON.parse(command.function.arguments);
                        assert.equal(args.body, `printf '${name} stdout\\n'; printf '${name} stderr\\n' >&2; exit ${exitCode}`,
                            "the native call retains the command being executed");
                        const outputs = messages.filter(({ role, toolCallId }) => role === "tool" && toolCallId === command.id);
                        assert.equal(outputs.length, 2, "stdout and stderr answer the command, not a synthetic READ or its start receipt");
                        assert.deepEqual(outputs.map(({ content }) => {
                            const { status, exitCode, terminal, content: output } = JSON.parse(content);
                            return { status, exitCode, terminal, output };
                        }).toSorted((left, right) => left.output.localeCompare(right.output)), [
                            { status: 200, exitCode, terminal: true, output: `${name} stderr\n` },
                            { status: 200, exitCode, terminal: true, output: `${name} stdout\n` },
                        ], "readable output preserves its producer's real exit code, including nonzero exits");
                        assert.equal(messages.findLast(({ role }) => role === "assistant")?.content, `Completed ${name}.`);
                        assert.equal(new Set(messages.map(({ id }) => id)).size, messages.length);
                        assert.deepEqual(messages, fresh.messages, "native live and replay views agree without CUSTOM-row reconstruction");
                    }
                    for (const result of completed) {
                        assert.equal(result.events.at(-1).result?.status, 200,
                            "a completed loop is distinct from the exit code of a command it handled");
                        assert.equal(result.events.some(({ type }) => type === "RUN_ERROR"), false);
                    }
                    assert.equal(model.requests.length, before + 2, "the command and answer take two turns; observation adds no inference");
                    checkBrowser();
                });
            }
            assert.deepEqual(model.errors, []);
            checkBrowser();
        } finally {
            await session.close();
        }
    } finally {
        await context.close();
    }
}
