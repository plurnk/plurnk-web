# @plurnk/plurnk-web

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
