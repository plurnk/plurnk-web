import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import {
  createBrowserWorkspace,
  resolveBrowserCatalog,
  type BrowserAguiOptions,
} from "./agui.ts";
import { createPlurnkRuntimeHandler, type FetchHandler } from "./copilot.ts";
import { resolvePortalAddress } from "./config.ts";
import {
  BrowserRouteError,
  encodeRuntimeThreadId,
  resolveSessionRoute,
  type BrowserSession,
  type BrowserSessionConstraints,
} from "./session.ts";

export interface BrowserBootstrap {
  runtimeUrl: string;
  agentId: string;
  workspace: string;
  threadId: string;
  runtimeThreadId: string;
  canonicalPath: string;
  workspaceLocked: boolean;
  workerLocked: boolean;
  workspaces: string[];
  workers: string[];
  autoAcceptProposals: boolean;
}

export interface PortalOptions {
  host: string;
  port: number;
  upstream: URL;
  token?: string;
  constraints: BrowserSessionConstraints;
  workspaceProperties: Readonly<Record<string, unknown>>;
  runProperties: Readonly<Record<string, unknown>>;
  prepareSession?(session: BrowserSession, workspaceProperties: Readonly<Record<string, unknown>>): Promise<void>;
  projectPrompt?(prompt: string): BrowserPromptProjection;
  timeoutSec?: number;
  mcpConfiguration?: Readonly<Record<string, string>>;
  autoAcceptProposals: boolean;
  createThreadId?(): string;
  assetRoot?: string;
}

export interface ClientPortalOptions {
  host?: string;
  port?: string;
  upstream: URL;
  token?: string;
  constraints: BrowserSessionConstraints;
  workspaceProperties: Readonly<Record<string, unknown>>;
  runProperties: Readonly<Record<string, unknown>>;
  prepareSession?(session: BrowserSession, workspaceProperties: Readonly<Record<string, unknown>>): Promise<void>;
  projectPrompt?(prompt: string): BrowserPromptProjection;
  timeoutSec?: number;
  mcpConfiguration: Readonly<Record<string, string>>;
  autoAcceptProposals: boolean;
}

export interface BrowserPromptProjection {
  prompt: string;
  runProperties: Readonly<Record<string, unknown>>;
}

const packageVersion = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
export const WEB_CLIENT_ID = `@plurnk/plurnk-web/${packageVersion}`;

export interface RunningPortal {
  origin: string;
  address: { host: string; port: number };
  close(): Promise<void>;
}

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
}

const TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

const securityHeaders = (): Record<string, string> => ({
  "content-security-policy": CSP,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const problem = (status: number, slug: string, title: string, detail: string): Problem => ({
  type: `https://problems.plurnk.xyz/web/${slug}`,
  title,
  status,
  detail,
});

const sendProblem = (response: ServerResponse, value: Problem): void => {
  const body = JSON.stringify(value);
  response.writeHead(value.status, {
    ...securityHeaders(),
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/problem+json; charset=utf-8",
  });
  response.end(body);
};

const sendRedirect = (response: ServerResponse, location: string): void => {
  response.writeHead(302, {
    ...securityHeaders(),
    "cache-control": "no-store",
    "content-length": "0",
    location,
  });
  response.end();
};

const originHost = (host: string): string => host.includes(":") ? `[${host}]` : host;

const requestOrigin = (request: IncomingMessage): string | null => {
  const host = request.headers.host;
  if (host === undefined) return null;
  try {
    return new URL(`http://${host}`).origin;
  } catch {
    return null;
  }
};

const streamFile = async (
  request: IncomingMessage,
  response: ServerResponse,
  assetRoot: string,
  pathname: string,
): Promise<void> => {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  if (relative.length === 0 || relative.includes("\0") || relative.includes("\\")) {
    sendProblem(response, problem(400, "invalid-asset-path", "Invalid asset path", "The requested asset path is invalid."));
    return;
  }
  const root = resolve(assetRoot);
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    sendProblem(response, problem(404, "asset-not-found", "Asset not found", "No bundled browser asset exists at that path."));
    return;
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      ...securityHeaders(),
      "cache-control": basename(path) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-length": info.size,
      "content-type": TYPES.get(extname(path)) ?? "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(path).pipe(response);
  } catch {
    sendProblem(response, problem(404, "asset-not-found", "Asset not found", "No bundled browser asset exists at that path."));
  }
};

const requestHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
};

