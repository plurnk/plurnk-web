# Web module

## §web-host Hosting

An optional Agent Plugin declares one native Plurnk module. It uses the public
module lifecycle and HTTP registration seam, never a separate listener or process.
The daemon owns routing precedence, startup readiness and shutdown.

| Configuration | Behavior |
|---|---|
| PLURNK_WEB_ENABLED=1 | Claim and register `/` on the daemon's existing listener. |
| PLURNK_WEB_ENABLED=0 | Inert module: no route claims or registration. |
| Invalid value | Existing configuration diagnostic; no web module activation. |
| Package absent | No web routes. |

The package's .env.defaults owns the default. Installation is opt-in; the service
does not depend on this package. More-specific mounts retain their ownership.

## §web-assets Static resources

| Request | Response |
|---|---|
| GET `/` | Home document rendered from the packaged HTML; authenticated header controls follow {§web-page-shell}. |
| GET `/index.html` | Same root document. |
| GET `/assets/<build-generated-name>` | Compiled browser JavaScript and CSS. |
| GET `/manifest.webmanifest` | Web app manifest (`application/manifest+json`). |
| GET `/icons/plurnk.svg` | Scalable app icon. |
| GET `/icons/plurnk-maskable.svg` | Maskable app icon. |
| GET `/icons/NOTO-NOTICE.txt`, `/icons/APACHE-2.0.txt` | Artwork attribution and license. |
| GET `/vendor/OTM-LICENSE.txt`, `/vendor/PICO-LICENSE.txt` | Packaged dependency licenses. |
| HEAD on any served path | Same status and headers as GET, without a body. |
| Other asset path | 404 error document, never a home-page fallback or filesystem listing. |
| Asset method other than GET/HEAD | 405 with `Allow: GET, HEAD`. |

Query strings do not select assets. Paths select the build-generated asset inventory, never
filesystem paths derived from the request. Only packaged public assets are served;
configuration, source, credentials and workspace files are not public resources.
Assets are loaded during module startup: missing package bytes fail startup rather
than leaving a partially functioning page. Responses declare their media type,
byte length and `X-Content-Type-Options: nosniff`.

## §web-index-documents Directory documents

| Request | Resolution |
|---|---|
| `/folder/` | The admitted `/folder/index.html` resource. |
| `/folder/index.html` | That same resource, with the same relative-link base. |
| `/` and `/index.html` | The root index document. |
| `/folder` | No implicit directory alias; links to directories include the final slash. |
| Missing index or child asset | 404, not an ancestor's index or the root document. |

Resolution uses the exact resource inventory, not a filesystem search or path
normalization. Query strings do not change the selected bytes. Production GET and
HEAD have the same status and headers; HEAD has no body. No redirect or history rewrite is
needed for the two index spellings. Native links, relative children, refresh and
back/forward work with JavaScript enabled or disabled. OTM does not intercept
document navigation; the server remains responsible for the document.

Production, Vite development and compiled preview share the same index-path
projection, applied before resource serving. Vite still owns HTML transformation,
compilation and HMR; no browser router is registered. Its development-only modules and
source serving are not production resources. Currently only the root document
is shipped by Vite. The daemon additionally renders the protected directories
below; worker assets remain unserved.

## §web-directory-addresses Named directory addresses

The directory codec maps names to origin-relative paths, not database IDs or
filesystem locations. It does not serve documents or authorize access.

| Directory | Generated path | Explicit document |
|---|---|---|
| Current unnamed daemon | `/~/` | `/~/index.html` |
| Workspace `~/ptl/project` | `/~/~/ptl/project/` | `/~/~/ptl/project/index.html` |
| Its worker `reviewer` | `/~/~/ptl/project@reviewer/` | `/~/~/ptl/project@reviewer/index.html` |
| Workspace `a@b`, worker `user` | `/~/a%40b@user/` | `/~/a%40b@user/index.html` |
| Workspace `index.html` | `/~/index.html/` | `/~/index.html/index.html` |

