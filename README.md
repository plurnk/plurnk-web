# plurnk-web

An optional Plurnk daemon plugin serving native OTM documents at `/`.
Pico Classless Green supplies the styling, with #148800 brand accents and system
monospace typography. It follows the browser's light/dark preference.
Conversation cards use a subtle green user tint, ordinary cards for model replies,
and neutral backgrounds for operations, notes and reasoning.
Requires a current stable browser; no legacy-browser compatibility layer is shipped.
No additional server. The root links to the daemon's workspace
directory at `/~/`; workspace pages list model workers as real links, with native
collapsed child branches and a “Background work” section for branches beneath
internal actors. Bookkeeping workers are omitted. Worker pages show identity,
breadcrumbs, their actual parent, live status and conversation, without a
duplicate page heading. A native message form sends text; Stop explicitly cancels
the worker's current work. Pending operations have native Accept/Reject review forms;
questions and MCP input share the same review and resume path.
The message box also accepts `/help`, `/models [search]`, `/model [selector] [effort]`,
`/effort [policy]`, `/capabilities [json]`, `/yolo`, and `/stop`. Commands never go
to the model: their results appear separately from conversation. Model, effort
and capability changes use daemon actions and retain its validation and active-work
restrictions. `/capabilities` shows service, workspace and effective policy; a JSON
argument replaces the workspace policy. `/yolo` or the 🔥/🐹 status toggle changes only this page's automatic
approval preference, including pending proposals; questions still require answers.
Reload restores the page's starting mode. Commands remain available during pending review.
`/models` lists aliases and a bounded catalog page; narrow its search for more matches.
Click the status model or effort to open its form below the conversation. Model
search offers native suggestions, or accepts an exact alias/provider-model.
Select Model / Select Effort applies the choice and closes the form; Cancel dismisses it.
Workspace cards show the worker's lifecycle, parent/name and workspace at page load.
Click the ant to visit the worker, or expand the card to see its child tree;
parent and workspace links navigate independently. Leaves have no empty disclosure.
These cards are navigation snapshots, not live monitors or completed-reply previews.
The workspace list marks folderless workspaces with ☁️ and folder-backed ones with 🗂️.
On a workspace page, matching workspace/folder labels share one 🗂️ breadcrumb;
folder, if any. Folder labels use the daemon's home abbreviation, not the browser's.
The workspace list and workspace pages offer native header actions alongside the breadcrumbs:
- On `/~/`: `🗃️` followed by `➕` opens a native `<dialog>` modal pre-populated with an automatic candidate name ({§web-workspace-creation}) to create a new folderless workspace.
- On `/<workspace>/`: `🗃️` › `☁️ <workspace>` followed by `✏️` and `➕` open native `<dialog>` modals to rename the current workspace or create an independent model worker pre-populated with an automatic candidate name ({§web-worker-creation}).
Modals offer Cancel and Confirm, dismiss on Escape or backdrop click without mutating state, and render in normal flow at the end of `<main>` when JavaScript is disabled; with JavaScript a closed modal shows nothing.
itself instead of re-executing, and anonymous daemons keep actions behind same-origin guards.
Worker share full-width article lists and a stationary header around scrolling
main content. Worker status and the Stop / multiline message / Send row stay at
the bottom. The message field and buttons grow together; Enter remains a newline,
and Ctrl+Enter sends through the same form as Send.
Page titles, breadcrumbs and empty/error documents support ordinary browser
navigation with or without JavaScript.
Header controls: 🗃️ workspace breadcrumb, ⚙️ Account, ✖ Sign out.
Breadcrumbs fit between the mascot and menu, or center below them when space is short.

Directories select their `index.html`: `/` and `/index.html` serve the same
document, as do the two spellings for any admitted nested index. Directory links
include the trailing slash. Missing documents and assets return 404, not the
home page. Navigation never creates workspaces or workers, claims control, or
starts inference. Folderless workspaces work the same way as project workspaces.

