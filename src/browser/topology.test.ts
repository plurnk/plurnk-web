import assert from "node:assert/strict";
import test from "node:test";
import { hop, hopForKey, siblingPosition, workerPath, workerTopology } from "./topology.ts";

const at = (n: number): string => `2026-09-04T10:0${n}:00Z`;
const rows = [
  { id: 5, name: "plurnk", origin: "_plurnk", parentWorkerId: null, createdAt: at(0) },
  { id: 1, name: "main", origin: "model", parentWorkerId: null, createdAt: at(1) },
  { id: 2, name: "main-fork", origin: "model", parentWorkerId: 1, createdAt: at(2) },
  { id: 4, name: "guesser1", origin: "model", parentWorkerId: 1, createdAt: at(3) },
  { id: 3, name: "recheck", origin: "model", parentWorkerId: 2, createdAt: at(4) },
  { id: 9, name: "stray", origin: "model", parentWorkerId: 404, createdAt: at(5) },
];

test("the bound conversation's tree heads the selector, marked, with connectors, siblings newest first; an orphan parent stands as a root", () => {
  assert.deepEqual(workerTopology(rows, "main").map((option) => option.label), [
    "● main", "├─ ○ guesser1", "└─ ○ main-fork", "   └─ ○ recheck", "○ stray", "○ plurnk",
  ]);
  assert.deepEqual(workerTopology(rows, "main").map((option) => option.value), ["main", "guesser1", "main-fork", "recheck", "stray", "plurnk"]);
});

test("a bound descendant keeps its root first and is the only marked row", () => {
  const labels = workerTopology(rows, "recheck").map((option) => option.label);
  assert.equal(labels[0], "○ main");
  assert.equal(labels[3], "   └─ ● recheck");
  assert.equal(labels.filter((label) => label.includes("●")).length, 1);
});

// Topology is navigation (plurnk-service#523): one hop is a full attach; edges name why nothing moved.
test("hops: h climbs, l enters the newest child, j/k walk siblings and wrap, edges say why", () => {
  const name = (bound: string, direction: "parent" | "enter" | "older" | "newer") => {
    const { target, notice } = hop(rows, bound, direction);
    return target === null ? `(${notice})` : target.name;
  };
  assert.equal(name("main", "enter"), "guesser1");
  assert.equal(name("guesser1", "parent"), "main");
  assert.equal(name("guesser1", "older"), "main-fork");
  assert.equal(name("main-fork", "older"), "guesser1", "wraps");
  assert.equal(name("guesser1", "newer"), "main-fork", "wraps the other way");
  assert.equal(name("main-fork", "enter"), "recheck");
  assert.equal(name("recheck", "enter"), "(no children)");
  assert.equal(name("recheck", "older"), "(no siblings)");
  assert.equal(name("main", "parent"), "(at the root: no parent)");
  assert.equal(name("main", "older"), "stray", "root conversations are siblings; the daemon's scratch worker is not a place");
  assert.equal(name("stranger", "enter"), "(no bound worker yet)");
});

test("the lineage path marks the bound worker with ~, and the sibling position is newest first", () => {
  assert.equal(workerPath(rows, "main"), "/~main", "a root is still named; ~ marks where the session is");
  assert.equal(workerPath(rows, "recheck"), "/main/main-fork/~recheck", "a child always shows that it is a child");
  assert.equal(workerPath(rows, "stranger"), "/~stranger", "an unminted thread is still where the session is");
  assert.deepEqual(siblingPosition(rows, "main"), { index: 2, count: 2 }, "stray is newer than main");
  assert.deepEqual(siblingPosition(rows, "guesser1"), { index: 1, count: 2 });
  assert.equal(siblingPosition(rows, "recheck"), null);
});

test("Alt-h/j/k/l map to hops; other modifiers and keys do not", () => {
  const key = (k: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
    hopForKey({ altKey: true, ctrlKey: false, metaKey: false, key: k, ...mods });
  assert.equal(key("h"), "parent");
  assert.equal(key("l"), "enter");
  assert.equal(key("j"), "older");
  assert.equal(key("k"), "newer");
  assert.equal(key("x"), null);
  assert.equal(key("h", { altKey: false }), null);
  assert.equal(key("h", { ctrlKey: true }), null);
});

test("an unminted thread appears as a plain root without lineage", () => {
  const options = workerTopology([{ name: "fresh", origin: null, parentWorkerId: null, createdAt: null }], "fresh");
  assert.deepEqual(options, [{ value: "fresh", label: "● fresh" }]);
});
