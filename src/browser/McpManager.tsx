import { useState } from "react";
import type { BrowserActionTarget } from "./action.ts";
import { discoverMcp, listMcp, mutateMcp } from "./mcp.ts";

const toolCount = (detail: object | undefined): number | undefined =>
  detail !== undefined && "tools" in detail && Array.isArray(detail.tools) ? detail.tools.length : undefined;

export const McpManager = (props: BrowserActionTarget) => {
  const [definitions, setDefinitions] = useState<Awaited<ReturnType<typeof listMcp>>["definitions"]>([]);
  const [candidates, setCandidates] = useState<Awaited<ReturnType<typeof discoverMcp>>["candidates"]>([]);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const listed = await listMcp(props);
      setDefinitions(listed.definitions);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const search = async (): Promise<void> => {
    if (query.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    setCandidates([]);
    setSearched(false);
    try {
      const discovered = await discoverMcp(props, query.trim());
      setCandidates(discovered.candidates);
      setSearched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (mutation: Parameters<typeof mutateMcp>[1]): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await mutateMcp(props, mutation);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <details className="mcp-manager" onToggle={(event) => {
      if (event.currentTarget.open && !loaded && !busy) void refresh();
    }}>
      <summary>MCP</summary>
      <div className="mcp-heading">
        <span>Workspace tools</span>
        <button className="quiet" disabled={busy} onClick={() => void refresh()}>Refresh</button>
      </div>
      {definitions.length === 0 && loaded && <p>No MCP servers are configured.</p>}
      <ul>
        {definitions.map((entry) => (
          <li key={entry.alias}>
            <div>
              <strong>{entry.alias}</strong>
              <span>{[entry.state, entry.definition?.type, entry.origin].filter(Boolean).join(" · ")}</span>
              {toolCount(entry.detail) !== undefined && <span>{toolCount(entry.detail)} tools</span>}
              {entry.problem?.detail !== undefined && <span className="inline-error">{entry.problem.detail}</span>}
              {entry.authorization?.url !== undefined && <a href={entry.authorization.url} target="_blank" rel="noreferrer">Authorize</a>}
            </div>
            <div className="mcp-actions">
              {entry.state !== "disabled" ? (
                <button className="quiet" disabled={busy} onClick={() => void mutate({ verb: "disable", alias: entry.alias })}>Disable</button>
              ) : (
                <button disabled={busy} onClick={() => void mutate({ verb: "enable", alias: entry.alias })}>Enable</button>
              )}
              {entry.origin === "workspace" && (
                <button className="quiet" disabled={busy} onClick={() => void mutate({ verb: "remove", alias: entry.alias })}>Remove</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label>
          Search MCP Registry
          <input value={query} onChange={(event) => setQuery(event.target.value)} disabled={busy} />
        </label>
        <button disabled={busy || query.trim().length === 0}>Search</button>
      </form>
      {searched && candidates.length === 0 && <p>No registry matches.</p>}
      <ul>
        {candidates.map((candidate, index) => (
          <li key={`${candidate.provenance.reference ?? candidate.alias}:${index}`}>
            <div>
              <strong>{candidate.alias ?? candidate.definition.name}</strong>
              <span>{candidate.summary ?? candidate.definition.type}</span>
            </div>
            <button disabled={busy || definitions.some(({ alias }) => alias === candidate.alias)} onClick={() => void mutate({
              verb: "add",
              ...(candidate.alias === undefined ? {} : { alias: candidate.alias }),
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