The [directory address contract](SPEC.md#web-directory-addresses-named-directory-addresses)
maps workspace names to `/~/<workspace>/` and workers to `/~/<workspace>@<worker>/`,
preserving slashes and encoding name punctuation. Names remain separate from
project folders; URLs do not publish workspace files.

## Sign-in

Web uses the daemon's shared `PLURNK_AUTH` and `PLURNK_PASS` configuration.
There is one local operator account and no username setting. With authentication
enabled, set a password; an empty password does not admit a browser,
including on localhost. The daemon owns the sign-in form and credential validation.
Set `PLURNK_AGUI_ISSUER` to the public origin when a proxy fronts the daemon.
`PLURNK_AUTH=0` explicitly makes directories anonymous too.

The daemon's native sign-in and setup/error pages use the same compiled Pico
stylesheet as web. Authentication remains daemon-owned; web supplies no login form.

The browser receives an HttpOnly session cookie; no access token, refresh token,
password or operator secret is embedded in a page or browser storage. **Sign out**
ends this browser's sign-in and its module credentials together. Revisiting requires
sign-in. **Account → Sessions** lists the authority's live sign-ins, marks this session,
and offers native forms to revoke one or all other sessions. No device or last-activity
information is invented. Other sessions and independently authorized clients remain
intact. A daemon restart invalidates sessions. Remotely, use HTTPS.

The same-origin `POST /auth/token` connection primitive supplies short-lived
AG-UI access credentials to a signed-in browser. OAuth refresh credentials stay
server-side; rotation and revocation use the daemon's authority.

Worker pages passively connect through the official HttpAgent. A compact footer
above the message field shows approval mode, lifecycle, model/effort, latest-loop
elapsed time, and cumulative worker-and-descendant tokens and cost. Unknown totals
stay `?`, not zero; known partial amounts retain `+ ?`. Field descriptions preserve
exact accounting behind the compact figures. A finished loop leaves the page watching
for the next one. Closing, refreshing or navigating away never cancels work.
Connection failure stops observation and marks the displayed values as stale;
use **Reconnect** or, after revocation, **Sign in**. Reconnect preserves the current
draft without resubmitting it; full page reloads do not persist drafts.
No automatic work retries occur.
Context occupancy/capacity, pending input, preparation, indexing and the daemon's WAIT
countdown appear only when relevant. The countdown is an observation deadline, not
a promise of completion. A collapsed worker-count disclosure opens the live
descendant tree; no empty tree or metadata inventory occupies the page.
Workspace names and folder labels
follow supplied state without changing the observed worker or rewriting the URL.
Daemon notices and nonterminal Problems appear separately under **Observed diagnostics**,
as literal messages and recovery guidance. Distinct observations remain through reconnects
on that page; they are not an archive or an indication that the worker has stopped.
**Observed activity** exposes non-conversation log rows and text emitted outside
operations, retaining source coordinates and supplied worker attribution as entry
semantics and accessible names. These observations survive reconnects on the same page, not
reloads; they are not replies or a complete activity history.
Operations show their glyph and aside above the addressed selection, returned count
and any failure. An immediate receipt completes that summary rather than adding
another article. Authored bodies appear below it; READ results are not fetched
automatically. Reasoning stays collapsed until opened. Fetched bodies are literal text and are never added
to client-uploaded conversation history or saved in browser storage.

**Observed stream outcomes** retains conclusions seen on this page, separately
from worker completion and conversation receipts. **Read output** explicitly
fetches a literal snapshot of all channels; click again to refresh it. Neither
inspection nor navigation cancels execution.

Live reasoning appears in one temporary plain-text preview, cleared when the
attempt ends or delivery disconnects. `PLURNK_WEB_REASONING_PREVIEW_CHARS` bounds
its retained tail (4096 Unicode code points by default). Completed turns keep
their reasoning in collapsed disclosures; opening one retrieves the full
trace when visible, without adding it to later Run uploads.

**Send** also supports follow-ups while the worker is running. The draft clears
only after the daemon acknowledges it; newer typing is preserved. A failed or
uncertain submission is never retried automatically. **Stop** preserves unsent
text; closing the page is not Stop. Browser approval defaults to manual review
(`PLURNK_WEB_YOLO=0`). `PLURNK_WEB_YOLO=1` accepts proposals automatically, subject to daemon
permissions, on a worker page the person opened themselves; one reached from another site
starts in manual review, as does every page on a plain-HTTP origin other than localhost (its
browser reports no navigation source). The worker page shows the active mode. In manual mode, each approval
names its requesting worker and shows the exact operation and review evidence.
Choose Accept or Reject for every presented operation, then **Submit responses**;
neither choice is preselected. Questions and MCP input always need a human answer.
Other authorized clients can settle the same request; every view withdraws the
answered controls and follows the work. Refresh rediscovers what remains pending.
An answer overtaken by another answer is reported as refused while observation
continues. Failed or uncertain decisions are reported, never automatically retried;
an actual connection failure requires **Reconnect**. Unimplemented interactions remain pending with
an explicit notice, never an automatic decision.

Questions show their request, full response schema, and requesting worker ID when
the daemon supplies it. Simple fields use native
controls; nested or conditional answers use an **Answer (JSON)** editor without
discarding schema rules. Optional fields have an inclusion checkbox. Answers are
validated before submission and by the daemon; local errors preserve your input.
**Cancel this request** cancels that question, not the worker's other work.
Refresh rediscovers pending questions but does not retain unsubmitted answers.

The daemon supplies the recent conversation window. **Load previous loop** reads
older history without adding it to model requests. Loaded pages remain for this
visit; any gap after reconnection has the same explicit loading control. Prepending
history preserves your reading position. New output follows the bottom only while
you are there. Reloading starts from the current daemon window.

Messages preserve daemon chronology; unknown history is not shown as empty.
Content and calls are direct semantic entries with accessible names and
presentation-relevant metadata, not nested protocol inspectors. Bodies use native
disclosures: user messages and delivered replies start open; notes, tool evidence
and completed reasoning start closed. Headers, diagnostics and operation details
remain visible. Opening a body does not start work or add READ receipt readback.
Markdown is sanitized, raw
HTML stays text and images become links. SEND bodies use that same Markdown renderer;
NOTE, reasoning and ordinary operation evidence remain literal preformatted text.
Long lines wrap and settled entries grow with their content; explicit code, tables,
formulas and diagrams scroll locally when wider than the viewport.
NOTE retains category and attribution semantics without an enclosing assistant
article, a duplicate arguments view or a body copy in attributes.
HttpAgent owns live messages; archival pages are read-only presentation. Neither
is saved in browser storage.

Markdown footnotes use native reference and back-links within each rich message or SEND.
Repeated references retain separate return links; definitions never leak between
messages. Code and unresolved references remain readable source.

Math uses locally bundled Temml and native MathML: `$…$`, `$$…$$`, `\(…\)` and
`\[…\]` outside code. Unsupported formulas keep their source and a short error;
raw HTML and TeX link/media extensions cannot create controls or fetch content.
The math renderer and its styles load only when needed.

Mermaid fences become static SVG images compiled by the web module's pinned
[Ondine](https://github.com/wevm/ondine) dependency, within its supported syntax.
The compiler runs in bounded Node worker threads; no compiler or WebAssembly is
sent to the browser. Compilation uses the existing browser session (or the daemon's
explicitly unauthenticated mode). `PLURNK_WEB_DIAGRAM_*` limits are documented in
`ai.plurnk/.env.defaults`.
The renderer loads only when needed. Source remains available in a disclosure;
unsupported or invalid diagrams keep their source and a short error. There are no
interactive diagrams, remote rendering services or external font requests.
Prose reflows on narrow screens; wide code, tables, formulas and diagrams scroll locally
without shrinking the text or widening the page. Native zoom remains available.

English is rendered in the document, not filled in by JavaScript. The current
page needs no duplicate English dictionary or browser storage, and has no language
picker or stored preferences. Ordinary navigation and forms
remain native HTML; live worker status and conversation require JavaScript.

## Install from source

Requires Node.js 26+ and Plurnk service 4.x with its module-client credential and
workspace-label APIs
([credential authority](https://github.com/plurnk/plurnk-service/blob/main/plurnk-core/SPEC.md),
including sign-in inventory, shared browser/module revocation, password-only login,
and registered authorization-page styles, plus daemon-supplied folder labels).
Use packed platform packages for development and installed-browser verification.
The web plugin itself is not yet published.

```sh
npm ci --no-audit --no-fund
npm run test:candidate -- /path/to/packed-platform-packages
npm pack
```

Install the resulting archive beside the service, in the same npm installation:

```sh
npm install --no-audit --no-fund /path/to/plurnk-plurnk-web-0.1.0.tgz
```

Restart that daemon and visit its root URL, normally `http://localhost:1066/`.
Native extension trust applies; the standard policy admits `@plurnk/*` packages.
The plugin inherits the daemon's host and port, and leaves more-specific routes
alone. It does not install or start a service.

Set `PLURNK_WEB_ENABLED=0` in the service environment and restart to disable the
module without uninstalling it. Module settings, browser approval mode and pending-sign-in limits are documented in
[ai.plurnk/.env.defaults](ai.plurnk/.env.defaults).

## Install as an app

Use the browser's **Install app**, **Add to Home Screen** or **Add to Dock** action,
where supported. The manifest supplies Plurnk's name, icons and standalone window.
Localhost works over HTTP; remote installation requires HTTPS, normally supplied
by your reverse proxy. Installation does not install or start the daemon.

The app requires its daemon to be reachable. It does not register a service worker,
cache workspace data, or provide offline operation. Browser and OS support varies.

## Development

Read [ARCHITECTURE.md](ARCHITECTURE.md) for ownership, configuration and verification
boundaries. Web follows the platform's engineering discipline through public contracts.

```sh
npm ci --no-audit --no-fund
npm run dev
```

Open the loopback URL Vite prints (normally `http://127.0.0.1:5173/`).
HTML edits reload the page; CSS edits update it in place. This serves the frontend
only and neither starts nor restarts the daemon. Directory and sign-in requests
need the daemon; Vite does not emulate its data or authentication.

`npm run build` compiles the frontend into `ai.plurnk/dist/`. The plugin serves
that build on the daemon's existing port; restart the daemon to load a new build.
`npm run preview` previews the last build locally without a daemon. It is not the
production server. Vite is development tooling only.

`npm test` checks specification tags and witnesses using Plurnk's shared
development checker, server and browser JavaScript, OTM's HTML/JavaScript/CSS
contracts and the module, then packs and installs the plugin
with packed platform packages and the terminal client in a temporary directory. These may be published
archives obtained with `npm pack` or locally built candidates. `test:candidate`
installs their public type declarations without rewriting the lockfile,
then runs the full gate with `PLURNK_WEB_TEST_PACKAGES` naming the archive directory.
The installed test uses an
isolated configuration, database and dynamically assigned port, plus Playwright
Chromium. Component coverage also exercises native conversation behavior in Firefox.
Install the test browsers with `npx playwright install chromium firefox` if necessary;
WebKit joins the matrix only when `PLURNK_WEB_TEST_WEBKIT=1` is set, because its
local automation host is recorded-flaky. The operator's daemon and configuration are not used.
The gate also runs the official HttpAgent in Chromium against that daemon and a
deterministic local model; no paid inference is involved. Separate journeys exercise
the shipped worker page and native input/review forms without injecting an SDK or mocking AG-UI.
Shared review journeys drive the installed terminal through a PTY alongside the
browser, covering both clients' manual/YOLO combinations and either manual responder.
The terminal emulator and PTY driver are test-only dependencies.
It exercises synchronization, observer/control handoff with one SDK history,
admitted work surviving request abortion, navigation and page close, explicit
cancellation, approval and question interruption and rediscovery,
shutdown and the real browser sign-in/access-token lifecycle. Held directory and OAuth
requests verify that module shutdown settles admitted work before releasing resources.
Cross-client prompt
delivery, exact READ operands and real command stdout/stderr results are compared live and after
refresh through the SDK's messages, without custom-row reconstruction. Standard success,
cancellation, failure and reported token usage are checked separately. No AG-UI traffic is
mocked and no client-owned replay cache hides differences from the daemon's history.
Stream journeys also exercise silent executors, never-written channels, explicit
authenticated output inspection, completion during absence, cancellation and nonzero exit.
Browser journeys also check console warnings/errors and uncaught exceptions;
deliberately tested failures require explicit diagnostic expectations.
Adversarial content checks exercise rich-text roles, NOTE bodies, literal tool data,
streaming and replay against the production content policy in all three engines.

`web/index.html` and `web/app.js` are the document and browser entry point.
Vite bundles OTM from its npm entry and compiles the CSS. Build preparation copies
Pico's readable pinned substrate and dependency licenses, and derives a maskable SVG
from the mascot. HttpAgent loads only on worker pages; Vite includes the bundled
dependencies' license notices. Production prunes unused CSS rules, variables and keyframes from
the browser and server-rendered document sources, plus the authority's publicly
exported document specimens, before minification. The AG-UI package supplies those
specimens as a development dependency only; no daemon code enters the browser bundle.
Browser type checking uses the public runtime-neutral client entry without Node
globals. The module's server-side port types use their separate public entry;
type declarations are erased, not bundled.
The generated asset inventory tells the plugin which production files to serve.
Static assets negotiate build-time Brotli/gzip representations when smaller, with
identity delivery available. Private documents and AG-UI streams are not compressed
by the plugin; no request-time compression or additional browser dependency is added.
Build output is packed but not committed. [SPEC.md](SPEC.md) defines the contract.

The `web/styles/index.css` import entry composes the four source layers in order
before production pruning, so references between layers remain visible:

| File | Concern |
|---|---|
| `app-vendor.css` | Generated, unmodified Pico substrate. |
| `app-structure.css` | Reading width, viewport grid, composer sizing, gutters and wrapping. |
| `app-style.css` | Substrate token overrides; brand accents, system monospace and conversation surface colors. |
| `app-state.css` | Directory/worker width, semantic background selection, glyphs, connection state and native focus visibility. |

Authored CSS is checked with OTM's Stylelint rules. Content-renderer dependencies
load their own vendor styles separately; sign-in uses only the page stylesheet.
No remote fonts are required.

Code: MIT. The hamster artwork derives from Google's Noto Emoji under Apache-2.0,
with glasses and a green bow added. See [artwork attribution](web/public/icons/NOTO-NOTICE.txt).
