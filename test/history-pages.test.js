import assert from "node:assert/strict";
import test from "node:test";
import HistoryPages from "../web/history-pages.js";

const message = (id, content = id) => ({ id, role: "user", content });
const snapshot = (messages, older) => ({ messages, older });
const ids = (history) => history.view().messages.map(({ id }) => id);

test("{§web-session-history} explicit pages preserve chronology and never mutate live input", () => {
    const history = new HistoryPages();
    const live = Object.freeze([Object.freeze(message("c")), Object.freeze(message("d"))]);
    history.snapshot(snapshot(live, "/older/b"), false);
    history.live(live);
    assert.deepEqual(history.view().gaps, [{ url: "/older/b", before: "c" }]);
    history.accept("/older/b", { final: true, messages: [message("b"), message("c", "old")], older: "/older/a" });
    history.accept("/older/a", { final: true, messages: [message("a"), message("b")], older: null });
    assert.deepEqual(ids(history), ["a", "b", "c", "d"]);
    assert.equal(history.view().messages[2].content, "c", "live content wins overlap at its original position");
    assert.deepEqual(history.view().gaps, []);
    assert.deepEqual(live, [message("c"), message("d")]);
    assert.deepEqual(history.mutable(), []);
});

test("{§web-session-history} reconnect exposes a gap without fetching or losing selected pages", () => {
    const history = new HistoryPages();
    history.snapshot(snapshot([message("c")], "/b"), false);
    history.live([message("c")]);
    history.accept("/b", { final: true, messages: [message("b")], older: "/a" });
    history.snapshot(snapshot([message("e")], "/d"), false);
    history.live([message("e")]);
    assert.deepEqual(ids(history), ["b", "e"]);
    assert.deepEqual(history.view().gaps, [{ url: "/a", before: "b" }, { url: "/d", before: "e" }]);
    history.accept("/d", { final: true, messages: [message("d")], older: "/c" });
    history.accept("/c", { final: true, messages: [message("c")], older: "/b" });
    assert.deepEqual(ids(history), ["b", "c", "d", "e"]);
    assert.deepEqual(history.view().gaps, [{ url: "/a", before: "b" }]);
});

test("{§web-session-history} reading pins displaced observations only until returning to the bottom", () => {
    const history = new HistoryPages();
    history.snapshot(snapshot([message("a"), message("b")], null), false);
    history.live([message("a"), message("b")]);
    history.snapshot(snapshot([message("b"), message("c")], "/a"), true);
    history.live([message("b"), message("c")]);
    assert.deepEqual(ids(history), ["a", "b", "c"]);
    assert.deepEqual(history.view().gaps, [], "overlap joins observed material without a fictional gap");
    history.follow();
    assert.deepEqual(ids(history), ["b", "c"]);
    assert.deepEqual(history.view().gaps, [{ url: "/a", before: "b" }]);
});

test("{§web-session-history} late results update an archived call once, then survive its final refetch", () => {
    const history = new HistoryPages();
    const call = { id: "call-message", role: "assistant", toolCalls: [{ toolCallId: "call", name: "READ", rawInput: {} }] };
    const result = { id: "result", role: "tool", toolCallId: "call", content: "live result" };
    history.snapshot(snapshot([message("new")], "/old"), false);
    history.live([message("new")]);
    history.accept("/old", { final: false, messages: [call], older: null });
    assert.deepEqual(history.mutable(), ["/old"]);
    history.live([message("new"), result]);
    assert.deepEqual(ids(history), ["call-message", "result", "new"]);
    history.snapshot(snapshot([message("new")], "/old"), false);
    history.live([message("new")]);
    assert.deepEqual(ids(history), ["call-message", "result", "new"], "a revalidation failure cannot erase an already observed result");
    history.accept("/old", { final: false, messages: [call], older: null });
    assert.deepEqual(ids(history), ["call-message", "result", "new"], "a read begun before the result does not erase it either");
    history.live([message("new"), result]);
    history.accept("/old", { final: true, messages: [call, { ...result, content: "snapshot result" }], older: null });
    assert.deepEqual(ids(history), ["call-message", "result", "new"]);
    assert.equal(history.view().messages[1].content, "live result");
    assert.deepEqual(history.mutable(), []);
    history.snapshot(snapshot([message("newer")], "/new"), false);
    history.live([message("newer")]);
    assert.deepEqual(ids(history), ["call-message", "result", "newer"]);
});

test("{§web-session-history} multiple late receipts preserve their supplied order beside an archived call", () => {
    const history = new HistoryPages();
    const call = { id: "calls", role: "assistant", toolCalls: ["one", "two"].map((toolCallId) => ({ toolCallId, name: "READ", rawInput: {} })) };
    const results = ["one", "two"].map((id) => ({ id: `result-${id}`, role: "tool", toolCallId: id, content: id }));
    history.snapshot(snapshot([message("now")], "/old"), false);
    history.live([message("now")]);
    history.accept("/old", { final: false, messages: [call], older: null });
    history.live([message("now"), ...results]);
    assert.deepEqual(ids(history), ["calls", "result-one", "result-two", "now"]);
});

test("{§web-session-history} abandoned reads and invalid cursor cycles cannot change the view", () => {
    const history = new HistoryPages();
    history.snapshot(snapshot([message("new")], "/old"), false);
    history.live([message("new")]);
    history.snapshot(snapshot([message("newer")], "/later"), false);
    history.live([message("newer")]);
    assert.equal(history.accept("/old", { final: true, messages: [message("old")], older: null }), false);
    assert.deepEqual(ids(history), ["newer"]);
    assert.throws(() => history.accept("/later", { final: true, messages: [], older: "/later" }), /History page repeats its own cursor/u);
    assert.throws(() => history.snapshot(snapshot([], 42), false), /History boundary must be a URL or null/u);
    assert.throws(() => history.snapshot({ messages: [] }, false), /History boundary must be a URL or null/u);
    assert.throws(() => history.live([message("duplicate"), message("duplicate")]), /duplicate message identities/u);
    assert.deepEqual(ids(history), ["newer"]);
});

test("{§web-session-history} a cyclic daemon page chain fails without accepting the page", () => {
    const history = new HistoryPages();
    history.snapshot(snapshot([message("latest")], "/b"), false);
    history.live([message("latest")]);
    history.accept("/b", { final: true, messages: [message("b")], older: "/a" });
    assert.throws(() => history.accept("/a", { final: true, messages: [message("a")], older: "/b" }), /History page cursors form a cycle/u);
    assert.deepEqual(ids(history), ["b", "latest"]);
});
