import { useState } from "react";
import { runBrowserAction, type BrowserActionTarget } from "./action.ts";

interface McpDefinition {
  name?: string;
  transport?: string;
  command?: string;
  url?: string;
}

interface McpState {
  alias: string;
  origin: "service" | "worker";
  state: "disabled" | "active" | "unavailable" | "authorization-required";
  definition?: McpDefinition;
  detail?: { tools?: string[] };
  problem?: { detail?: string };
  authorization?: { url?: string };
}

interface McpCandidate {
  alias?: string;
  summary?: string;
  definition: McpDefinition;
}

interface McpManagerProps extends BrowserActionTarget {}

const targetOf = (definition: McpDefinition | undefined): string =>
  definition?.transport === "http"
    ? definition.url ?? "http"
    : definition?.command ?? definition?.transport ?? "unknown";

export const McpManager = (props: McpManagerProps) => {
  const [definitions, setDefinitions] = useState<McpState[]>([]);
  const [candidates, setCandidates] = useState<McpCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const listed = await runBrowserAction<{ definitions?: McpState[] }>(props, "worker.mcp.list");
      const discovered = await runBrowserAction<{ candidates?: McpCandidate[] }>(props, "worker.mcp.discover");
      setDefinitions(listed.definitions ?? []);
      setCandidates(discovered.candidates ?? []);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (kind: string, params: Readonly<Record<string, unknown>>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await runBrowserAction(props, kind, params);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const configured = candidates.filter(({ alias }) =>
    alias !== undefined && !definitions.some((entry) => entry.alias === alias));

  return (
    <details className="mcp-manager" onToggle={(event) => {
      if (event.currentTarget.open && !loaded && !busy) void refresh();
    }}>
      <summary>MCP</summary>
      <div className="mcp-heading">
        <span>Worker tools</span>
        <button className="quiet" disabled={busy} onClick={() => void refresh()}>Refresh</button>
      </div>
      {definitions.length === 0 && configured.length === 0 && loaded && <p>No MCP servers are available.</p>}
      <ul>
        {definitions.map((entry) => (
          <li key={entry.alias}>
            <div>
              <strong>{entry.alias}</strong>
              <span>{entry.state} · {targetOf(entry.definition)}</span>
              {entry.detail?.tools !== undefined && <span>{entry.detail.tools.length} tools</span>}
              {entry.problem?.detail !== undefined && <span className="inline-error">{entry.problem.detail}</span>}
              {entry.authorization?.url !== undefined && <a href={entry.authorization.url} target="_blank" rel="noreferrer">Authorize</a>}
            </div>
            <div className="mcp-actions">
              {entry.state === "active" ? (
                <button className="quiet" disabled={busy} onClick={() => void mutate("worker.mcp.disable", { alias: entry.alias })}>Disable</button>
              ) : (
                <button disabled={busy} onClick={() => void mutate("worker.mcp.enable", { alias: entry.alias })}>Enable</button>
              )}
              {entry.origin === "worker" && (
                <button className="quiet" disabled={busy} onClick={() => void mutate("worker.mcp.remove", { alias: entry.alias })}>Remove</button>
              )}
            </div>
          </li>
        ))}
        {configured.map((candidate) => (
          <li key={`candidate:${candidate.alias}`}>
            <div>
              <strong>{candidate.alias}</strong>
              <span>configured · {candidate.summary ?? targetOf(candidate.definition)}</span>
            </div>
            <button disabled={busy} onClick={() => void mutate("worker.mcp.add", {
              alias: candidate.alias,
              definition: candidate.definition,
            })}>Add</button>
          </li>
        ))}
      </ul>
      {busy && <p>Updating MCP servers…</p>}
      {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
    </details>
  );
};
