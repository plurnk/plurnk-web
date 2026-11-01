import assert from "node:assert/strict";
import SessionAgent from "../web/session-agent.js";

export async function observeMessages(sessionId, origin, headers) {
    const observer = new SessionAgent({ url: new URL("/acp", origin).href, sessionId, headers });
    const controller = new AbortController();
    let messages;
    await observer.connectAgent({ abortController: controller }, {
        onMessagesSnapshot: ({ snapshot }) => { messages = snapshot.messages; controller.abort(); },
    }).catch(() => {});
    assert.ok(messages, "passive SDK observation returns the durable conversation");
    return messages;
}

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
