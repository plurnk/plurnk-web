# @plurnk/plurnk-web

Native OTM browser module for [`@plurnk/plurnk-service`](https://github.com/plurnk/plurnk-service), installed via `optionalDependencies` and mounted at `/` by default (`plurnk web`, `/web`, or `http://127.0.0.1:1066/`; omit with `npm install --omit=optional`). Contract: [`SPEC.md`](SPEC.md). Boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md). Knobs: [`.env.defaults`](.env.defaults).

## Routes

| Path | Surface |
| --- | --- |
| `/` | Live daemon-wide session overview ordered by latest delivered reply (`PLURNK_WEB_OVERVIEW_SESSIONS`, `PLURNK_WEB_OVERVIEW_EXCERPT_CHARS`), client-side filter, and `/notifications` SSE updates. |
| `/~/` | Workspace directory (`☁️` folderless, `🗂️` folder-backed) with `New workspace` `<dialog>`. |
| `/~/<workspace>/` | Live workspace session overview, workspace session tab strip (`#workspace-tabs`), collapsed child trees, `Background work` branch section, and `Rename workspace` / `Archive workspace` / `New session` `<dialog>` actions. |
| `/~/<workspace>@<session>/` | Workspace session tab strip (`#workspace-tabs`), passive ACP v2 session attachment, live transcript, composer, inline approval/elicitation forms, and `Archive session` / `New session` actions ([directory addresses](SPEC.md#web-directory-addresses-named-directory-addresses)). |
| `/auth/token` | Same-origin `POST` exchanging the `HttpOnly` browser session cookie for short-lived ACP bearer credentials (refresh grants remain server-side). |

Navigation never creates state or starts inference; closing or reloading a page never cancels running work. Passive `/notifications` and session observation streams recover automatically across transient network drops and daemon restarts without retrying mutations.

## Session controls & rendering

| Area | Behavior |
| --- | --- |
| Workspace tabs | Daemon-truth `#workspace-tabs` strip (`Overview`, `💬` root, `🔱` fork, and active/gated/failed `🐜` child workers that fold once settled), in-place resident pane switching (up to 3 connected session streams per workspace tab), `< 768px` compact switcher, `⌘/Ctrl+K` quick-switcher `<dialog>`, and `Alt+1…9` / `Alt+[` / `Alt+]` / `Alt+N` chords. |
| Composer | Multiline input (`Enter` or `⌘/Ctrl+Enter` submits on desktop keyboards while `Enter` stays a newline on touch keyboards; `Shift+Enter` and `Ctrl+J` insert newlines; follow-ups allowed while running; `Stop` or unfocused `Esc` cancels active work while preserving unsent draft; `/` focuses composer, `?` opens `/help`). Unsent prompt text survives same-tab reloads and navigation in `sessionStorage` (`plurnk:draft:<sessionId>`) until emptied or confirmed accepted. |
| Slash commands | `/help`, `/models [search]`, `/model [selector] [effort]`, `/effort [policy]`, `/capabilities [json]`, `/mcp …`, `/skills …`, `/schedule …`, `/personas …`, `/env …`, `/learn [instructions]`, `/yolo`, `/stop`. |
| Approval & input | Manual review by default (`PLURNK_WEB_YOLO=0`) with readable target paths/URIs and semantic unified diffs on file-edit proposals. `🔥 YOLO` / `🐹 Review`, `/yolo`, or `Shift+Tab` toggles per-visit auto-approval (plain-HTTP non-localhost and cross-site navigations force manual review). Questions and MCP elicitations render schema-driven native controls or JSON editors. |
| History & disclosures | User messages and delivered replies start open; `note`, tool receipts, and completed reasoning (`PLURNK_WEB_REASONING_PREVIEW_CHARS` while live) start folded; `Load previous loop` paginates older history without mutating model context. |
| Rich content | Sanitized Markdown with isolated footnotes; client-side [Temml](https://temml.org/) MathML loaded on demand; server-side [Ondine](https://github.com/wevm/ondine) Mermaid SVG compiled in bounded Node worker threads (`PLURNK_WEB_DIAGRAM_*`). Zero browser storage of transcripts or secrets. |

## Authentication, proxy & PWA

| Concern | Configuration |
| --- | --- |
| Operator sign-in | Shared daemon `PLURNK_AUTH=1` (default) and `PLURNK_PASS` (`Account → Sessions` revokes one or all other sessions; `Sign out` revokes browser + module credentials). |
| Reverse proxy | Set `PLURNK_AUTH_ISSUER` to the public HTTPS origin. Run `PLURNK_AUTH=0` only on trusted isolated listeners. |
| Installable app | Browser **Install app** / **Add to Home Screen** uses the bundled web manifest (requires localhost HTTP or proxy HTTPS; online-only, no offline service-worker cache). |

## Development

```sh
npm ci --no-audit --no-fund
npm run dev                                        # standalone Vite frontend server
npm run build                                      # compile pruned production assets into dist/
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
| `app-vendor.css` | Generated Pico Classless Green substrate. |
| `app-structure.css` | Viewport grid, reading width, composer sizing, local horizontal scroll. |
| `app-style.css` | `#148800` brand accents, system monospace, light/dark conversation surface tokens. |
| `app-state.css` | Glyphs, semantic card states, connection indicators, focus visibility. |

## License

Code: MIT. Hamster artwork derives from Google Noto Emoji (Apache-2.0); see [`NOTO-NOTICE.txt`](web/public/icons/NOTO-NOTICE.txt).
