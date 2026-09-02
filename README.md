# plurnk-web

The browser-native client for [PLURNK](https://github.com/plurnk/plurnk-service).
It connects CopilotKit's maintained React client to a separately running PLURNK
daemon through official AG-UI primitives. Every durable fact remains in the
daemon; the local process serves bundled assets and keeps daemon credentials
out of browser code.

Reloads and portal restarts synchronize from the daemon without prompting the
model or creating a turn. If work is already active, the browser observes it;
if an approval is pending, the normal AG-UI interrupt is presented again.

## Status

Early development. The owning implementation plan is
[plurnk-web#1](https://repo.possumtech.com/plurnk/plurnk-web/issues/1).

## Development

```sh
npm install
npm test
npm run dev
```

Install this optional presentation package alongside the PLURNK client, run the
daemon separately, then use the canonical client command:

```sh
npm install -g @plurnk/plurnk @plurnk/plurnk-web
plurnk web --workspace my-project --model fireox --yolo
```

No publication is required for development. After building this checkout,
link it into a sibling `plurnk` checkout and run that client's binary:

```sh
npm install
npm run build
cd ../plurnk
npm link --no-save --package-lock=false ../plurnk-web
npm run build
./bin/plurnk.js web --workspace my-project --model=fireox --yolo
```

`plurnk` remains the only owner of the environment cascade and all workspace,
Worker, model, reasoning, policy, capability, and proposal controls. This
package receives the resolved projection and interprets only its own portal
host and port (`PLURNK_WEB_HOST`, `PLURNK_WEB_PORT`; defaults
`127.0.0.1:10660`). Prompt prefixes, `@path` references, turn and timeout
ceilings, and client-side yolo behavior therefore match the terminal clients.
The portal holds the filtered client MCP declarations so its lazy MCP manager
can discover and deliberately add them without exposing the environment in
browser bootstrap. It never starts or embeds the daemon.

Every ready browser URL is `/<workspace>/<threadId>`. With no configured
workspace or Worker, tabs may select or create either coordinate independently.
`--workspace` locks only the workspace, so tabs may still open many Workers in
that world. `--worker` locks only the Worker name in web mode, and each selected
workspace resolves before that Worker. Supplying both exposes one durable
conversation. Opening the same complete URL opens the same Worker.

## Boundary

- Browser and portal state is presentation state only.
- Workspaces, Workers, Runs, logs, policy, proposals, and accounting remain
  daemon-owned.
- CopilotKit's bounded in-memory Runner is a disposable reconnect projection,
  never a second source of truth.
- All client operations use standard AG-UI events plus documented `plurnk.*`
  extensions.
- No CDN or remote frontend dependency is required at runtime.

MIT licensed.
