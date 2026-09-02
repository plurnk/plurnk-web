import { randomUUID } from "node:crypto";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import type {
  AgentRunner,
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { defer, map, switchMap, throwError, type Observable } from "rxjs";
import type { PortalOptions } from "./portal.ts";
import {
  assertSessionConstraints,
  decodeRuntimeThreadId,
  type BrowserSession,
} from "./session.ts";

export type FetchHandler = (request: Request) => Promise<Response>;

type RuntimeOptions = Pick<
  PortalOptions,
  "upstream" | "token" | "constraints" | "workspaceProperties" | "runProperties" | "prepareSession"
>;

const daemonHeaders = (token: string | undefined): Record<string, string> =>
  token === undefined || token.length === 0
    ? {}
    : { authorization: `Bearer ${token}` };

class PlurnkAgentRunner implements AgentRunner {
  readonly #delegate: AgentRunner;
  readonly #options: RuntimeOptions;

  constructor(delegate: AgentRunner, options: RuntimeOptions) {
    this.#delegate = delegate;
    this.#options = options;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    let session: BrowserSession;
    try {
      session = this.#session(request.threadId);
    } catch (cause) {
      return throwError(() => cause);
    }
    const forwarded = request.input.forwardedProps as Record<string, unknown> | undefined;
    const plurnk = forwarded?.plurnk as Record<string, unknown> | undefined;
    const agent = request.agent.clone();
    agent.threadId = session.threadId;
    return defer(() => this.#prepare(session)).pipe(
      switchMap(() => this.#delegate.run({
        ...request,
        agent,
        input: {
          ...request.input,
          threadId: session.threadId,
          forwardedProps: {
            ...(forwarded ?? {}),
            plurnk: {
              ...(plurnk ?? {}),
              ...this.#options.runProperties,
              workspace: session.workspace,
            },
          },
        },
      })),
      map((event) => this.#browserEvent(event, request.threadId, session)),
    );
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    let session: BrowserSession;
    try {
      session = this.#session(request.threadId);
    } catch (cause) {
      return throwError(() => cause);
    }
    return defer(() => this.#prepare(session)).pipe(
      switchMap(() => this.#delegate.isRunning({ threadId: request.threadId })),
      switchMap((running) => running
        ? this.#delegate.connect(request)
        : this.#synchronize(session)),
      map((event) => this.#browserEvent(event, request.threadId, session)),
    );
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    this.#session(request.threadId);
    return this.#delegate.isRunning(request);
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    this.#session(request.threadId);
    return this.#delegate.stop(request);
  }

  #session(runtimeThreadId: string): BrowserSession {
    const session = decodeRuntimeThreadId(runtimeThreadId);
    assertSessionConstraints(session, this.#options.constraints);
    return session;
  }

  async #prepare(session: BrowserSession): Promise<void> {
    await this.#options.prepareSession?.(session);
  }

  #browserEvent(event: BaseEvent, runtimeThreadId: string, session: BrowserSession): BaseEvent {
    if (!("threadId" in event) || event.threadId !== session.threadId) return event;
    return { ...event, threadId: runtimeThreadId } as BaseEvent;
  }

  #synchronize(session: BrowserSession): Observable<BaseEvent> {
    const agent = new HttpAgent({
      url: new URL("/", this.#options.upstream).href,
      headers: daemonHeaders(this.#options.token),
    });
    const input: RunAgentInput = {
      threadId: session.threadId,
      runId: randomUUID(),
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {
        plurnk: {
          ...this.#options.workspaceProperties,
          workspace: session.workspace,
          mode: "sync",
        },
      },
    };
    return agent.run(input);
  }
}

export const createPlurnkRuntimeHandler = async (
  options: RuntimeOptions,
): Promise<FetchHandler> => {
  process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";
  const {
    CopilotRuntime,
    InMemoryAgentRunner,
    createCopilotRuntimeHandler,
  } = await import("@copilotkit/runtime/v2");
  const agent = new HttpAgent({
    url: new URL("/", options.upstream).href,
    headers: daemonHeaders(options.token),
  });
  const runner = new InMemoryAgentRunner({
    maxThreads: 32,
    maxRunsPerThread: 20,
    maxBytes: 32 * 1024 ** 2,
  });
  const runtime = new CopilotRuntime({
    agents: { default: agent },
    runner: new PlurnkAgentRunner(runner, options),
    forwardHeaders: {
      deny: ["authorization"],
      denyPrefixes: ["x-"],
    },
  });
  return createCopilotRuntimeHandler({
    runtime,
    basePath: "/api/copilotkit",
    activateChannels: false,
  });
};
