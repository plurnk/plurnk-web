import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { test } from "node:test";
import { parseCommand, resolvePortalAddress } from "./config.ts";

test("{§web-invocation} portal defaults come from packaged panels and preserve caller selections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plurnk-web-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const own = parseEnv(await readFile(new URL("../../.env.defaults", import.meta.url), "utf8"));
  const shared = parseEnv(await readFile(new URL(".env.defaults", import.meta.resolve("@plurnk/plurnk-contracts/package.json")), "utf8"));
  const env = { XDG_CONFIG_HOME: root };
  const command = parseCommand([], env, root);
  assert.deepEqual(command.configuration, {
    host: own.PLURNK_WEB_HOST, port: Number(own.PLURNK_WEB_PORT),
    upstream: new URL(`http://${shared.PLURNK_HOST}:${shared.PLURNK_PORT}`),
  });
  assert.deepEqual(resolvePortalAddress(undefined, undefined, {}), {
    host: own.PLURNK_WEB_HOST, port: Number(own.PLURNK_WEB_PORT),
  }, "the product module loads its own floor without a parallel CLI cascade");
  assert.equal(parseCommand([], { XDG_CONFIG_HOME: root, PLURNK_PORT: "12345" }, root).configuration.upstream.href,
    "http://127.0.0.1:12345/", "the shared daemon port controls the development runner's target");
  assert.equal(parseCommand([], { XDG_CONFIG_HOME: root, PLURNK_AGUI_URL: "https://example.test/mcp" }, root).configuration.upstream.href,
    "https://example.test/mcp");
  assert.deepEqual(resolvePortalAddress("localhost", "12346", { PLURNK_WEB_PORT: "12347" }), { host: "localhost", port: 12346 });
  assert.throws(() => resolvePortalAddress(undefined, undefined, { PLURNK_WEB_PORT: "" }), /--port/u,
    "an explicit invalid value is not replaced with a hard-coded fallback");
});

test("{§web-invocation} development env files apply to the supplied environment without mutating the process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plurnk-web-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = { ...process.env };
  await writeFile(join(root, "first.env"), "PLURNK_WEB_PORT=12001\nPLURNK_PORT=12002\n");
  await writeFile(join(root, "second.env"), "PLURNK_WEB_PORT=12003\n");
  const configured = parseCommand(["--env-file", "first.env", "--env-file", "second.env"], { XDG_CONFIG_HOME: root }, root);
  assert.equal(configured.configuration.port, 12003);
  assert.equal(configured.configuration.upstream.port, "12002");
  const changed = [...new Set([...Object.keys(process.env), ...Object.keys(before)])]
    .filter((key) => process.env[key] !== before[key]);
  assert.deepEqual(changed, [], "configuration inspection must not alter process environment keys");
});
