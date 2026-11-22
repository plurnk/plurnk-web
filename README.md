# @plurnk/plurnk-web

Native OTM browser module for [`@plurnk/plurnk-service`](https://github.com/plurnk/plurnk-service), installed via `optionalDependencies` and mounted at `/` by default (`plurnk web`, `/web`, or `http://127.0.0.1:1066/`; omit with `npm install --omit=optional`). Contract: [`SPEC.md`](SPEC.md). Boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md). Knobs: [`.env.defaults`](.env.defaults).

## Routes

| Path | Surface |
| --- | --- |
| `/` | Remembered-session arrival (`303` to this browser's last active unarchived session, else most recent unarchived root session, else one newly allocated starter `workspace1#session1`). |
| `/~/<workspace>#<session>` | Singular session workbench: header (`Search` on the left, `Change workspace` switcher + workspace link to `/settings/` in the center, `Account` on the right), Google Sheets-style bottom session bar on `>= 768px` (`+`, `☰` archives/sessions, `#session1` tabs in creation order; below `768px`, `☰` sits in `#session-controls` alongside `📎` and `/`), WebSocket ACP v2 live session attachment, Reading Slate scroll framing with floating `↓`, warm-amber non-operator actor bubbles, prompt-top glyph pills, steady composer with `↑`/`↓` prompt history, and inline approval/elicitation forms ([directory addresses](SPEC.md#web-directory-addresses-named-directory-addresses)). |
| `/settings/?workspace=<name>` | Dedicated Settings page (`Workspace` rename/archive, `Session` title/fork/archive and active-session policy controls, `Models` alias/catalog management, `MCP`, `Skills`, `Schedule`, `Personas`, `Members`, `Environment`, and `Help` shortcuts/command reference, with `Retry` recovery, inline `<details>` creation/edit disclosures, and live `/notifications/<workspace>` SSE updates). |
| `/account/` | Tabbed Account page (`Sign-ins` active browser credential revocation + `Sign out`, and `About` version/support diagnostics). |
| `/search/` | Workspace-grouped Search & Directory page (`Cmd/Ctrl+K`): full-text prompt/title/reply search (`q`, `"Search workspaces and sessions…"`), `status` (`all`, `active`, `gated`, `failed`, `archived`) filter, `Unarchive` actions, child-subagent disclosures, and live `/notifications` SSE updates. |
| `/auth/token` | Same-origin `POST` exchanging the `HttpOnly` browser session cookie for short-lived ACP bearer credentials (refresh grants remain server-side). |

Closing or reloading a page never cancels running work. Passive `/notifications` and WebSocket `/acp` session streams recover automatically across transient network drops and daemon restarts without retrying mutations.

## Session controls & rendering

| Area | Behavior |
| --- | --- |
| Google Sheets-style tabs & settings | On `>= 768px`, `#workspace-tabs` anchors to the bottom edge (`+` opening `#dialog-session-create` with optional session name and title, `☰` sessions & archives, and `#sessionX` tabs in creation order without inline `×` buttons; `< 768px` places `☰` inside `#session-controls` alongside `📎` and `/`), switching inactive `#<session>` tabs in `0ms` from in-document templates while keeping all visited workspace sessions connected over WebSocket `/acp`. Clicking the already-active tab navigates to `/settings/?workspace=<workspace>&session=<session>#session`; clicking `Change workspace` in the header switches workspaces (`🗂️` project-backed, `☁️` folderless), opens `New workspace…` (`workspaceX`, with optional `[ ] Project folder` gated by `PLURNK_WEB_ALLOW_PROJECT_FOLDER`), or links to `Archived workspaces (N)`, and clicking the workspace name or active model opens `/settings/?workspace=<name>` (`Workspace`, `Session`, `Models`, `MCP`, `Skills`, `Schedule`, `Personas`, `Members`, `Environment`, `Help`). `⌘/Ctrl+K` opens `#dialog-workspace-switcher`; `Alt+1…9` / `Alt+[` / `Alt+]` / `Alt+N` switch or create sessions. |
| Steady composer & multi-token autocomplete | Left-anchored status strip (`#<session>` link to `#session` on `< 768px`, `Model` & `Effort` links to `/settings/#session` when configured or `/settings/#models` when unconfigured, live elapsed/descendant/gate telemetry, and `ⓘ` usage/context/cost disclosure), `🐹`/`🔥` Send button driven by durable session `mode` (`Shift+Tab` or `/yolo` toggles `review` and `accept`; `? <prompt>` forces one-turn `review`), progressive multi-token `/` command, argument & `$` skill pill autocomplete (`Tab` or pill click completes each token), `↑`/`↓` prompt history, image paste/drop/attach, `Enter` / `⌘/Ctrl+Enter` send (`Enter` stays newline on touch keyboards), and `Stop` / unfocused `Esc` cancellation. |
| Slash commands | `/help [cmd]`, `/models [search]`, `/model [selector] [effort]`, `/effort [policy]`, `/persona [name]`, `/child [selector\|inherit]`, `/mode [review\|accept\|reject]`, `/workspaces`, `/workspace [name]`, `/rename <name>`, `/sessions`, `/session [name]`, `/fork [name]`, `/parent`, `/enter`, `/older`, `/newer`, `/loops`, `/loop [n]`, `/rollback <coordinate>`, `/share <folder>`, `/update`, `/script <statement>`, `/mcp …`, `/skills …`, `/schedule …`, `/personas …`, `/members …`, `/env …`, `/learn [--scope project\|plurnk] [instructions]`, `/review`, `/accept`, `/reject`, `/cancel`, `/edit <body…>`, `/answer <json>`, `/yolo`, `/stop`. |
| Prompt-top glyph bubbles | User messages and delivered replies stay open as clean chat turns; working operations (`💭` thinking, `🔎` find, `📖` read, `📝` edit, `⚙️` script/MCP, `🗒️` note, `🐜` subagent) accumulate as compact pill badges along the top strip of the triggering user prompt and expand inline with human-readable operands on click. `Load earlier messages` paginates older history on demand. |
| Rich content | Sanitized Markdown with isolated footnotes; client-side [Temml](https://temml.org/) MathML loaded on demand; centered server-side [Ondine](https://github.com/wevm/ondine) Mermaid SVG with automatic light/dark mode contrast compiled in bounded Node worker threads (`PLURNK_WEB_DIAGRAM_*`). Zero browser storage of transcripts or secrets. |

## Authentication, proxy & PWA

| Concern | Configuration |
| --- | --- |
| Operator sign-in | Shared daemon `PLURNK_AUTH=1` (default): local `plurnk web` handoff or `PLURNK_AUTH_PASSWORD_HASH` (`plurnk-service hash-password`); `Account → Sign-ins` revokes one or all other sign-ins and signs out; `Account → About` reports package versions and issue reporting. |
| Reverse proxy | Set `PLURNK_AUTH_ISSUER` to the public HTTPS origin. Run `PLURNK_AUTH=0` only on trusted isolated listeners. |
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
