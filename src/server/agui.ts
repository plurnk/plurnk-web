import { randomUUID } from "node:crypto";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import type { BrowserSession } from "./session.ts";

export interface PlurnkAguiTarget {
  upstream: URL;
  token?: string;
}

export interface BrowserAguiOptions extends PlurnkAguiTarget {
  workspaceProperties: Readonly<Record<string, unknown>>;
  prepareSession?(session: BrowserSession): Promise<void>;
}

export interface BrowserCatalog {
  workspaces: string[];
  workers: string[];
}

interface ActionOutcome<T> {
  kind?: unknown;
  ok?: unknown;
  result?: T;
  problem?: { detail?: unknown };
}

const headers = (token: string | undefined): Record<string, string> =>
  token === undefined || token.length === 0
    ? {}
    : { authorization: `Bearer ${token}` };

const actionResult = <T>(event: BaseEvent, kind: string): T | undefined => {
  if (event.type !== "CUSTOM" || event.name !== "plurnk.action.result") return undefined;
  const value = event.value as ActionOutcome<T>;
  if (value.kind !== kind) return undefined;
  if (value.ok === true) return value.result as T;
  if (value.ok === false) {
    const detail = typeof value.problem?.detail === "string"
      ? value.problem.detail
      : `${kind} failed.`;
    throw new Error(detail);
  }
  throw new Error(`${kind} returned an invalid action result.`);
};

export const runAction = async <T>(
  target: PlurnkAguiTarget,
  kind: string,
  params: Readonly<Record<string, unknown>> = {},
  context?: {
    session: BrowserSession;
    workspaceProperties: Readonly<Record<string, unknown>>;
  },
): Promise<T> => {
  const agent = new HttpAgent({
    url: new URL("/", target.upstream).href,
    headers: headers(target.token),
  });
  const input: RunAgentInput = {
    threadId: context?.session.threadId ?? `plurnk-web-bootstrap-${randomUUID()}`,
    runId: randomUUID(),
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {
      plurnk: {
        ...(context === undefined ? {} : {
          workspace: context.session.workspace,
          ...context.workspaceProperties,
        }),
        action: { kind, ...params },
      },
    },
  };

  return await new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    let settled = false;
    agent.run(input).subscribe({
      next: (event) => {
        if (settled) return;
        try {
          const candidate = actionResult<T>(event, kind);
          if (candidate !== undefined) result = candidate;
        } catch (cause) {
          settled = true;
          reject(cause);
        }
      },
      error: (cause) => {
        if (settled) return;
        settled = true;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
      complete: () => {
        if (settled) return;
        settled = true;
        if (result === undefined) {
          reject(new Error(`${kind} completed without plurnk.action.result.`));
          return;
        }
        resolve(result);
      },
    });
  });
};

const nonEmptyName = (value: unknown, operation: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} completed without a non-empty name.`);
  }
  return value;
};

export const createBrowserWorkspace = async (
  options: BrowserAguiOptions,
): Promise<string> => {
  const created = await runAction<{ name?: unknown }>(options, "workspace.create", {
    ...options.workspaceProperties,
  });
  return nonEmptyName(created.name, "workspace.create");
};

export const resolveBrowserCatalog = async (
  options: BrowserAguiOptions,
  session: BrowserSession,
): Promise<BrowserCatalog> => {
  await runAction(options, "workspace.create", {
    name: session.workspace,
    ...options.workspaceProperties,
  });
  const workers = await runAction<{
    workers?: Array<{ name?: unknown }>;
  }>(options, "workspace.workers", {}, {
    session,
    workspaceProperties: options.workspaceProperties,
  });
  await options.prepareSession?.(session);
  const workspaces = await runAction<{
    workspaces?: Array<{ name?: unknown }>;
  }>(options, "workspace.list");

  const workspaceNames = (workspaces.workspaces ?? [])
    .map(({ name }) => nonEmptyName(name, "workspace.list"));
  const workerNames = (workers.workers ?? [])
    .map(({ name }) => nonEmptyName(name, "workspace.workers"));
  return {
    workspaces: workspaceNames.includes(session.workspace)
      ? workspaceNames
      : [...workspaceNames, session.workspace],
    workers: workerNames.includes(session.threadId)
      ? workerNames
      : [...workerNames, session.threadId],
  };
};
