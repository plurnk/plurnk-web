import { randomUUID } from "node:crypto";
import { HttpAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import type {
  AgentRunner,
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { defer, switchMap, throwError, type Observable } from "rxjs";
import type { PortalOptions } from "./portal.ts";

export type FetchHandler = (request: Request) => Promise<Response>;

type RuntimeOptions = Pick<PortalOptions, "upstream" | "token" | "session" | "runProperties">;

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
    if (request.threadId !== this.#options.session.threadId) {
      return throwError(() => new Error(
        `Thread ${JSON.stringify(request.threadId)} is outside this portal's selected conversation.`,
      ));
    }
    const forwarded = request.input.forwardedProps as Record<string, unknown> | undefined;
    const plurnk = forwarded?.plurnk as Record<string, unknown> | undefined;
    return this.#delegate.run({
      ...request,
      input: {
        ...request.input,
        forwardedProps: {
          ...(forwarded ?? {}),
          plurnk: {
            ...(plurnk ?? {}),
            ...this.#options.runProperties,
            workspace: this.#options.session.workspace,
          },
        },
      },
    });
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    if (request.threadId !== this.#options.session.threadId) {
      return throwError(() => new Error(
        `Thread ${JSON.stringify(request.threadId)} is outside this portal's selected conversation.`,
      ));
    }
    return defer(() => this.#delegate.isRunning({ threadId: request.threadId })).pipe(
      switchMap((running) => running
        ? this.#delegate.connect(request)
        : this.#synchronize(request.threadId)),
    );
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.#delegate.isRunning(request);
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    return this.#delegate.stop(request);
  }

  #synchronize(threadId: string): Observable<BaseEvent> {
    const agent = new HttpAgent({
      url: new URL("/", this.#options.upstream).href,
      headers: daemonHeaders(this.#options.token),
    });
    const input: RunAgentInput = {
      threadId,
      runId: randomUUID(),
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {
        plurnk: {
          workspace: this.#options.session.workspace,
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
