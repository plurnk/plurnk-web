import { randomUUID } from "node:crypto";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import type {
  AgentRunner,
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { defer, map, Observable, switchMap, throwError } from "rxjs";
import type { PortalOptions } from "./portal.ts";
import { runAction } from "./agui.ts";
import {
  assertSessionConstraints,
  decodeRuntimeThreadId,
  type BrowserSession,
} from "./session.ts";

export type FetchHandler = (request: Request) => Promise<Response>;

type RuntimeOptions = Pick<
  PortalOptions,
  "upstream" | "token" | "constraints" | "workspaceProperties" | "runProperties" | "prepareSession" | "projectPrompt" | "timeoutSec" | "mcpConfiguration"
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
    let input: RunAgentInput;
    let promptRun: boolean;
    try {
      session = this.#session(request.threadId);
      ({ input, promptRun } = this.#projectInput(request.input, session));
    } catch (cause) {
      return throwError(() => cause);
    }
    const agent = request.agent.clone();
    agent.threadId = session.threadId;
    agent.messages = input.messages;
    const run = defer(() => this.#prepare(session)).pipe(
      switchMap(() => this.#delegate.run({
        ...request,
        agent,
        input,
      })),
      map((event) => this.#browserEvent(event, request.threadId, session)),
    );
    return this.#withDeadline(run, request.threadId, session, promptRun);
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
    await this.#options.prepareSession?.(session, this.#options.workspaceProperties);
  }

  #projectInput(input: RunAgentInput, session: BrowserSession): { input: RunAgentInput; promptRun: boolean } {
    const forwarded = input.forwardedProps as Record<string, unknown> | undefined;
    const plurnk = forwarded?.plurnk as Record<string, unknown> | undefined;
    const action = this.#projectAction(plurnk?.action);
    const messages = [...input.messages];
    let promptRun = false;
    let dynamic: Readonly<Record<string, unknown>> = {};
    if (input.resume === undefined && action === undefined) {
      const index = messages.findLastIndex((message) => message.role === "user" && typeof message.content === "string");
      if (index >= 0) {
        const message = messages[index]!;
        if (message.role !== "user" || typeof message.content !== "string") {
          throw new Error("prompt selection did not resolve a textual user message");
        }
        const projection = this.#options.projectPrompt?.(message.content as string);
        if (projection !== undefined) {
          messages[index] = { ...message, content: projection.prompt };
          dynamic = projection.runProperties;
        }
        promptRun = true;
      }
    }
    return {
      promptRun,
      input: {
        ...input,
        messages,
        threadId: session.threadId,
        forwardedProps: {
          ...(forwarded ?? {}),
          plurnk: {
            ...(plurnk ?? {}),
            ...this.#options.runProperties,
            ...dynamic,
            workspace: session.workspace,
            ...(action === undefined ? {} : { action }),
          },
        },
      },
    };
  }

  #projectAction(action: unknown): unknown {
    const configuration = this.#options.mcpConfiguration;
    if (
      configuration === undefined
      || typeof action !== "object"
      || action === null
      || Array.isArray(action)
    ) return action;
    const candidate = action as Record<string, unknown>;
    if (
      candidate.kind !== "worker.mcp.discover"
      || candidate.query !== undefined
      || candidate.source !== undefined
    ) return action;
    return { ...candidate, configuration };
  }

  #withDeadline(
    source: Observable<BaseEvent>,
    runtimeThreadId: string,
    session: BrowserSession,
    enabled: boolean,
  ): Observable<BaseEvent> {
    const timeoutSec = this.#options.timeoutSec;
    if (!enabled || timeoutSec === undefined || timeoutSec <= 0) return source;
    return new Observable<BaseEvent>((subscriber) => {
      let settled = false;
      let backstop: ReturnType<typeof setTimeout> | undefined;
      const clear = (): void => {
        clearTimeout(deadline);
        if (backstop !== undefined) clearTimeout(backstop);
      };
      const deadline = setTimeout(() => {
        void runAction(this.#options, "loop.cancel", { reason: "client_timeout" }, {
          session,
          workspaceProperties: this.#options.workspaceProperties,
        }).catch((cause: unknown) => {
          if (!settled) subscriber.error(cause);
        });
        backstop = setTimeout(() => {
          void this.#delegate.stop({ threadId: runtimeThreadId }).catch((cause: unknown) => {
            if (!settled) subscriber.error(cause);
          });
        }, 15_000);
      }, timeoutSec * 1000);
      const subscription = source.subscribe({
        next: (event) => subscriber.next(event),
        error: (cause) => {
          settled = true;
          clear();
          subscriber.error(cause);
        },
        complete: () => {
          settled = true;
          clear();
          subscriber.complete();
        },
      });
      return () => {
        settled = true;
        clear();
        subscription.unsubscribe();
      };
    });
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
