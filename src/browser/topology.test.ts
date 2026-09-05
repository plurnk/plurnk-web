import assert from "node:assert/strict";
import test from "node:test";
import { workerTopology } from "./topology.ts";

const at = (n: number): string => `2026-09-04T10:0${n}:00Z`;
const rows = [
  { id: 5, name: "plurnk", origin: "_plurnk", parentWorkerId: null, createdAt: at(0) },
  { id: 1, name: "main", origin: "model", parentWorkerId: null, createdAt: at(1) },
  { id: 2, name: "main-fork", origin: "model", parentWorkerId: 1, createdAt: at(2) },
  { id: 4, name: "guesser1", origin: "model", parentWorkerId: 1, createdAt: at(3) },
  { id: 3, name: "recheck", origin: "model", parentWorkerId: 2, createdAt: at(4) },
  { id: 9, name: "stray", origin: "model", parentWorkerId: 404, createdAt: at(5) },
];

test("the bound conversation's tree heads the selector, marked, with connectors; an orphan parent stands as a root", () => {
  assert.deepEqual(workerTopology(rows, "main").map((option) => option.label), [
    "● main", "├─ ○ main-fork", "│  └─ ○ recheck", "└─ ○ guesser1", "○ plurnk", "○ stray",
  ]);
  assert.deepEqual(workerTopology(rows, "main").map((option) => option.value), ["main", "main-fork", "recheck", "guesser1", "plurnk", "stray"]);
});

test("a bound descendant keeps its root first and is the only marked row", () => {
  const labels = workerTopology(rows, "recheck").map((option) => option.label);
  assert.equal(labels[0], "○ main");
  assert.equal(labels[2], "│  └─ ● recheck");
  assert.equal(labels.filter((label) => label.includes("●")).length, 1);
});

test("an unminted thread appears as a plain root without lineage", () => {
  const options = workerTopology([{ name: "fresh", origin: null, parentWorkerId: null, createdAt: null }], "fresh");
  assert.deepEqual(options, [{ value: "fresh", label: "● fresh" }]);
});
