# @plurnk/plurnk-web

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
