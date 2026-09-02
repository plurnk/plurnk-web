import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";

export interface PortalConfiguration {
  host: string;
  port: number;
  upstream: URL;
  token?: string;
  workspace?: string;
  worker?: string;
  projectRoot: string | null;
}

export interface ParsedCommand {
  configuration: PortalConfiguration;
  help: boolean;
  version: boolean;
}

export const USAGE = `usage: plurnk-web [options]

Serve the browser-native PLURNK client against a separately running daemon.

options:
  --host <host>            loopback portal host (default 127.0.0.1)
  --port <port>            portal port (default 10660)
  --workspace <name>       initial workspace
  --worker <name>          initial conversation Worker (requires workspace)
  --project-root <path>    create-time workspace root (default cwd; empty = headless)
  --env-file <path>        required env layer; repeatable, last wins
  --env-file-if-exists <p> optional env layer; repeatable, last wins
  --help                    show this help
  --version                 show package version

daemon target:
  PLURNK_AGUI_URL overrides http://$PLURNK_HOST:$PLURNK_PORT
  PLURNK_AGUI_TOKEN remains inside this portal and never reaches the browser
`;

const truthy = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());

const load = (path: string, required: boolean): void => {
  if (!existsSync(path)) {
    if (required) throw new Error(`environment file does not exist: ${path}`);
    return;
  }
  loadEnvFile(path);
};

export const loadEnvironment = (
  required: readonly string[],
  optional: readonly string[],
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): void => {
  // loadEnvFile is set-if-unset. Highest-precedence sources therefore load
  // first, and repeatable flags reverse so their last occurrence wins.
  for (const path of [...required].reverse()) load(resolve(cwd, path), true);
  for (const path of [...optional].reverse()) load(resolve(cwd, path), false);
  load(join(cwd, ".env"), false);
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  load(join(xdg, "plurnk", ".env"), false);
  load(new URL("../../.env.defaults", import.meta.url).pathname, false);
};

const positiveInteger = (raw: string, name: string): number => {
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
};

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);

const nonempty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

export const parseCommand = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ParsedCommand => {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      workspace: { type: "string" },
      worker: { type: "string" },
      "project-root": { type: "string" },
      "env-file": { type: "string", multiple: true },
      "env-file-if-exists": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  loadEnvironment(values["env-file"] ?? [], values["env-file-if-exists"] ?? [], cwd, env);

  const host = values.host ?? env.PLURNK_WEB_HOST ?? "127.0.0.1";
  if (!isLoopback(host)) {
    throw new Error(`--host must be loopback; received ${JSON.stringify(host)}`);
  }
  const port = positiveInteger(values.port ?? env.PLURNK_WEB_PORT ?? "10660", "--port");
  const upstreamRaw = env.PLURNK_AGUI_URL
    ?? `http://${env.PLURNK_HOST ?? "127.0.0.1"}:${env.PLURNK_PORT ?? "1066"}`;
  const upstream = new URL(upstreamRaw);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("PLURNK_AGUI_URL must use http: or https:");
  }
  if (upstream.username.length > 0 || upstream.password.length > 0) {
    throw new Error("PLURNK_AGUI_URL must not contain credentials; use PLURNK_AGUI_TOKEN");
  }

  const workspace = nonempty(values.workspace ?? env.PLURNK_CLIENT_WORKSPACE);
  const worker = nonempty(values.worker ?? env.PLURNK_CLIENT_WORKER);
  if (worker !== undefined && workspace === undefined) {
    throw new Error("--worker requires --workspace (or PLURNK_CLIENT_WORKSPACE)");
  }
  const rootRaw = values["project-root"] ?? env.PLURNK_CLIENT_PROJECT_ROOT;
  const projectRoot = rootRaw === "" ? null : resolve(cwd, rootRaw ?? cwd);
  if (projectRoot !== null && !isAbsolute(projectRoot)) {
    throw new Error("--project-root must resolve to an absolute path");
  }

  const token = nonempty(env.PLURNK_AGUI_TOKEN);
  return {
    configuration: {
      host,
      port,
      upstream,
      ...(token !== undefined ? { token } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(worker !== undefined ? { worker } : {}),
      projectRoot,
    },
    help: values.help === true,
    version: values.version === true || truthy(env.PLURNK_WEB_VERSION),
  };
};
