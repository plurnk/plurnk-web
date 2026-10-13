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
| GET `/` | Packaged HTML document. |
| GET `/app.js`, `/vendor/otm.js` | Packaged browser ES modules. |
| GET `/styles/app-vendor.css`, `/styles/app-structure.css`, `/styles/app-style.css`, `/styles/app-state.css` | Packaged stylesheets. |
| GET `/locales/en.json` | Packaged translation. |
| GET `/vendor/OTM-LICENSE.txt`, `/vendor/PICO-LICENSE.txt` | Packaged dependency licenses. |
| HEAD on any served path | Same status and headers as GET, without a body. |
| Other path | 404, never an HTML fallback or directory listing. |
| Method other than GET/HEAD | 405 with `Allow: GET, HEAD`. |

Query strings do not select assets. Paths select an explicit resource map, never
filesystem paths derived from the request. Only packaged public assets are served;
configuration, source, credentials and workspace files are not public resources.
Assets are loaded during module startup: missing package bytes fail startup rather
than leaving a partially functioning page. Responses declare their media type,
byte length and `X-Content-Type-Options: nosniff`.

## §web-document Document

The document says Hello world in semantic HTML and initializes OTM from locally
packaged ES modules. Locally packaged Pico Classless Green styles semantic elements
without application classes. Its green palette and native color-scheme selection
are preserved; typography uses Pico's system monospace stack. Content and styling
work without JavaScript.
There is no theme switcher, client routing, persistent browser state, external
asset request or agent interface. No browser credential or daemon state is embedded
in the document.

Stylesheets load in this order, with one concern per file:

| File | Responsibility |
|---|---|
| `app-vendor.css` | Unmodified pinned Pico Classless Green, copied during build. |
| `app-structure.css` | Application layout; currently no overrides of Pico's layout. |
| `app-style.css` | Presentation through substrate tokens; system monospace only. |
| `app-state.css` | Attribute-driven application state; currently no rules. |

The empty concerns remain explicit files, not reasons to add layout or state.

## §web-package Package boundary

The npm archive includes the Agent Plugin manifest, native module, defaults,
document and its complete browser dependency graph, including OTM and Pico licenses.
Tests and build tooling are not runtime inputs. Verification installs the archive
beside a published service in an isolated environment and exercises actual module
discovery, routing and browser execution.

Upstream contracts: [module lifecycle and mounts](https://github.com/plurnk/plurnk-service/blob/main/plurnk-modules/SPEC.md),
[Agent Plugins](https://agent-plugins.org/), and OTM's installed README.
