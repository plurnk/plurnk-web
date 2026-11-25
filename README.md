# @plurnk/plurnk-web

Native OTM browser module for [`@plurnk/plurnk-service`](https://github.com/plurnk/plurnk-service), installed via `optionalDependencies` and mounted at `/` by default (`plurnk web`, `/web`, or `http://127.0.0.1:1066/`; omit with `npm install --omit=optional`). Contract: [`SPEC.md`](SPEC.md). Boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md). Knobs: [`.env.defaults`](.env.defaults).

`@plurnk/plurnk-web` is a pure `/acp` + `/notifications` client: its Node module mounts only static HTML shells, pre-compressed static assets, and stateless `POST /render/mermaid`, with zero server-side workspace/session backdoors or session cookies.

## Routes

| Path | Surface |
| --- | --- |
| `/` | Client arrival (`session/list` over `/acp` to the most recent unarchived root model session, else one newly allocated starter `workspace1#session1`). |
| `/~/<workspace>#<session>` | Singular session workbench: header (`Search` on the left, `Change workspace` switcher + workspace link to `/settings/` in the center, conditional `Sign out` on the right when signed in via OIDC), Google Sheets-style bottom session bar on `>= 768px` (`+`, `☰` archives/sessions, `#session1` tabs in creation order; below `768px`, `☰` sits in `#session-controls` alongside `📎` and `/`), WebSocket ACP v2 live session attachment, Reading Slate scroll framing with floating `↓`, warm-amber non-operator actor bubbles, prompt-top glyph pills, steady composer with `↑`/`↓` prompt history, and inline approval/elicitation forms ([directory addresses](SPEC.md#web-directory-addresses-named-directory-addresses)). |
| `/search/` | Workspace-grouped Search & Directory view (`?q=`, `?workspace=`, `?status=all\|active\|gated\|failed\|archived`) queried over `/acp` (`session/list`) and kept live via `/notifications` SSE (`/~/` `303`-redirects to `/search/`). |
| `/settings/?workspace=<name>` | Dedicated Settings & About page (`Workspace` rename/archive, `Session` title/fork/archive and active-session policy controls, `Models` alias/catalog management, `MCP`, `Skills`, `Schedule`, `Personas`, `Members`, `Environment`, optional host extension tabs via `PLURNK_WEB_SETTINGS_TABS`, `Help` shortcuts/command reference, and `About` version/license diagnostics, with live `/notifications/<workspace>` SSE updates). |
| `/auth/callback` | Browser OIDC Authorization Code + PKCE (`S256`) callback completing token exchange into `localStorage` (`plurnk_oidc_grant`). |
| `/render/mermaid` | Stateless same-origin `POST` compiling Mermaid source to sandboxed SVG via `ondine` worker threads. |

## Deployment & Authentication

| Posture | Configuration |
| --- | --- |
| Loopback / trusted proxy | No OIDC issuer configured: `accessHeaders()` returns `{}` with zero preflight and connects directly to `/acp` and `/notifications` with no `Sign out` control. |
| OIDC resource server | Configure `PLURNK_AUTH_ISSUER` and `PLURNK_AUTH_CLIENT_ID` on the daemon: a `401` on `/acp` discovers `/.well-known/oauth-protected-resource` + OIDC metadata, runs PKCE `S256` to `/auth/callback`, attaches `Authorization: Bearer` (and `?access_token=` on WebSockets), and exposes `Sign out` in the header. |
| Cross-origin / split host | Set `PLURNK_ACP_URL` (e.g. `https://acp.example/acp`): the HTML shell stamps `data-acp-url` and expands `Content-Security-Policy` `connect-src` (`http(s):` + `ws(s):`) and `img-src` automatically while keeping `script-src 'self'`. |
| Installable app | Browser **Install app** / **Add to Home Screen** uses the bundled web manifest (requires localhost HTTP or proxy HTTPS; online-only, no offline service-worker cache). |

## Development

```sh
npm ci --no-audit --no-fund
npm run dev                                        # standalone Vite frontend server
npm run build                                      # compile production assets into dist/
npm test                                           # spec-check, lint, OTM contracts, Chromium/Firefox/WebKit suites
npm run test:candidate -- /path/to/packed-packages # clean-clone packed-tarball + PTY/Playwright gate
```

To serve live `web/` and `src/documents.js` edits directly from a running development daemon without manual builds or daemon restarts, preload `./scripts/dev-loader.mjs`:

```sh
node --conditions=plurnk-dev --import /path/to/plurnk-web/scripts/dev-loader.mjs src/service.ts start
```

### Stylesheet layers (`web/styles/index.css`)

| Layer | Role |
| --- | --- |
| `on_the_money/css/schema` (`@layer schema`) | Classless semantic HTML foundation and `light-dark()` tokens. |
| `on_the_money/css/schemes/green` (`@layer scheme`) | Green palette scheme. |
| `app-structure.css` (`@layer structure`) | Viewport grid, wide desktop reading width, composer sizing, local horizontal scroll. |
| `app-style.css` (`@layer style`) | `#148800` brand accents, system monospace, light/dark conversation surface tokens. |
| `app-state.css` (`@layer state`) | Glyphs, prompt-work pills, active tab & dialog state, connection indicators, focus visibility. |

## License

Code: MIT. Hamster artwork derives from Google Noto Emoji (Apache-2.0); see [`NOTO-NOTICE.txt`](web/public/icons/NOTO-NOTICE.txt).
