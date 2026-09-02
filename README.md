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

`plurnk` remains the only owner of the environment cascade and all workspace,
Worker, model, reasoning, policy, capability, and proposal controls. This
package receives one resolved AG-UI session and interprets only its own portal
host and port (`PLURNK_WEB_HOST`, `PLURNK_WEB_PORT`; defaults
`127.0.0.1:10660`). It never starts or embeds the daemon.

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
