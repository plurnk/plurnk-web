import assert from "node:assert/strict";
import { test } from "node:test";
import { newWorkerHref, sessionHref, workspaceHref } from "./navigation.ts";

test("browser navigation preserves workspace and Worker as separate URL coordinates", () => {
  assert.equal(sessionHref("world one", "worker-two"), "/world%20one/worker-two");
  assert.equal(workspaceHref("world one", undefined), "/world%20one");
  assert.equal(workspaceHref("world one", "fixed-worker"), "/world%20one/fixed-worker");
  assert.equal(newWorkerHref("world one"), "/world%20one");
});
