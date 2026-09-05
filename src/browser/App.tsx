import {
  CopilotChat,
  CopilotKit,
  UseAgentUpdate,
  useAgent,
  useDefaultRenderTool,
  useInterrupt,
  type Interrupt,
  type ReactActivityMessageRenderer,
} from "@copilotkit/react-core/v2";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { McpManager } from "./McpManager.tsx";
import { workerTopology, type WorkerRowLike } from "./topology.ts";
import { newWorkerHref, sessionHref, workspaceHref } from "./navigation.ts";
import { PlainReasoningContent } from "./reasoning.ts";
import { PlanContent, type PlanEntry } from "./plan.ts";

interface BrowserBootstrap {
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
  workerRows: WorkerRowLike[];
  autoAcceptProposals: boolean;
}

interface ModelRoute {
  alias?: string;
  provider: string;
  model: string;
  reasoningPolicy?: string;
}

interface PlurnkState {
  plurnk?: {
    workspace?: { name?: string };
    status?: {
      lifecycle?: string;
      model?: ModelRoute | null;
      packetCount?: number;
      activity?: { message?: string; percent?: number } | null;
    };
  };
  budget?: {
    contextTokens?: number | null;
    contextCapacity?: number | null;
  };
}

interface SurfaceEvent {
  id: string;
  name: string;
  level: "error" | "warn" | "info";
  message: string;
}

const bootstrapSchema = z.object({
  runtimeUrl: z.string().min(1),
  agentId: z.string().min(1),
  workspace: z.string().min(1),
  threadId: z.string().min(1),
  runtimeThreadId: z.string().min(1),
  canonicalPath: z.string().startsWith("/"),
  workspaceLocked: z.boolean(),
  workerLocked: z.boolean(),
  workspaces: z.array(z.string().min(1)),
  workers: z.array(z.string().min(1)),
  workerRows: z.array(z.object({
    id: z.number().nullable(),
    name: z.string().min(1),
    origin: z.string().nullable(),
    parentWorkerId: z.number().nullable(),
    createdAt: z.string().nullable(),
  })),
  autoAcceptProposals: z.boolean(),
});

const planSchema = z.object({
  entries: z.array(z.object({
    content: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    status: z.enum(["pending", "in_progress", "completed"]),
  })),
});

const planRenderer: ReactActivityMessageRenderer<{ entries: PlanEntry[] }> = {
  activityType: "PLAN",
  content: planSchema,
  render: ({ content }) => <PlanContent entries={content.entries} />,
};

const activityRenderers = [planRenderer];

const messageView = {
  reasoningMessage: {
    contentView: PlainReasoningContent,
  },
};

const valueMessage = (value: unknown): string => {
  if (value !== null && typeof value === "object") {
    const candidate = value as { message?: unknown; detail?: unknown };
    if (typeof candidate.message === "string") return candidate.message;
    if (typeof candidate.detail === "string") return candidate.detail;
  }
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
};

const eventLevel = (name: string, value: unknown): SurfaceEvent["level"] => {
  if (name === "plurnk.problem") return "error";
  if (value !== null && typeof value === "object") {
    const level = (value as { level?: unknown }).level;
    if (level === "error" || level === "warn" || level === "info") return level;
  }
  return "info";
};

