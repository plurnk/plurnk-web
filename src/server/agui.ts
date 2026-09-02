import { randomUUID } from "node:crypto";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";

export interface PlurnkAguiTarget {
  upstream: URL;
  token?: string;
}

export interface BrowserSessionOptions extends PlurnkAguiTarget {
  workspace?: string;
  worker?: string;
  projectRoot: string | null;
}

export interface BrowserSession {
  workspace: string;
  threadId: string;
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
): Promise<T> => {
  const agent = new HttpAgent({
    url: new URL("/", target.upstream).href,
    headers: headers(target.token),
  });
  const input: RunAgentInput = {
    threadId: `plurnk-web-bootstrap-${randomUUID()}`,
    runId: randomUUID(),
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: { plurnk: { action: { kind, ...params } } },
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

export const resolveBrowserSession = async (
  options: BrowserSessionOptions,
): Promise<BrowserSession> => {
  if (options.workspace !== undefined) {
    return {
      workspace: options.workspace,
      threadId: options.worker ?? options.workspace,
    };
  }
  const created = await runAction<{ name?: unknown }>(options, "workspace.create", {
    projectRoot: options.projectRoot,
  });
  if (typeof created.name !== "string" || created.name.length === 0) {
    throw new Error("workspace.create completed without a non-empty workspace name.");
  }
  return { workspace: created.name, threadId: created.name };
};
