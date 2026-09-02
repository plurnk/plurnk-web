import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserRouteError,
  decodeRuntimeThreadId,
  encodeRuntimeThreadId,
  resolveSessionRoute,
  sessionPath,
} from "./session.ts";

test("an unrestricted portal fills both missing route coordinates", async () => {
  const created: string[] = [];
  const result = await resolveSessionRoute("/", {}, {
    createWorkspace: async () => {
      created.push("workspace");
      return "world-a";
    },
    createThreadId: () => "thread-a",
  });
  assert.deepEqual(result, {
    session: { workspace: "world-a", threadId: "thread-a" },
    canonicalPath: "/world-a/thread-a",
  });
  assert.deepEqual(created, ["workspace"]);
});

test("a workspace constraint fills only the missing Worker", async () => {
  const result = await resolveSessionRoute("/", { workspace: "fixed-world" }, {
    createWorkspace: async () => assert.fail("the fixed workspace must not be replaced"),
    createThreadId: () => "thread-a",
  });
  assert.deepEqual(result.session, { workspace: "fixed-world", threadId: "thread-a" });
  assert.equal(result.canonicalPath, "/fixed-world/thread-a");
});

test("a Worker constraint tolerates a missing workspace by creating the world first", async () => {
  const result = await resolveSessionRoute("/", { threadId: "fixed-worker" }, {
    createWorkspace: async () => "world-a",
    createThreadId: () => assert.fail("the fixed Worker must not be replaced"),
  });
  assert.deepEqual(result.session, { workspace: "world-a", threadId: "fixed-worker" });
});

test("a complete constraint fixes the canonical session", async () => {
  const result = await resolveSessionRoute("/", {
    workspace: "fixed-world",
    threadId: "fixed-worker",
  }, {
    createWorkspace: async () => assert.fail("nothing is missing"),
    createThreadId: () => assert.fail("nothing is missing"),
  });
  assert.equal(result.canonicalPath, "/fixed-world/fixed-worker");
});

test("an explicit route may select any unconstrained workspace and Worker", async () => {
  const result = await resolveSessionRoute("/research/analyst", {}, {
    createWorkspace: async () => assert.fail("the URL already names a workspace"),
    createThreadId: () => assert.fail("the URL already names a Worker"),
  });
  assert.deepEqual(result.session, { workspace: "research", threadId: "analyst" });
  assert.equal(result.canonicalPath, "/research/analyst");
});

test("a locked coordinate rejects URL substitution", async () => {
  await assert.rejects(
    resolveSessionRoute("/other/thread-a", { workspace: "fixed-world" }, {
      createWorkspace: async () => "unused",
      createThreadId: () => "unused",
    }),
    (cause: unknown) => cause instanceof BrowserRouteError
      && cause.status === 409
      && /workspace/.test(cause.message),
  );
  await assert.rejects(
    resolveSessionRoute("/fixed-world/other", { threadId: "fixed-worker" }, {
      createWorkspace: async () => "unused",
      createThreadId: () => "unused",
    }),
    (cause: unknown) => cause instanceof BrowserRouteError
      && cause.status === 409
      && /Worker/.test(cause.message),
  );
});

test("session paths encode coordinates and runtime keys preserve their pair", () => {
  const session = { workspace: "world one", threadId: "thread-two" };
  assert.equal(sessionPath(session), "/world%20one/thread-two");
  const key = encodeRuntimeThreadId(session);
  assert.deepEqual(decodeRuntimeThreadId(key), session);
  assert.notEqual(
    encodeRuntimeThreadId({ workspace: "another", threadId: "thread-two" }),
    key,
  );
});

test("malformed browser paths and runtime keys fail at their boundary", async () => {
  await assert.rejects(
    resolveSessionRoute("/one/two/three", {}, {
      createWorkspace: async () => "unused",
      createThreadId: () => "unused",
    }),
    (cause: unknown) => cause instanceof BrowserRouteError && cause.status === 404,
  );
  assert.throws(() => decodeRuntimeThreadId("not-json"), /runtime thread identity/);
});
