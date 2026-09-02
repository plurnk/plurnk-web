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
npm start
```

The production portal listens on `http://127.0.0.1:10660/` by default and
connects to the PLURNK daemon at `http://127.0.0.1:1066/`. Run the daemon
separately; this client never starts or embeds it. If no workspace is named,
the daemon mints one when the browser first connects.

```sh
plurnk-web --workspace my-project
```

Configuration follows the PLURNK environment cascade. `PLURNK_AGUI_URL` and
`PLURNK_AGUI_TOKEN` select and authenticate the daemon. `PLURNK_WEB_HOST` and
`PLURNK_WEB_PORT` configure the local browser portal.

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