Workspace names are opaque, case-sensitive text. Encode each slash-separated
component with `encodeURIComponent`, preserving every slash, including leading,
repeated and trailing slashes. Encode the worker as one component. Raw `@` is the
worker delimiter: split it and the document suffix before decoding each name
exactly once. Literal `%2F` therefore becomes `%252F`, not a slash. Do not trim,
normalize Unicode, resolve names as paths, or interpret `~` as a home directory.

The parser accepts the folder and explicit-index spellings, percent-encoding
case variants and encoded equivalents of name characters (including `/`). `%7E`
is equivalent to the fixed `~` namespace marker. Query and fragment components
do not select a directory. Slashless directory aliases, malformed UTF-8/percent
escapes, empty names, multiple raw worker delimiters, worker child resources and
named-daemon prefixes are not directory matches. Parsing performs no lookups.

The daemon's [workspace name contract](https://github.com/plurnk/plurnk-service/blob/main/plurnk-core/SPEC.md)
admits nonempty well-formed Unicode without literal slash-delimited `.` or `..`
segments. The codec returns no path for an unrepresentable legacy name rather
than repairing it or substituting an ID; decoding an address to such a name is
also refused. Renaming changes its generated URL, not its identity or project
folder. No old-name redirect or filesystem exposure is implied.

This codec is verified using isolated native-document fixtures in production,
Vite development and preview. Live directory publication uses the daemon's
authentication contract.

## §web-session Browser sign-in

Web consumes the daemon's credential authority, never the operator's secret or
a second credential configuration. At setup it registers the confidential
client `plurnk-web` with callback path `/auth/callback` and scope `agui`. It asks
the published issuing face for the issuer of each request: the daemon's configured
public origin, else the address that request reached the daemon at. Its own calls to
the authority (discovery, code exchange, refresh) go to the face's answer for no
request, never to an address a browser named. No issuing face means the daemon has
explicitly disabled authentication; directory reads are then anonymous.

| Boundary | Contract |
|---|---|
| Authentication enabled, empty password | The authority shows configuration-required information and issues no browser sign-in, including on localhost. Web neither infers anonymous access nor adds a local bypass. |
| Authentication enabled, configured password | A browser signs in with `PLURNK_PASS` alone. No username field or web-owned identity configuration; a wrong password is refused by the authority at 401. |
| Authentication explicitly disabled | Anonymous directories; no Account or Sign Out controls. |
| GET `/auth/login?return=<page>` | Begin authorization code with PKCE S256 and a fresh state, bound to an HttpOnly browser cookie. Return locations are local directory addresses, `/account/` or `/account/sessions/` (also their explicit indexes); never an external URL. |
| GET `/auth/callback` | Consume the pending browser-bound state once; validate and exchange the code with client authentication. Issue a new authority `session` credential for the same subject, client, scopes and grant family, expiring with that grant's refresh credential. |
| Directory admission | Require a live authority-issued session for `plurnk-web` carrying `agui`; a bearer, refresh token, another client's cookie, or a revoked/expired session is not a web session. |
| POST `/auth/logout` | Require the issuer's exact Origin, revoke this browser's sign-in family and clear the web cookie. The authority sign-in and its module credentials end together; revisiting requires sign-in. Other browser sessions and independently authorized clients remain intact. |
| Concurrent callbacks | A new credential in the same sign-in family does not revoke that family. A genuinely different previous family is revoked. |
| Cookies | Host-only, HttpOnly, SameSite=Lax; Secure under HTTPS. Session path `/`, transaction path `/auth`. No browser storage or token in document content. |
| Request origin | A browser is answered at the address it reached the daemon by: its sign-in redirect, callback and Origin checks use the daemon's issuer for that request. No host is refused or redirected; forwarded headers are never read. |
| Failures | Invalid/replayed/mismatched callbacks fail without session issuance. Expiry/revocation requires sign-in again. Requests reveal no credential in diagnostics. |