const InterruptCard = ({
  interrupt,
  resolve,
  cancel,
  autoAcceptProposals,
}: {
  interrupt: Interrupt;
  resolve(payload?: unknown, interruptId?: string): Promise<unknown>;
  cancel(interruptId?: string): Promise<unknown>;
  autoAcceptProposals: boolean;
}) => {
  const proposal = interrupt.id.startsWith("prop:");
  const automaticallyResolved = useRef(false);
  const [body, setBody] = useState("");
  const [payload, setPayload] = useState("{}");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const settle = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  const submitInteraction = (): void => {
    try {
      const parsed = JSON.parse(payload) as unknown;
      void settle(() => resolve(parsed, interrupt.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!proposal || !autoAcceptProposals || automaticallyResolved.current) return;
    automaticallyResolved.current = true;
    setBusy(true);
    void resolve({ decision: "accept" }, interrupt.id).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    });
  }, [autoAcceptProposals, interrupt.id, proposal, resolve]);

  return (
    <section className="interrupt" aria-label={proposal ? "Approval required" : "Input required"}>
      <div className="semantic-label">{proposal ? "Approval required" : "Input required"}</div>
      <p>{proposal && autoAcceptProposals ? "Approving proposal…" : interrupt.message ?? "Review the request before continuing."}</p>
      {proposal ? (
        <>
          {!autoAcceptProposals && (
            <>
              <label>
                Replacement body <span>(optional)</span>
                <textarea value={body} onChange={(event) => setBody(event.target.value)} disabled={busy} />
              </label>
              <div className="interrupt-actions">
                <button disabled={busy} onClick={() => void settle(() => resolve({ decision: "accept", ...(body.length > 0 ? { body } : {}) }, interrupt.id))}>Approve</button>
                <button disabled={busy} onClick={() => void settle(() => resolve({ decision: "reject", ...(body.length > 0 ? { body } : {}) }, interrupt.id))}>Reject</button>
                <button className="quiet" disabled={busy} onClick={() => void settle(() => cancel(interrupt.id))}>Cancel</button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <label>
            JSON response
            <textarea value={payload} onChange={(event) => setPayload(event.target.value)} disabled={busy} />
          </label>
          {interrupt.responseSchema !== undefined && (
            <details>
              <summary>Expected response</summary>
              <pre>{JSON.stringify(interrupt.responseSchema, null, 2)}</pre>
            </details>
          )}
          <div className="interrupt-actions">
            <button disabled={busy} onClick={submitInteraction}>Continue</button>
            <button className="quiet" disabled={busy} onClick={() => void settle(() => cancel(interrupt.id))}>Cancel</button>
          </div>
        </>
      )}
      {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
};

const PresentationBindings = ({ agentId, autoAcceptProposals }: { agentId: string; autoAcceptProposals: boolean }) => {
  useDefaultRenderTool();
  useInterrupt({
    agentId,
    render: ({ interrupt, resolve, cancel }) => interrupt === null
      ? <></>
      : <InterruptCard interrupt={interrupt} resolve={resolve} cancel={cancel} autoAcceptProposals={autoAcceptProposals} />,
  });
  return null;
};

const formatModel = (model: ModelRoute | null | undefined): string => {
  if (model === null || model === undefined) return "model —";
  const name = model.alias ?? `${model.provider}/${model.model}`;
  return model.reasoningPolicy === undefined ? name : `${name} · ${model.reasoningPolicy}`;
};

const StatusBar = ({ agentId, workspace }: { agentId: string; workspace: string }) => {
  const { agent, isReady } = useAgent({
    agentId,
    updates: [UseAgentUpdate.OnStateChanged, UseAgentUpdate.OnRunStatusChanged],
    throttleMs: 100,
  });
  const state = agent.state as PlurnkState;
  const status = state.plurnk?.status;
  const active = state.budget?.contextTokens;
  const capacity = state.budget?.contextCapacity;
  const budget = active !== null && active !== undefined && capacity !== null && capacity !== undefined
    ? `${active.toLocaleString()} / ${capacity.toLocaleString()} tokens`
    : "budget —";
  const activity = status?.activity;
  return (
    <header className="status">
      <strong>plurnk</strong>
      <span>{state.plurnk?.workspace?.name ?? workspace}</span>
      <span>{formatModel(status?.model)}</span>
      <span>{status?.packetCount ?? 0} packets</span>
      <span>{budget}</span>
      <span className={`lifecycle lifecycle-${status?.lifecycle ?? "connecting"}`}>
        {activity?.message ?? (isReady ? status?.lifecycle ?? "idle" : "connecting")}
        {activity?.percent === undefined ? "" : ` · ${Math.round(activity.percent)}%`}
      </span>
    </header>
  );
};

const SessionNavigation = ({ bootstrap }: { bootstrap: BrowserBootstrap }) => {
  const selectWorkspace = (workspace: string): void => {
    window.location.assign(workspaceHref(
      workspace,
      bootstrap.workerLocked ? bootstrap.threadId : undefined,
    ));
  };
  const selectWorker = (threadId: string): void => {
    window.location.assign(sessionHref(bootstrap.workspace, threadId));
  };
  return (
    <nav className="session-navigation" aria-label="PLURNK session">
      <label>
        <span>Workspace</span>
        <select
          aria-label="Workspace"
          value={bootstrap.workspace}
          disabled={bootstrap.workspaceLocked}
          onChange={(event) => selectWorkspace(event.target.value)}
        >
          {bootstrap.workspaces.map((workspace) => (
            <option key={workspace} value={workspace}>{workspace}</option>
          ))}
        </select>
      </label>
      {!bootstrap.workspaceLocked && <a href="/">New workspace</a>}
      <label>
        <span>Worker</span>
        <select
          aria-label="Worker"
          value={bootstrap.threadId}
          disabled={bootstrap.workerLocked}
          onChange={(event) => selectWorker(event.target.value)}
        >
          {workerTopology(bootstrap.workerRows, bootstrap.threadId).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {!bootstrap.workerLocked && (
        <a href={newWorkerHref(bootstrap.workspace)}>New Worker</a>
      )}
    </nav>
  );
};

const EventRail = ({ agentId }: { agentId: string }) => {
  const { agent } = useAgent({ agentId, updates: [] });
  const [events, setEvents] = useState<SurfaceEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name !== "plurnk.problem" && event.name !== "plurnk.notice" && !event.name.startsWith("plurnk.branch")) return;
        const next: SurfaceEvent = {
          id: crypto.randomUUID(),
          name: event.name,
          level: eventLevel(event.name, event.value),
          message: valueMessage(event.value),
        };
        setEvents((current) => [...current.slice(-7), next]);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  if (events.length === 0) return null;
  return (
    <aside className="event-rail" aria-live="polite">
      {events.map((event) => (
        <div className={`surface-event event-${event.level}`} key={event.id}>
          <span>{event.name.replace("plurnk.", "")}</span>
          <p>{event.message}</p>
        </div>
      ))}
    </aside>
  );
};

const Client = ({ bootstrap }: { bootstrap: BrowserBootstrap }) => {
  const [runtimeError, setRuntimeError] = useState<string>();
  return (
    <CopilotKit
      runtimeUrl={bootstrap.runtimeUrl}
      renderActivityMessages={activityRenderers}
      defaultThrottleMs={50}
      onError={({ error }) => setRuntimeError(error.message)}
    >
      <PresentationBindings agentId={bootstrap.agentId} autoAcceptProposals={bootstrap.autoAcceptProposals} />
      <main className="shell">
        <SessionNavigation bootstrap={bootstrap} />
        <StatusBar agentId={bootstrap.agentId} workspace={bootstrap.workspace} />
        <McpManager
          origin={window.location.origin}
          runtimeUrl={bootstrap.runtimeUrl}
          agentId={bootstrap.agentId}
          runtimeThreadId={bootstrap.runtimeThreadId}
        />
        {runtimeError !== undefined && <div className="runtime-error" role="alert">{runtimeError}</div>}
        <EventRail agentId={bootstrap.agentId} />
        <CopilotChat
          agentId={bootstrap.agentId}
          threadId={bootstrap.runtimeThreadId}
          messageView={messageView}
          throttleMs={50}
        />
      </main>
    </CopilotKit>
  );
};

const App = () => {
  const [bootstrap, setBootstrap] = useState<BrowserBootstrap>();
  const [error, setError] = useState<string>();
  const load = async (): Promise<void> => {
    setError(undefined);
    try {
      const url = new URL("/bootstrap.json", window.location.origin);
      url.searchParams.set("path", window.location.pathname);
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { detail?: unknown };
        throw new Error(typeof body.detail === "string" ? body.detail : `Bootstrap failed (${response.status}).`);
      }
      const next = bootstrapSchema.parse(await response.json());
      if (window.location.pathname !== next.canonicalPath) {
        window.history.replaceState(null, "", next.canonicalPath);
      }
      setBootstrap(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (bootstrap !== undefined) return <Client bootstrap={bootstrap} />;
  return (
    <main className="boot">
      <h1>plurnk</h1>
      {error === undefined ? <p>Connecting to the PLURNK daemon…</p> : (
        <>
          <p role="alert">{error}</p>
          <button onClick={() => void load()}>Retry</button>
        </>
      )}
    </main>
  );
};

export default App;
