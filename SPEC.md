# plurnk-web specification

## Architecture

§web-client-boundary **`plurnk-web` is an AG-UI client, never a daemon.** It
owns browser presentation and a foreground local portal. `plurnk-service` owns
all durable runtime state and executes every operation.

```mermaid
flowchart LR
    Browser[CopilotKit React client] <-->|same-origin CopilotKit runtime API| Portal[plurnk-web portal]
    Portal -->|official HttpAgent over AG-UI HTTP/SSE| Daemon[plurnk-service]
```

| Component | Owned responsibility |
|---|---|
| Browser application | CopilotKit chat/run UX, multiline input, review controls, PLURNK semantic renderers |
| Local portal | Static assets, local admission perimeter, CopilotKit runtime bridge, daemon credential |
| PLURNK daemon | Workspaces, Workers, Runs, log, policy, execution, accounting, model lifecycle |

§web-one-wire **The daemon's public AG-UI+ endpoint is the sole runtime
interface.** CopilotKit's official `HttpAgent` carries normal messages,
standard interrupt resumes, and namespaced management actions as
`RunAgentInput` over HTTP/SSE. The portal adds no PLURNK runtime RPC and does
not translate PLURNK state outside that public event stream.

§web-copilot-projection The CopilotKit runtime is a presentation bridge, not a
second agent runtime. Its bounded in-memory Runner retains only disposable
active-Run state. A same-process reconnect observes that Run through the stock
CopilotKit path. Otherwise, the Runner starts an inference-free AG-UI
synchronization Run and renders the daemon's authoritative
`MESSAGES_SNAPSHOT`; it never becomes durable truth, executes a model, or owns
a tool.

§web-state-authority **Browser storage is never runtime authority.** A reload
reattaches using daemon discovery, replay, and log actions. Browser storage may
retain only presentation preferences and the names of the last selected
workspace and Worker.

## Invocation and configuration

§web-invocation The installed `plurnk-web` executable starts one foreground
portal, prints its URL, and remains attached to the terminal until interrupted.
It does not start the daemon or open a network listener other than its own
portal.

| Input | Default | Meaning |
|---|---:|---|
| `--host`, `PLURNK_WEB_HOST` | `127.0.0.1` | Portal bind host; only loopback is admitted |
| `--port`, `PLURNK_WEB_PORT` | `10660` | Portal TCP port |
| `--workspace`, `PLURNK_CLIENT_WORKSPACE` | unset | Initial workspace name |
| `--worker`, `PLURNK_CLIENT_WORKER` | unset | Initial conversation Worker name |
| `--project-root`, `PLURNK_CLIENT_PROJECT_ROOT` | current directory | Create-time workspace root |
| `PLURNK_AGUI_URL` | assembled from `PLURNK_HOST:PLURNK_PORT` | Daemon AG-UI endpoint |
| `PLURNK_AGUI_TOKEN` | unset | Daemon bearer retained only by the portal |

The environment cascade, highest precedence first, is shell values, repeated
explicit env files, project `.env`, the shared XDG PLURNK `.env`, then packaged
`.env.defaults`. Loading is set-if-unset, so higher layers cannot be replaced by
lower ones.

## Local security perimeter

§web-local-perimeter The default portal is deliberately local:

- only loopback bind addresses are accepted;
- `Host` must name the bound local origin;
- a supplied `Origin` must exactly match that origin;
- mutation uses same-origin `POST` only;
- browser assets receive a restrictive Content Security Policy;
- daemon authorization is added by the portal and never serialized into an
  asset, URL, response, or browser-readable bootstrap value;
- browser authorization and `x-*` headers are not forwarded to the daemon;
- CopilotKit and browser assets are bundled rather than loaded from a CDN.

Non-loopback service is not a relaxed flag on this contract. A remotely exposed
portal needs a separately specified authentication and admission perimeter.

## Browser session

§web-session One selected workspace and conversation Worker define the active
browser session. An explicit workspace is used verbatim. Without one, the
portal asks the daemon to mint a workspace through `workspace.create` when the
browser first requests its bootstrap. An explicit Worker names the CopilotKit
thread; otherwise the workspace name does. Reload and reconnect use that same
durable daemon identity.

§web-run A user prompt produces an official AG-UI Run. The browser consumes:

| Semantic | Wire representation |
|---|---|
| Run lifecycle | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` |
| Reattach | `MESSAGES_SNAPSHOT` |
| PLAN | `ACTIVITY_SNAPSHOT` with `activityType: "PLAN"` |
| Reasoning | standard `REASONING_*` lifecycle |
| Operations | standard tool calls plus full `CUSTOM plurnk.row` projection |
| Speech | standard text-message lifecycle |
| Gauge | `STATE_SNAPSHOT` and `STATE_DELTA` |
| Exact failures and notices | `CUSTOM plurnk.problem`, `CUSTOM plurnk.notice` |
| Terminal accounting | `CUSTOM plurnk.terminated` |

§web-reattach Browser connection is a request for current conversation truth,
not permission to infer. If the portal has no active in-memory Run for the
selected thread, its Runner sends an empty AG-UI Run with
`forwardedProps.plurnk.mode = "sync"`. The daemon replays durable messages,
re-presents a pending interrupt, observes independently-owned live work, or
finishes immediately when idle. Reloading the browser or restarting the portal
therefore creates no prompt, turn, or model request.

§web-interrupt Client-owned proposals and interactions use standard AG-UI
interrupt outcomes and `RunAgentInput.resume`. The browser never calls a private
resolution endpoint or reconstructs proposal ownership from operation traits.

§web-cancellation Cancelling aborts the active AG-UI Run. The daemon remains
the owner of cancellation and its resulting terminal truth.

## Presentation

§web-presentation The browser presents PLURNK as a structured operation log,
not a flattened transcript. CopilotKit owns generic text, reasoning, tool, and
run presentation. Small PLURNK renderers preserve PLAN, status and budget,
Problems and Notices, and standard interrupt controls as distinct semantics.
Host-native responsive layout may differ from terminal and Neovim without
changing their meaning.

Markdown rendering does not execute embedded HTML. Browser assets are bundled;
there are no runtime CDN fetches.

## Composition and verification

§web-composition The package is verified in its packed form. Production tests
start the built executable, load built assets, and drive the official AG-UI
client through the portal against a real listener. Source-only or development-
server success is insufficient.

The terminal client's `plurnk web` command discovers and launches this
executable but does not import its presentation. The two clients may share only
presentation-neutral AG-UI session machinery with an explicit public contract.
