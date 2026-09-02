import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";

export interface BrowserActionTarget {
  origin: string;
  runtimeUrl: string;
  agentId: string;
  runtimeThreadId: string;
}

interface ActionOutcome<T> {
  kind?: unknown;
  ok?: unknown;
  result?: T;
  problem?: { detail?: unknown };
}

const actionResult = <T>(event: BaseEvent, kind: string): T | undefined => {
  if (event.type !== "CUSTOM" || event.name !== "plurnk.action.result") return undefined;
  const outcome = event.value as ActionOutcome<T>;
  if (outcome.kind !== kind) return undefined;
  if (outcome.ok === true) return outcome.result as T;
  if (outcome.ok === false) {
    throw new Error(typeof outcome.problem?.detail === "string" ? outcome.problem.detail : `${kind} failed.`);
  }
  throw new Error(`${kind} returned an invalid action result.`);
};

export const runBrowserAction = async <T>(
  target: BrowserActionTarget,
  kind: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<T> => {
  const agent = new HttpAgent({
    url: new URL(`${target.runtimeUrl}/agent/${encodeURIComponent(target.agentId)}/run`, target.origin).href,
  });
  const input: RunAgentInput = {
    threadId: target.runtimeThreadId,
    runId: crypto.randomUUID(),
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: { plurnk: { action: { ...params, kind } } },
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