const sendFetchResponse = (
  request: IncomingMessage,
  response: ServerResponse,
  value: Response,
): void => {
  const headers: Record<string, string> = {};
  value.headers.forEach((headerValue, name) => {
    if (name !== "connection" && name !== "transfer-encoding") headers[name] = headerValue;
  });
  Object.assign(headers, securityHeaders());
  response.writeHead(value.status, headers);
  if (request.method === "HEAD" || value.body === null) {
    response.end();
    return;
  }
  response.flushHeaders();
  Readable.fromWeb(value.body as import("node:stream/web").ReadableStream<Uint8Array>)
    .once("error", (cause) => response.destroy(cause as Error))
    .pipe(response);
};

const runCopilotKit = async (
  request: IncomingMessage,
  response: ServerResponse,
  handler: FetchHandler,
  origin: string,
): Promise<void> => {
  const abort = new AbortController();
  const method = request.method ?? "GET";
  request.once("aborted", () => abort.abort());
  response.once("close", () => {
    if (!response.writableEnded) abort.abort();
  });
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: requestHeaders(request),
      signal: abort.signal,
    };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const result = await handler(new Request(new URL(request.url ?? "/", origin), init));
    sendFetchResponse(request, response, result);
  } catch (cause) {
    if (abort.signal.aborted) {
      response.destroy();
      return;
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    sendProblem(response, problem(502, "runtime-unavailable", "PLURNK runtime unavailable", detail));
  }
};

const close = (server: Server): Promise<void> => new Promise((resolveClose, reject) => {
  server.close((cause) => cause === undefined ? resolveClose() : reject(cause));
  server.closeAllConnections();
});

