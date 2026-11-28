# @plurnk/plurnk-web

## 5.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-web/issues).

### Upgrade

Upgrade this module, `@plurnk/plurnk-service` (`10.0.0`), and `@plurnk/plurnk` (`10.0.0`) together.

### Major Changes

- **Homomorphic Watch Plane & Single-Pass Overview:** Adopt the `v10.0.0` `GET /notifications` Watch plane (`notifications/snapshot`, `session/replied`, `loop/started.opening`, `loop/started.session`) and single-pass `session/list` overview (`_meta.plurnk.workspaces`, `parentName`, `parentOrigin`, `opening`, `proposals`, `interactions`), retaining active (`running`, `parked`, `queued`) and gated sessions past `limit`, materializing woken omitted sessions inline, replacing raw `log/entry` scraping, and eliminating the `1 + 1 + N + M` `/acp` directory waterfall across `/settings/search` and `#workspace-tabs` (`#179`, `#180`, https://repo.possumtech.com/plurnk/plurnk-service/issues/1601, https://repo.possumtech.com/plurnk/plurnk-service/issues/1602).
- **Service-Tier Cascade, Scope Switcher & Unified `/settings/<section>` Hub:** Adopt the four-tier `host | service | workspace | session` Functionality origin model (`#171`), unify the top bar and settings navigation onto `/settings/<section>` (`#172`), and add per-family scope switching (`Service` vs `Workspace`), `service.config` / `workspace.config` editing, provider credential onboarding (`models.providers`), and multi-key MCP secret management across `service` and `workspace` scopes (`#174`, `#175`).
- **Model Catalog Filtering, Actor Attribution & Packaged Asset Caching:** Add model catalog pricing filters, alert banners, and form ergonomics (`#173`), prefer readable actor `handle` and `name` over opaque OIDC `sub` identifiers in conversation attribution (`#177`), emit `aria-busy="true"` on SSR `#workspace-settings` documents until active-section mounting and hydration settle and reconcile combobox options via `$.reconcile` so async catalog refreshes preserve keyboard `aria-activedescendant` focus (`#178`), and serve packaged static assets through a bounded page cache (`#170`).
- **Dependencies:** Update `dompurify` (`3.5.0`), `marked` (`18.3.0`), `eslint` (`10.16.0`), `stylelint` (`18.1.0`), `stylelint-config-standard` (`41.1.0`), and `vite` (`8.4.0`) (`#176`), and widen `@plurnk/plurnk-acp` (`^4.0.0 || ^5.0.0`) and `@plurnk/plurnk-contracts` (`^10.0.0 || ^11.0.0`) peer dependency ranges for `10.0.0` (`#178`).

## 4.1.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-web/issues).

### Minor Changes

- **Daemon Policy, Branding & Host Extension Tabs:** Reflect daemon confinement policy (`projectRoot`, registered `families`, MCP/skills policy) in Settings and workspace dialogs (`#163`), add configurable brand identity, startup CSS/icons, and About links (`#164`), and support declarative startup-loaded host Settings extension tabs (`#165`).
- **BFF Reverse-Proxy Cookie Auth & Origin Alignment:** Send `credentials: "same-origin"` across HTTP/WS/SSE transports with configurable BFF login/logout handoff (`PLURNK_WEB_AUTH_*`, `#166`), and honor loopback `X-Forwarded-Host` in `sameOriginRequest()` (`POST /render/mermaid`) and `resolveIssuerOrigin()` while ignoring spoofed non-loopback headers (`#168`).
- **UI Architecture & Fixes:** Adopt OTM `$.reconcile` for keyed directory/tab/descendant lists (`#159`), decompose shell HTML templates and CSS into domain partials (`#160`), and preserve quick model dialog effort during `session/options` hydration (`#167`).

## 4.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-web/issues).

### Upgrade

Upgrade this module, `@plurnk/plurnk-service` (`9.0.0`), and `@plurnk/plurnk` (`9.0.0`) together. When deploying standalone or behind a reverse proxy, point `PLURNK_ACP_URL` at the daemon's ACP endpoint and configure external OIDC (`PLURNK_AUTH_*`) instead of retired in-daemon passwords.

### Major Changes

- **Pure ACP v2 Workbench & OIDC PKCE:** Converge on a pure ACP v2 client surface over `PLURNK_ACP_URL` with OIDC PKCE sign-in, `no-store` cache headers on `/acp` and `/auth/token`, linked ACP bodies, and remembered arrival routing (`#143`, `#150`, `#151`, `#152`).
- **Singular Chat Workbench, Settings, & Schedule Panel:** Introduce browser-style session tabs, workspace-grouped `/search/`, `/settings/` tabs and dialogs, interactive `/schedule` macro and receipt inspection, unified multi-token autocomplete and APG comboboxes (`on_the_money@0.16.0`), `turn_queued` status indicators, and full Plurnk Term parity (`#141`, `#142`, `#144`, `#145`, `#146`, `#148`, `#149`, `#153`, `#156`, `#161`).
- **Unified Collection Browsing & Wire Freeze:** Unify search, filtering, and pagination across collection panels with inline `members` preview (`#158`), align camelCase wire projections, `actor` attribution, `child` / `childModel`, `review | accept | reject` approval mode, and erase retired kill-note distillation (`#141`, `#154`, `#157`).
- **Architecture & Dependencies:** Extract shared widgets and decompose web monoliths (`#157`), fix reading-slate scroll anchoring and inter-session inbox reconciliation (`#141`, `#147`), bump `on_the_money` (`0.16.0`), `@agentclientprotocol/sdk` (`2.12.0`), and `@types/node` (`^26.6.7`), and widen `@plurnk/plurnk-meta` (`^3.0.0 || ^4.0.0`), `@plurnk/plurnk-acp` (`^3.0.0 || ^4.0.0`), `@plurnk/plurnk-contracts` (`^9.0.0 || ^10.0.0`), `@plurnk/plurnk-modules` (`^4.3.0 || ^5.0.0`), and `@plurnk/plurnk-spec-check` (`^0.2.0 || ^0.3.0`) ranges for `9.0.0` (`#157`).

## 3.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-web/issues).

### Major Changes

- Erase the retired `Capabilities` workspace modal tab and `/capabilities` slash command (#138, https://repo.possumtech.com/plurnk/plurnk-service/issues/1517).
- Subscribe workspace notification streams via `/notifications/<workspace>`, adopt the discrete notification stream and gate settlement protocol, expose workspace members management, and scope `/learn` target coordinates (#139, #140, https://repo.possumtech.com/plurnk/plurnk-service/issues/1518, https://repo.possumtech.com/plurnk/plurnk-service/issues/1523).
- Widen `@plurnk/plurnk-acp` (`^2.0.0 || ^3.0.0`), `@plurnk/plurnk-contracts` (`^8.0.0 || ^9.0.0`), and `@plurnk/plurnk-meta` (`^2.3.0 || ^3.0.0`) peer and runtime dependency ranges for `8.0.0`, and upgrade `@agentclientprotocol/sdk` (`2.8.0`).

## 2.3.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-web/issues).

### Minor Changes

- Align `/learn` prompt expansion, Markdown fence documentation, and model fixtures with Plurnk `7.0` universal `mcp` tool calls and MCP expressions.
- Widen `@plurnk/plurnk-acp` (`^1.6.0 || ^2.0.0`), `@plurnk/plurnk-contracts` (`^7.5.0 || ^8.0.0`), and `@plurnk/plurnk-meta` (`^2.2.2 || ^2.3.0`) peer and runtime dependency ranges for `7.0.0`, and upgrade `marked` (`18.2.1`) and lockfile dependencies.

## 2.2.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-web/issues).

### Minor Changes

- Add the tabbed workspace session workbench and tab bar, lazy workspace subsystem management modal, and interactive native `/env` configuration panel with family provenance (#121, #124).
- Support verified raster inline images and ordered composer image attachments, and render lazy syntax highlighting through CSS Custom Highlight ranges (#126, #131).
- Adopt `@agentclientprotocol/sdk` `2.7.0` `replay_complete` session replay boundaries and skill command entries, add the live source development daemon module (`scripts/dev-module.mjs`), enable standalone PWA `viewport-fit=cover` safe-area clearance, replace sticky-tail `ResizeObserver` anchoring with `MutationObserver` and viewport resize tracking, and align composer `Shift+Tab` YOLO toggling, `Escape`, and review keyboard shortcuts (#132, #133, #135, #136, #137).

## 2.1.0

> Bare `#N` issue citations reference our private development forge rather than public GitHub issues — our apologies for the opaque provenance; open public bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-web/issues).

### Minor Changes

- Auto-reconnect passive `/notifications` and session observation streams across transient network drops and daemon restarts without retrying mutations or `4xx` refusals (#122).
- Preserve unsent session composer drafts across reloads and navigation in `sessionStorage` (`plurnk:draft:<sessionId>`) until emptied or confirmed accepted (#123).
- Render readable target paths/URIs and semantic unified diffs on file-edit approval proposals (#125).
- Retire `PLURNK_WEB_ENABLED` in favor of npm `optionalDependencies` modularity (`npm install --omit=optional`), align session settings and slash-command verification with live turn-boundary model and effort switching, and retire the `todo` operation, `parseTodoItems` import, `Open tasks` (`data-loop-plan`) loop card, `plan_update` / `plan_removed` synthetic `todo` rows, and stream `lifetime` projection to align with `@plurnk/plurnk-service@6.0.0` and `@plurnk/plurnk-contracts@7.4.0` (#134, https://repo.possumtech.com/plurnk/plurnk-service/issues/1439).
- Decompose `session-agent` into focused state, gate, and translator modules, replace positional HTML splits with named template slots, verify multi-type Mermaid SVG compilation through `ondine`, and prune the README surface (#127, #128, #129).

## 2.0.0

- Statically composable native OTM browser module (`@plurnk/plurnk-web/module`) for Plurnk `6.0+` (#119).
