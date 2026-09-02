import { randomUUID } from "node:crypto";

export interface BrowserSession {
  workspace: string;
  threadId: string;
}

export interface BrowserSessionConstraints {
  workspace?: string;
  threadId?: string;
}

export interface ResolvedSessionRoute {
  session: BrowserSession;
  canonicalPath: string;
}

export class BrowserRouteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BrowserRouteError";
    this.status = status;
  }
}

const decodeSegment = (segment: string): string => {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch (cause) {
    throw new BrowserRouteError(400, `The browser session path is not valid URL encoding: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (value.length === 0 || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new BrowserRouteError(400, "Workspace and Worker path segments must be non-empty single names.");
  }
  return value;
};

const requestedSession = (pathname: string): Partial<BrowserSession> => {
  if (!pathname.startsWith("/")) {
    throw new BrowserRouteError(400, "The browser session path must begin with '/'.");
  }
  const raw = pathname === "/" ? [] : pathname.slice(1).split("/");
  if (raw.at(-1) === "") raw.pop();
  if (raw.length > 2 || raw.some((segment) => segment.length === 0)) {
    throw new BrowserRouteError(404, "Browser session URLs contain exactly a workspace and Worker path segment.");
  }
  const [workspace, threadId] = raw.map(decodeSegment);
  return {
    ...(workspace === undefined ? {} : { workspace }),
    ...(threadId === undefined ? {} : { threadId }),
  };
};

export const assertSessionConstraints = (
  session: BrowserSession,
  constraints: BrowserSessionConstraints,
): void => {
  if (constraints.workspace !== undefined && session.workspace !== constraints.workspace) {
    throw new BrowserRouteError(409, `Workspace ${JSON.stringify(session.workspace)} conflicts with this portal's configured workspace ${JSON.stringify(constraints.workspace)}.`);
  }
  if (constraints.threadId !== undefined && session.threadId !== constraints.threadId) {
    throw new BrowserRouteError(409, `Worker ${JSON.stringify(session.threadId)} conflicts with this portal's configured Worker ${JSON.stringify(constraints.threadId)}.`);
  }
};

export const sessionPath = ({ workspace, threadId }: BrowserSession): string =>
  `/${encodeURIComponent(workspace)}/${encodeURIComponent(threadId)}`;

export const resolveSessionRoute = async (
  pathname: string,
  constraints: BrowserSessionConstraints,
  dependencies: {
    createWorkspace(): Promise<string>;
    createThreadId?(): string;
  },
): Promise<ResolvedSessionRoute> => {
  const requested = requestedSession(pathname);
  if (requested.workspace !== undefined && constraints.workspace !== undefined
    && requested.workspace !== constraints.workspace) {
    throw new BrowserRouteError(409, `Workspace ${JSON.stringify(requested.workspace)} conflicts with this portal's configured workspace ${JSON.stringify(constraints.workspace)}.`);
  }
  if (requested.threadId !== undefined && constraints.threadId !== undefined
    && requested.threadId !== constraints.threadId) {
    throw new BrowserRouteError(409, `Worker ${JSON.stringify(requested.threadId)} conflicts with this portal's configured Worker ${JSON.stringify(constraints.threadId)}.`);
  }

  const workspace = constraints.workspace ?? requested.workspace ?? await dependencies.createWorkspace();
  if (workspace.length === 0) {
    throw new BrowserRouteError(502, "Workspace creation completed without a non-empty name.");
  }
  const threadId = constraints.threadId
    ?? requested.threadId
    ?? (dependencies.createThreadId ?? randomUUID)();
  const session = { workspace, threadId };
  assertSessionConstraints(session, constraints);
  return { session, canonicalPath: sessionPath(session) };
};

export const encodeRuntimeThreadId = (session: BrowserSession): string =>
  JSON.stringify([session.workspace, session.threadId]);

export const decodeRuntimeThreadId = (value: string): BrowserSession => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== "string" || parsed[0].length === 0
      || typeof parsed[1] !== "string" || parsed[1].length === 0) {
      throw new Error("expected [workspace, threadId]");
    }
    return { workspace: parsed[0], threadId: parsed[1] };
  } catch (cause) {
    throw new BrowserRouteError(400, `Invalid browser runtime thread identity: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};
