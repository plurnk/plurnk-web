import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";

export interface PortalConfiguration {
  host: string;
  port: number;
  upstream: URL;
  token?: string;
}

export interface ParsedCommand {
  configuration: PortalConfiguration;
  help: boolean;
  version: boolean;
}

export const USAGE = `usage: npm start -- [options]

Run the source checkout's browser portal against a separately running daemon.

options:
  --host <host>            loopback portal host (default 127.0.0.1)
  --port <port>            portal port (default 10660)
  --env-file <path>        required env layer; repeatable, last wins
  --env-file-if-exists <p> optional env layer; repeatable, last wins
  --help                    show this help
  --version                 show package version

Product invocation:
  Use plurnk web [options]. The plurnk client owns all session and run
  configuration. This private development runner leaves browser routes
  unconstrained and applies cwd when each selected workspace is created.

daemon target:
  PLURNK_AGUI_URL selects the daemon (default http://127.0.0.1:1066)
  PLURNK_AGUI_TOKEN remains inside this portal and never reaches the browser
`;

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

export const resolvePortalAddress = (
  hostOverride: string | undefined,
  portOverride: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { host: string; port: number } => {
  const host = hostOverride ?? env.PLURNK_WEB_HOST ?? "127.0.0.1";
  if (!isLoopback(host)) {
    throw new Error(`--host must be loopback; received ${JSON.stringify(host)}`);
  }
  return {
    host,
    port: positiveInteger(portOverride ?? env.PLURNK_WEB_PORT ?? "10660", "--port"),
  };
};

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
      "env-file": { type: "string", multiple: true },
      "env-file-if-exists": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  loadEnvironment(values["env-file"] ?? [], values["env-file-if-exists"] ?? [], cwd, env);

  const { host, port } = resolvePortalAddress(values.host, values.port, env);
  const upstreamRaw = env.PLURNK_AGUI_URL
    ?? "http://127.0.0.1:1066";
  const upstream = new URL(upstreamRaw);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("PLURNK_AGUI_URL must use http: or https:");
  }
  if (upstream.username.length > 0 || upstream.password.length > 0) {
    throw new Error("PLURNK_AGUI_URL must not contain credentials; use PLURNK_AGUI_TOKEN");
  }

  const token = env.PLURNK_AGUI_TOKEN;
  return {
    configuration: {
      host,
      port,
      upstream,
      ...(token !== undefined && token.length > 0 ? { token } : {}),
    },
    help: values.help === true,
    version: values.version === true,
  };
};