export const startPortal = async (options: PortalOptions): Promise<RunningPortal> => {
  const assetRoot = options.assetRoot ?? new URL("../browser/", import.meta.url).pathname;
  const navigation: BrowserAguiOptions = {
    upstream: options.upstream,
    ...(options.token === undefined ? {} : { token: options.token }),
    workspaceProperties: options.workspaceProperties,
    ...(options.prepareSession === undefined ? {} : { prepareSession: options.prepareSession }),
  };
  const resolveRoute = (pathname: string) => resolveSessionRoute(pathname, options.constraints, {
    createWorkspace: () => createBrowserWorkspace(navigation),
    ...(options.createThreadId === undefined ? {} : { createThreadId: options.createThreadId }),
  });
  let allowedOrigin = "";
  let runtimePromise: Promise<FetchHandler> | undefined;
  const runtime = (): Promise<FetchHandler> => {
    runtimePromise ??= createPlurnkRuntimeHandler(options)
      .catch((cause) => {
        runtimePromise = undefined;
        throw cause;
      });
    return runtimePromise;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const actualOrigin = requestOrigin(request);
      if (actualOrigin === null || actualOrigin !== allowedOrigin) {
        sendProblem(response, problem(421, "host-rejected", "Host rejected", "The request Host does not name this local portal."));
        return;
      }
      const suppliedOrigin = request.headers.origin;
      if (suppliedOrigin !== undefined && suppliedOrigin !== allowedOrigin) {
        sendProblem(response, problem(403, "origin-rejected", "Origin rejected", "The request Origin does not match this local portal."));
        return;
      }
      const url = new URL(request.url ?? "/", allowedOrigin);
      if (url.pathname === "/api/copilotkit" || url.pathname.startsWith("/api/copilotkit/")) {
        await runCopilotKit(request, response, await runtime(), allowedOrigin);
        return;
      }
      if (url.pathname === "/bootstrap.json") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          sendProblem(response, problem(405, "method-not-allowed", "Method not allowed", "Browser bootstrap accepts GET requests only."));
          return;
        }
        const pathname = url.searchParams.get("path");
        if (pathname === null) {
          sendProblem(response, problem(400, "session-path-required", "Session path required", "Browser bootstrap requires the current URL path."));
          return;
        }
        const route = await resolveRoute(pathname);
        const catalog = await resolveBrowserCatalog(navigation, route.session);
        const bootstrap: BrowserBootstrap = {
          runtimeUrl: "/api/copilotkit",
          agentId: "default",
          workspace: route.session.workspace,
          threadId: route.session.threadId,
          runtimeThreadId: encodeRuntimeThreadId(route.session),
          canonicalPath: route.canonicalPath,
          workspaceLocked: options.constraints.workspace !== undefined,
          workerLocked: options.constraints.threadId !== undefined,
          workspaces: catalog.workspaces,
          workers: catalog.workers,
          autoAcceptProposals: options.autoAcceptProposals,
        };
        const body = JSON.stringify(bootstrap);
        response.writeHead(200, {
          ...securityHeaders(),
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json; charset=utf-8",
        });
        response.end(body);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        sendProblem(response, problem(405, "method-not-allowed", "Method not allowed", "Bundled assets are read-only."));
        return;
      }
      if (url.pathname.startsWith("/assets/") || /^\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(url.pathname)) {
        await streamFile(request, response, assetRoot, url.pathname);
        return;
      }
      const route = await resolveRoute(url.pathname);
      if (route.canonicalPath !== url.pathname) {
        sendRedirect(response, route.canonicalPath);
        return;
      }
      await streamFile(request, response, assetRoot, "/index.html");
    })().catch((cause) => {
      if (response.headersSent) response.destroy(cause as Error);
      else if (cause instanceof BrowserRouteError) {
        sendProblem(response, problem(
          cause.status,
          cause.status === 409 ? "session-constraint" : "session-route",
          cause.status === 409 ? "Session constraint conflict" : "Invalid session route",
          cause.message,
        ));
      } else {
        sendProblem(response, problem(500, "portal-failure", "Portal failure", cause instanceof Error ? cause.message : String(cause)));
      }
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    throw new Error("portal did not acquire a TCP address");
  }
  allowedOrigin = `http://${originHost(options.host)}:${address.port}`;
  return {
    origin: allowedOrigin,
    address: { host: options.host, port: address.port },
    close: () => close(server),
  };
};

export const startClientPortal = async (options: ClientPortalOptions): Promise<RunningPortal> => {
  const address = resolvePortalAddress(options.host, options.port);
  const withFrontend = (properties: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
    const settings = properties.settings;
    if (settings !== undefined && (typeof settings !== "object" || settings === null || Array.isArray(settings))) {
      throw new TypeError("plurnk-web requires object-valued workspace settings.");
    }
    return {
      ...properties,
      settings: {
        ...(settings as Readonly<Record<string, unknown>> | undefined),
        client: WEB_CLIENT_ID,
      },
    };
  };
  const workspaceProperties = withFrontend(options.workspaceProperties);
  const runProperties = withFrontend(options.runProperties);
  return await startPortal({
    ...address,
    upstream: options.upstream,
    ...(options.token === undefined ? {} : { token: options.token }),
    constraints: options.constraints,
    workspaceProperties,
    runProperties,
    ...(options.prepareSession === undefined ? {} : { prepareSession: options.prepareSession }),
    ...(options.projectPrompt === undefined ? {} : { projectPrompt: options.projectPrompt }),
    ...(options.timeoutSec === undefined ? {} : { timeoutSec: options.timeoutSec }),
    mcpConfiguration: options.mcpConfiguration,
    autoAcceptProposals: options.autoAcceptProposals,
  });
};