Pending authorization state lives only in bounded, expiring module memory:
`PLURNK_WEB_LOGIN_TTL_SEC` and `PLURNK_WEB_LOGIN_PENDING` own its limits. Closing
the module clears it. Cookie and grant lifetimes come from the authority, not a
second lifetime setting. Sign-in uses the dependency-free MIT `oauth4webapi`
client and RFC 8414 discovery after listener admission; passwords are entered
only at the daemon's authorization endpoint.
Worker interaction remains unimplemented. Browser access credentials use
{§web-access-token}; they are never embedded in documents.

References: [OAuth browser applications](https://www.rfc-editor.org/rfc/rfc10017.html#section-6.2),
[OAuth security best practice](https://www.rfc-editor.org/rfc/rfc9700.html).

## §web-access-token Browser access credentials

The module is an OAuth token-mediating backend, not a second issuer. It retains
the authorization-code grant's access and refresh credentials in daemon memory,
keyed by the authority's sign-in family. The authority still owns admission,
identity, expiry, revocation and the account inventory.

| Boundary | Contract |
|---|---|
| POST `/auth/token` | Require a live web session and the issuer's exact Origin. Return only `access_token`, `token_type: Bearer`, and remaining `expires_in` seconds as no-store JSON. Other methods are 405; disabled authentication leaves the endpoint absent (404). No cross-origin access or credential-bearing redirect. |
| Access expiry | Reuse a still-valid access credential; otherwise perform the standard OAuth refresh grant with confidential-client authentication. Concurrent requests in the same family share one refresh, so rotation does not race across tabs. |
| Grant integrity | Access and refresh credentials must belong to the registered client, subject, scope and family. A refresh cannot change the family or resurrect a revoked sign-in. Failed refreshes are surfaced; no operation is replayed or authority substituted. |
| Revocation and cleanup | Authority revocation releases the retained grant. Expired grants are pruned on subsequent credential activity; module close releases them and its revocation subscription. Session expiry remains fixed by sign-in, not extended by refresh. |
| Browser custody | Access credentials are for the same-origin `/agui` endpoints and live only in JavaScript memory. Refresh credentials and client authentication never leave the server; no local/session storage, URL, document or diagnostic contains them. |
| Refusals | Missing/expired/revoked sign-in is 401; wrong/missing Origin is 403. Expected endpoint failures use RFC 9457 JSON, not an HTML sign-in redirect. |

This supplies a verified connection primitive only. It installs no conversation
UI, automatic retry loop, persistent browser state or additional session registry.

## §web-authorization-style Authorization document presentation

| Boundary | Contract |
|---|---|
| Registration | At setup the module registers the single compiled CSS resource from its asset inventory as its client's `stylesheetPath`. It does not add an alias route, second stylesheet or theme setting. Missing or multiple application stylesheets are build-contract faults. |
| Document ownership | The authority owns sign-in, setup/error, consent and session documents, credential validation and security policy. Web supplies neither a form nor an HTML rewrite. The authority selects the stylesheet from the trusted client registration, never arbitrary request input. |
| Presentation | The same Pico Classless Green, monospace, 65ch measure, light/dark colors, native controls and article cards apply to authorization and web documents. Ordinary authorization pages work without JavaScript. |
| Production pruning | The public `authorizationDocumentSpecimens()` export from `@plurnk/plurnk-agui` supplies the authority's markup to PurgeCSS. No copied templates or private daemon-source scan. This is a development dependency, not a browser/runtime import. |

The daemon's standalone documents remain its own responsibility when no registered
module stylesheet applies. Browser coverage exercises the installed module and
authority together, including empty/wrong passwords and signed-out re-entry.

## §web-account Account and sign-ins

| Surface | Contract |
|---|---|
| GET/HEAD `/account/` or `/account/index.html` | Protected Pico article containing native navigation to Sessions. No displayed internal subject, fictional profile or inline session inventory. |
| GET/HEAD `/account/sessions/` or `/account/sessions/index.html` | Protected Pico article with Account breadcrumb and a native table of the authenticated subject's live sign-ins from `credentials.sessions(subject)`. No independent inventory. Table overflow stays inside its figure on narrow screens. |
| Each sign-in | Authority-issued creation/expiry times and client names; mark the family of the presented web session as “This session”. Do not invent device identity or last activity. Family handles are not credentials. |
| POST `/account/sessions/<family>/revoke` | Require a live web session and the issuer's exact Origin; revoke only a family in that subject's live inventory. A missing or foreign handle is 404. Revoking this session also clears the web cookie and returns home; otherwise redirect to Sessions. |
| POST `/account/sessions/revoke-others` | Same admission and Origin check; revoke all listed families except this session, then redirect to Sessions. |
| Expired/revoked credentials | Protected GET requires sign-in again; a submitted action fails at 401 rather than silently authenticating and replaying it. |
| Explicit anonymous posture | Account documents and actions are absent (404); no fictional account. |

Forms work with JavaScript enabled or disabled. Read and mutation responses use
the private headers in {§web-directory-documents}; GET never revokes anything.
Revocation does not mutate workers, workspace ownership or independently authorized
client credentials. The daemon owns credential lifetime, grouping and revocation.

## §web-directory-documents Read-only directory documents

| Document | Content / lookup |
|---|---|
| `/` | Public foundation document and a real link to `/~/`. |
| `/~/` | `listWorkspaces()`: an HTML `ul/li/a` list of exact names. Prefix each name with ☁️ when `project_root` is null, otherwise 📁; accessible image labels identify folderless/project workspaces. Never infer folder presence from the name. |
| Workspace directory | Exact-name lookup in `listWorkspaces()`, then `listWorkers(id)`: real worker links and identity breadcrumbs. |
| Worker directory | Exact-name worker lookup; identity heading and breadcrumbs only. No conversation UI yet. |
| Missing workspace/worker | 404; never create, attach, claim ownership, start a loop or infer a project folder. |
| Unrepresentable legacy name | Escaped text without a link; no renamed display, ID substitution or broken generated URL. |

Every directory (including a missing one) is authenticated before data lookup.
GET and HEAD have matching status/headers; HEAD has no body. Documents and auth
responses are `Cache-Control: no-store`, suppress referrers, prevent framing and
use same-origin scripts, styles and forms. Names are escaped as text/attribute
values; never executable HTML or filesystem paths. Ordinary navigation and
logout use native links/forms with JavaScript enabled or disabled. Rendering
reuses the compiled root document's head, styles, icons and OTM boot; no browser
router, client-side list fetch, duplicate English dictionary or extra UI library.

Vite development/preview continue to serve frontend documents only: dynamic
directory/auth routes require a daemon. The installation gate accepts explicitly
supplied candidate package archives to verify the unreleased public contract;
it must not substitute a published service missing that contract.

## §web-page-shell Native page shell

| Surface | Contract |
|---|---|
| Shared navigation | Home/brand and Workspaces are real links preceding the single `main` landmark; no skip-navigation control. Authenticated documents add Account and a compact secondary Sign Out POST form in the header; no footer logout. Anonymous documents omit account/session controls. Native links and controls retain visible keyboard focus. |
| Document title | Home: `Plurnk`. Directory/error: its identity or HTTP status followed by ` — Plurnk`. One visible `h1`. |
| Directory breadcrumbs | Home → Workspaces → whole workspace name → worker; only applicable ancestors appear. The current item is text marked `aria-current="page"`. Slashes in names do not invent intermediate directories. |
| Empty lists | “No workspaces.” or “No workers.”; no empty list masquerading as content. |
| Page width | Non-worker documents are centered and bounded by 65ch or the viewport, whichever is narrower. Worker documents and their navigation use the available viewport width. Gutters and wrapping preserve narrow-screen usability and complete names. |
| Expected HTTP failures | A Pico `article` card within the same HTML shell: heading, decorative warning emoji, escaped explanation and native Home link. Preserve status/Allow/HEAD semantics and private headers from {§web-directory-documents}. Do not echo URLs, credentials or internal exceptions. Unknown internal failures still propagate to the host. |

The compiled root document owns shared navigation and assets, including an inert
template for authenticated navigation. OTM's documented indirect-template marker
identifies its server-owned instantiation. Server rendering selects that template
and replaces the title and main content. Ordinary navigation, focus, lists and forms work without JavaScript;
there is no browser-owned route or session inventory.

## §web-document Document

The home document introduces workspace navigation in semantic HTML and initializes OTM from locally
packaged ES modules. Locally packaged Pico Classless Green styles semantic elements
without application classes. Brand green is `#148800`; dark-mode link colors remain
bright enough for contrast. Native color-scheme selection is preserved; typography
uses Pico's system monospace stack. Content and styling
work without JavaScript.
There is no theme switcher, client routing, persistent browser storage, external
asset request or agent interface. The root links to the directory index. Protected
directory documents supply daemon identities as escaped HTML, never credentials.

Source stylesheets load in this order, with one concern per file. Production
compilation may combine them without changing their cascade:

| File | Responsibility |
|---|---|
| `app-vendor.css` | Unmodified pinned Pico Classless Green, copied during build. |
| `app-structure.css` | Readable page width, gutters and wrapping. |
| `app-style.css` | Presentation through substrate tokens; brand accents and system monospace. |
| `app-state.css` | Worker page width and native focus visibility. |

## §web-language Source language

The shipped document is English, declared by `html[lang]`. Its readable source
text remains in HTML; `data-i18n` keys identify text rather than appearing in its
place. OTM boot explicitly uses the document language and opts into no persistent
state. Browser language, query parameters and unrelated stored preferences do not
select an unshipped translation. No translation endpoint or duplicate source
dictionary is declared or packaged. Boot neither fetches a dictionary nor
rewrites the document into English, and completes without accessing browser
storage even when storage is denied. No language picker or additional locale is shipped.

## §web-authoring Browser boundaries

| Concern | Owner |
|---|---|
| Document structure and ordinary navigation | Semantic HTML, real links, lists and native forms; not a JavaScript-created application shell. |
| Interactive worker | JavaScript-dependent product surface, not a parallel no-JS implementation. No worker interface is implemented yet. |
| Browser mechanisms | OTM public APIs and native controls; reusable gaps are repaired upstream rather than through local shims. |
| Visual state | Native element state or semantic attributes projected through CSS; no imperative style mutation. |
| Static checks | OTM HTML, JavaScript and CSS rules, unsafe-HTML sink checks, and separate browser/server JavaScript type checks. |

## §web-contract-checks Specification gate

The web lint gate uses the shared `@plurnk/plurnk-spec-check` development tool.
Named declarations are unique, citations resolve, and each contract has a
non-prose witness. No unwitnessed-contract allowance is used. The gate works from
a standalone checkout with installed dependencies, without a neighboring service
checkout. This checks traceability, not whether a cited test proves its contract.

## §web-build Development and production

| Command | Contract |
|---|---|
| `npm run dev` | Prepare static assets, then serve `web/` through Vite on loopback with HTML reload and CSS hot updates. No daemon or model is started. |
| `npm run build` | Prepare assets, clean and compile into `ai.plurnk/dist/`, then generate `ai.plurnk/assets.json` from the complete output. |
| `npm run preview` | Locally preview the last build through Vite; not a production server. |
| Daemon startup | Load the inventory and every listed production asset; serve them through the plugin's existing mount. No Vite runtime or development server. |

`web/index.html` owns the document, `web/app.js` imports OTM's npm entry,
and `web/public/` supplies unchanged public assets. The four CSS source
concerns remain under `web/styles/`. Generated output is packed, not committed.
Production contains no development-client injection, frontend sources, or source maps.
Current stable browsers are the supported platform. Compile native modern syntax;
do not add legacy browser transforms or a module-preload polyfill.
Development serves readable, complete Pico Classless Green. A CSS import entry
composes all four layers before production pruning. PostCSS/PurgeCSS scans the
browser source and server document renderer, preserves browser pseudo-states and
ARIA/role/data-driven states, and removes unused rules, variables and keyframes.
Vite then minifies the result. Browser coverage verifies the compiled presentation,
including error cards, native controls, light/dark mode and narrow viewports.
The current development page has no backend interaction; no API proxy is installed.

## §web-installation App identity and installation

| Surface | Contract |
|---|---|
| Manifest | Stable origin-relative `id`, `start_url` and `scope` of `/`; Plurnk name, English description, `standalone` display, no orientation lock. |
| Identity | Brand green `#148800`; Google Noto hamster SVG with glasses and a green bow, retaining Apache-2.0 licensing and modification attribution. |
| Icons | One SVG for the document, favicon and manifest; no raster fallback. A generated opaque, full-bleed maskable SVG places artwork inside the safe circle (40% of image width). Both manifest entries declare `sizes: any`. |
| Document metadata | UTF-8, language, zoomable viewport, description, application name, early `color-scheme: light dark` and brand theme color. The standard manifest owns standalone launch; no legacy platform-specific launch metadata. |
| Privacy | Discourage indexing with `noindex, nofollow`; limit referrers to the same origin. No external fonts, analytics or deployment-specific canonical URL. |
| Installation | Browser-owned installation and standalone launch. HTTPS is required remotely; localhost/loopback is eligible without TLS. Browser and OS support varies. |
| Availability | Requires the daemon. No service worker, offline cache, background sync, notifications or claim of offline functionality. |

Installation metadata does not create a second server or change ownership of
`/agui` or other daemon mounts. No in-page install prompt or application UI is added.

References: [installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[manifest icons](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons).

## §web-package Package boundary

The npm archive includes the Agent Plugin manifest, native module, defaults,
document and its complete browser dependency graph, including OTM, Pico and artwork licenses.
Tests and build tooling are not runtime inputs. Verification installs the archive
beside candidate service archives in an isolated environment and exercises actual module
discovery, routing and browser execution.

Upstream contracts: [module lifecycle and mounts](https://github.com/plurnk/plurnk-service/blob/main/plurnk-modules/SPEC.md),
[Agent Plugins](https://agent-plugins.org/), and OTM's installed README.

## §web-agui-conformance Browser protocol verification

The packed-installation gate runs the official HttpAgent in Chromium from the
module's real document origin, against an isolated authenticated daemon and a
deterministic local model. Only the test SDK asset is injected; AG-UI traffic is
not intercepted or synthesized. No operator configuration or paid model is used.
Test fixtures and the SDK test bundle are not shipped browser assets.

| Boundary under verification | Required observation |
|---|---|
| Standard Run | Bearer rejection, discovery, reasoning, correlated native tool/results, Plurnk receipts, state, assistant replies and provider failures survive the official SDK. |
| Synchronization | Authoritative messages/state without inference or borrowed history from another workspace. Retained reasoning and operation/result evidence must not disappear on a fresh connection. |
| Observation | `/agui/connect` remains open while idle and can detach/reconnect without cancelling another connection's work. The test adapter uses HttpAgent's public connection hook and sends no retained messages back as new input. |
| Control | Disconnecting the controlling request cancels its work; an observer receives the cancellation. |
| Approval | Native interrupts resume through the SDK; a different owner or consumed interrupt cannot resolve the gate. Test-only handlers do not advertise capabilities in the shipped page. |
| Shutdown | The daemon delivers a terminal error and stops despite an idle connection. |
| Credentials | Real password/PKCE sign-in, browser access, expiry, concurrent refresh and revocation compose with the SDK. Revocation terminates admitted connections without cancelling their workers. |

This establishes protocol prerequisites, not a conversation UI. There is no
client-owned replay cache, second event parser or automatic retry of work.
